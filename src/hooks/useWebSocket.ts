import { useEffect, useLayoutEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { connect, disconnect, subscribeGuilds, sendPresenceStatus, updateToken } from '@/services/wsService'
import { useAuthStore } from '@/stores/authStore'
import { userApi } from '@/api/client'
import { usePresenceStore, type UserStatus } from '@/stores/presenceStore'
import { useFolderStore } from '@/stores/folderStore'

const VALID_STATUSES = new Set<string>(['online', 'idle', 'dnd', 'offline'])

export function useWebSocket() {
  const token = useAuthStore((s) => s.token)
  const queryClient = useQueryClient()
  const setOwnStatus = usePresenceStore((s) => s.setOwnStatus)

  // Fetch all user guilds so we can subscribe to guild-level WS events.
  // Uses the same queryKey as ServerSidebar — no extra network request.
  const { data: guilds } = useQuery({
    queryKey: ['guilds'],
    queryFn: () => userApi.userMeGuildsGet().then((r) => r.data ?? []),
    enabled: !!token,
  })

  // Keep a stable ref to guilds so the token effect can read the latest value
  // without needing guilds in its dependency array (avoids reconnect on guild change).
  // useLayoutEffect (synchronous post-render) ensures the ref is up-to-date before
  // any async callbacks (setTimeout) in the token effect can read it.
  const guildsRef = useRef(guilds)
  useLayoutEffect(() => {
    guildsRef.current = guilds
  })

  // ── Silent-refresh detection ───────────────────────────────────────────────
  // When the 401 interceptor silently renews the access token, the `token` ref
  // changes from one non-null value to another.  We detect this in a
  // useLayoutEffect (which runs synchronously BEFORE the useEffect cleanup) so
  // the connect/disconnect effect can skip the full teardown and only update the
  // module-level reconnect token via updateToken().
  const prevTokenRef = useRef<string | null>(null)
  const isTokenRefreshRef = useRef(false)
  useLayoutEffect(() => {
    const prevToken = prevTokenRef.current
    // true only for a non-null → different non-null transition (silent refresh)
    isTokenRefreshRef.current =
      prevToken !== null && token !== null && prevToken !== token
    prevTokenRef.current = token
  }, [token])

  // Connect / disconnect on token change
  useEffect(() => {
    if (!token) {
      // Ensure the socket is closed if it was kept open by a refresh bypass.
      if (prevTokenRef.current !== null || isTokenRefreshRef.current) {
        disconnect()
      }
      return
    }

    // Silent token refresh: the 401 interceptor already renewed the token.
    // Just update the reconnect token in wsService — no teardown/reconnect needed.
    if (isTokenRefreshRef.current) {
      updateToken(token)
      return
    }

    // Defer one tick so React StrictMode's double-invoke can cancel the timer
    // before a socket is ever opened, avoiding the "closed before established" warning.
    const timer = setTimeout(() => {
      connect(token)

      // Pre-populate activeGuildSubs so that wsService.resubscribe() (called
      // after the hello/Op-1 handshake) will immediately re-send guild subscriptions.
      // If guilds aren't loaded yet the guilds effect below will call subscribeGuilds
      // once they arrive; subscribeGuilds is safe to call before the socket is open.
      const currentGuilds = guildsRef.current
      if (currentGuilds && currentGuilds.length > 0) {
        subscribeGuilds(currentGuilds.map((g) => String(g.id)))
      }
    }, 0)

    return () => {
      clearTimeout(timer)
      // isTokenRefreshRef is set by useLayoutEffect BEFORE this cleanup runs,
      // so it already reflects the NEXT render's intent.
      // Skip disconnect for silent refresh — the socket should stay up.
      if (!isTokenRefreshRef.current) {
        disconnect()
      }
    }
  }, [token])

  // Subscribe to guild-level events whenever the guild list loads or changes
  // (e.g. after joining or leaving a server). This mirrors the legacy project's
  // sendInitialGuildSubscription() that ran right after the Op-1 hello.
  // subscribeGuilds() is idempotent (uses a Set) and socket-safe (no-ops when closed).
  useEffect(() => {
    if (guilds && guilds.length > 0) {
      subscribeGuilds(guilds.map((g) => String(g.id)))
    }
  }, [guilds])

  // ── React to guild-related WS events ──────────────────────────────────────

  useEffect(() => {
    function onChannelEvent(e: Event) {
      const detail = (e as CustomEvent<{ guild_id?: string | number; channel?: { guild_id?: string | number } } | undefined>).detail
      const guildId = detail?.guild_id !== undefined
        ? String(detail.guild_id)
        : detail?.channel?.guild_id !== undefined
          ? String(detail.channel.guild_id)
          : undefined
      if (guildId) {
        void queryClient.invalidateQueries({ queryKey: ['channels', guildId] })
      } else {
        void queryClient.invalidateQueries({ queryKey: ['channels'] })
      }
    }

    window.addEventListener('ws:channel_create', onChannelEvent)
    window.addEventListener('ws:channel_update', onChannelEvent)
    window.addEventListener('ws:channel_delete', onChannelEvent)
    window.addEventListener('ws:channel_order', onChannelEvent)

    return () => {
      window.removeEventListener('ws:channel_create', onChannelEvent)
      window.removeEventListener('ws:channel_update', onChannelEvent)
      window.removeEventListener('ws:channel_delete', onChannelEvent)
      window.removeEventListener('ws:channel_order', onChannelEvent)
    }
  }, [queryClient])

  // ── React to guild membership WS events ────────────────────────────────────

  useEffect(() => {
    function onGuildCreate() {
      void queryClient.invalidateQueries({ queryKey: ['guilds'] })
    }
    function onGuildUpdate() {
      void queryClient.invalidateQueries({ queryKey: ['guilds'] })
    }
    function onGuildDelete() {
      void queryClient.invalidateQueries({ queryKey: ['guilds'] })
    }

    window.addEventListener('ws:guild_create', onGuildCreate)
    window.addEventListener('ws:guild_update', onGuildUpdate)
    window.addEventListener('ws:guild_delete', onGuildDelete)

    return () => {
      window.removeEventListener('ws:guild_create', onGuildCreate)
      window.removeEventListener('ws:guild_update', onGuildUpdate)
      window.removeEventListener('ws:guild_delete', onGuildDelete)
    }
  }, [queryClient])

  // ── React to guild member WS events ────────────────────────────────────────

  useEffect(() => {
    function onMemberEvent(e: Event) {
      const detail = (e as CustomEvent<{ guild_id?: string | number } | undefined>).detail
      const guildId = detail?.guild_id !== undefined ? String(detail.guild_id) : undefined
      if (guildId) {
        void queryClient.invalidateQueries({ queryKey: ['members', guildId] })
      } else {
        // Fallback: invalidate all member queries if guild_id not present
        void queryClient.invalidateQueries({ queryKey: ['members'] })
      }
    }

    window.addEventListener('ws:member_added', onMemberEvent)
    window.addEventListener('ws:member_updated', onMemberEvent)
    window.addEventListener('ws:member_removed', onMemberEvent)
    // t=203/204: role assigned to / removed from a member — refresh member list
    // so channel visibility filtering picks up the new role set immediately.
    window.addEventListener('ws:member_role_added', onMemberEvent)
    window.addEventListener('ws:member_role_removed', onMemberEvent)

    return () => {
      window.removeEventListener('ws:member_added', onMemberEvent)
      window.removeEventListener('ws:member_updated', onMemberEvent)
      window.removeEventListener('ws:member_removed', onMemberEvent)
      window.removeEventListener('ws:member_role_added', onMemberEvent)
      window.removeEventListener('ws:member_role_removed', onMemberEvent)
    }
  }, [queryClient])

  // ── React to guild role WS events ──────────────────────────────────────────

  useEffect(() => {
    function onRoleEvent(e: Event) {
      const detail = (e as CustomEvent<{ guild_id?: string | number } | undefined>).detail
      const guildId = detail?.guild_id !== undefined ? String(detail.guild_id) : undefined
      if (guildId) {
        void queryClient.invalidateQueries({ queryKey: ['roles', guildId] })
      } else {
        void queryClient.invalidateQueries({ queryKey: ['roles'] })
      }
    }

    window.addEventListener('ws:role_create', onRoleEvent)
    window.addEventListener('ws:role_update', onRoleEvent)
    window.addEventListener('ws:role_delete', onRoleEvent)

    return () => {
      window.removeEventListener('ws:role_create', onRoleEvent)
      window.removeEventListener('ws:role_update', onRoleEvent)
      window.removeEventListener('ws:role_delete', onRoleEvent)
    }
  }, [queryClient])

  // ── React to friend / DM WS events ────────────────────────────────────────

  useEffect(() => {
    function onFriendRequest() {
      void queryClient.invalidateQueries({ queryKey: ['friend-requests'] })
    }
    function onFriendAdded() {
      void queryClient.invalidateQueries({ queryKey: ['friends'] })
      void queryClient.invalidateQueries({ queryKey: ['friend-requests'] })
    }
    function onFriendRemoved() {
      void queryClient.invalidateQueries({ queryKey: ['friends'] })
    }
    function onDmMessage() {
      void queryClient.invalidateQueries({ queryKey: ['dm-channels'] })
    }

    window.addEventListener('ws:friend_request', onFriendRequest)
    window.addEventListener('ws:friend_added', onFriendAdded)
    window.addEventListener('ws:friend_removed', onFriendRemoved)
    window.addEventListener('ws:dm_channel_create', onDmMessage)

    return () => {
      window.removeEventListener('ws:friend_request', onFriendRequest)
      window.removeEventListener('ws:friend_added', onFriendAdded)
      window.removeEventListener('ws:friend_removed', onFriendRemoved)
      window.removeEventListener('ws:dm_channel_create', onDmMessage)
    }
  }, [queryClient])

  // ── React to user settings WS events ─────────────────────────────────────
  // t=401 fires when the user's settings change (including from another client,
  // e.g. they reorder guilds from mobile).  Re-fetch full settings and apply:
  //   • Updated presence status
  //   • Updated guild folder layout (ordering/folders changed on another device)

  useEffect(() => {
    function onUserSettingsUpdate() {
      userApi
        .userMeSettingsGet()
        .then((res) => {
          const settings = res.data?.settings

          // Sync presence status
          const savedStatus = settings?.status?.status
          if (savedStatus && VALID_STATUSES.has(savedStatus)) {
            setOwnStatus(savedStatus as UserStatus)
            sendPresenceStatus(savedStatus as UserStatus)
          }

          // Reload guild folder layout — another client may have changed ordering
          useFolderStore.getState().loadFromSettings(
            settings?.guild_folders,
            settings?.guilds,
          )
        })
        .catch(() => {
          // Non-critical — keep current state if the fetch fails
        })
    }

    window.addEventListener('ws:user_settings_update', onUserSettingsUpdate)
    return () => window.removeEventListener('ws:user_settings_update', onUserSettingsUpdate)
  }, [setOwnStatus])
}
