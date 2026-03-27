import { useEffect, useLayoutEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { connect, disconnect, subscribeGuilds, sendPresenceStatus, updateToken } from '@/services/wsService'
import { useAuthStore } from '@/stores/authStore'
import { userApi } from '@/api/client'
import { usePresenceStore, type UserStatus } from '@/stores/presenceStore'
import { useFolderStore } from '@/stores/folderStore'
import { ChannelType, type DtoChannel } from '@/types'
import { useAppearanceStore, DEFAULT_CHAT_SPACING, DEFAULT_FONT_SCALE } from '@/stores/appearanceStore'
import { useNotificationSettingsStore } from '@/stores/notificationSettingsStore'
import i18n from '@/i18n'

const VALID_STATUSES = new Set<string>(['online', 'idle', 'dnd', 'offline'])

interface WsChannelEventDetail {
  guild_id?: string | number
  channel?: DtoChannel
  channel_id?: string | number
  channel_type?: string | number
}

interface WsThreadEventDetail {
  guild_id?: string | number
  thread?: DtoChannel
  thread_id?: string | number
}

interface ThreadLinkQueryResult {
  thread: DtoChannel | null
  missing: boolean
}

function isThreadChannelType(type: string | number | undefined): boolean {
  return Number(type) === ChannelType.ChannelTypeThread
}

function getChannelEventGuildId(detail: WsChannelEventDetail | undefined): string | undefined {
  if (detail?.guild_id !== undefined) return String(detail.guild_id)
  if (detail?.channel?.guild_id !== undefined) return String(detail.channel.guild_id)
  return undefined
}

function getThreadIdFromChannelEvent(detail: WsChannelEventDetail | undefined): string | undefined {
  if (detail?.channel?.id != null && isThreadChannelType(detail.channel.type)) {
    return String(detail.channel.id)
  }
  if (detail?.channel_id != null && isThreadChannelType(detail.channel_type)) {
    return String(detail.channel_id)
  }
  return undefined
}

function getThreadGuildId(detail: WsThreadEventDetail | undefined): string | undefined {
  if (detail?.guild_id !== undefined) return String(detail.guild_id)
  if (detail?.thread?.guild_id !== undefined) return String(detail.thread.guild_id)
  return undefined
}

function getThreadFromEvent(detail: WsThreadEventDetail | undefined): DtoChannel | undefined {
  return detail?.thread && isThreadChannelType(detail.thread.type)
    ? detail.thread
    : undefined
}

function getThreadIdFromEvent(detail: WsThreadEventDetail | undefined): string | undefined {
  const thread = getThreadFromEvent(detail)
  if (thread?.id != null) return String(thread.id)
  if (detail?.thread_id != null) return String(detail.thread_id)
  return undefined
}

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
      const detail = (e as CustomEvent<WsChannelEventDetail | undefined>).detail
      const guildId = getChannelEventGuildId(detail)
      const threadId = getThreadIdFromChannelEvent(detail)

      // For channel updates with full channel data, patch the cache directly to avoid a network refetch
      if (e.type === 'ws:channel_update' && guildId && detail?.channel) {
        queryClient.setQueryData<DtoChannel[]>(
          ['channels', guildId],
          (prev) => {
            if (!prev) return prev
            const updated = detail.channel!
            const id = String(updated.id)
            const idx = prev.findIndex((c) => String(c.id) === id)
            if (idx === -1) return [...prev, updated]
            const next = [...prev]
            next[idx] = updated
            return next
          },
        )
        if (threadId) {
          void queryClient.invalidateQueries({ queryKey: ['channel-threads', guildId] })
          void queryClient.invalidateQueries({ queryKey: ['thread-channel', guildId, threadId] })
          void queryClient.invalidateQueries({ queryKey: ['thread-link', guildId, threadId] })
          void queryClient.invalidateQueries({ queryKey: ['thread-preview', threadId] })
        }
        return
      }

      if (guildId) {
        void queryClient.invalidateQueries({ queryKey: ['channels', guildId] })
        if (threadId) {
          void queryClient.invalidateQueries({ queryKey: ['channel-threads', guildId] })
          void queryClient.invalidateQueries({ queryKey: ['thread-channel', guildId, threadId] })
          void queryClient.invalidateQueries({ queryKey: ['thread-link', guildId, threadId] })
        }
      } else {
        void queryClient.invalidateQueries({ queryKey: ['channels'] })
      }
      if (threadId) {
        void queryClient.invalidateQueries({ queryKey: ['thread-preview', threadId] })
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

  useEffect(() => {
    function onThreadUpsert(e: Event) {
      const detail = (e as CustomEvent<WsThreadEventDetail | undefined>).detail
      const guildId = getThreadGuildId(detail)
      const thread = getThreadFromEvent(detail)
      const threadId = getThreadIdFromEvent(detail)
      if (!guildId || !thread || !threadId) return
      const parentId = thread.parent_id != null ? String(thread.parent_id) : null

      if (parentId) {
        queryClient.setQueryData<DtoChannel[]>(['channel-threads', guildId, parentId], (current) => {
          if (!current) return current

          let found = false
          const next = current.map((candidate) => {
            if (String(candidate.id) !== threadId) return candidate
            found = true
            return thread
          })

          return found ? next : [...current, thread]
        })
      }

      queryClient.setQueryData<DtoChannel | null>(['thread-channel', guildId, threadId], thread)
      queryClient.setQueryData<ThreadLinkQueryResult>(['thread-link', guildId, threadId], {
        thread,
        missing: false,
      })
      void queryClient.invalidateQueries({ queryKey: ['channel-threads', guildId] })
      void queryClient.invalidateQueries({ queryKey: ['thread-preview', threadId] })
    }

    function onThreadDelete(e: Event) {
      const detail = (e as CustomEvent<WsThreadEventDetail | undefined>).detail
      const guildId = getThreadGuildId(detail)
      const threadId = getThreadIdFromEvent(detail)
      if (!guildId || !threadId) return

      queryClient.setQueriesData<DtoChannel[]>({ queryKey: ['channel-threads', guildId] }, (current) => {
        if (!current) return current
        return current.filter((candidate) => String(candidate.id) !== threadId)
      })
      queryClient.setQueryData<DtoChannel | null>(['thread-channel', guildId, threadId], null)
      queryClient.setQueryData<ThreadLinkQueryResult>(['thread-link', guildId, threadId], {
        thread: null,
        missing: true,
      })
      queryClient.removeQueries({ queryKey: ['thread-preview', threadId] })
    }

    window.addEventListener('ws:thread_create', onThreadUpsert)
    window.addEventListener('ws:thread_update', onThreadUpsert)
    window.addEventListener('ws:thread_delete', onThreadDelete)

    return () => {
      window.removeEventListener('ws:thread_create', onThreadUpsert)
      window.removeEventListener('ws:thread_update', onThreadUpsert)
      window.removeEventListener('ws:thread_delete', onThreadDelete)
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

    function onMemberModeration(e: Event) {
      const detail = (e as CustomEvent<{ guild_id?: string | number } | undefined>).detail
      const guildId = detail?.guild_id !== undefined ? String(detail.guild_id) : undefined
      if (guildId) {
        void queryClient.invalidateQueries({ queryKey: ['bans', guildId] })
      } else {
        void queryClient.invalidateQueries({ queryKey: ['bans'] })
      }
    }

    window.addEventListener('ws:member_added', onMemberEvent)
    window.addEventListener('ws:member_updated', onMemberEvent)
    window.addEventListener('ws:member_removed', onMemberEvent)
    // t=203/204: role assigned to / removed from a member — refresh member list
    // so channel visibility filtering picks up the new role set immediately.
    window.addEventListener('ws:member_role_added', onMemberEvent)
    window.addEventListener('ws:member_role_removed', onMemberEvent)
    window.addEventListener('ws:member_moderation', onMemberModeration)

    return () => {
      window.removeEventListener('ws:member_added', onMemberEvent)
      window.removeEventListener('ws:member_updated', onMemberEvent)
      window.removeEventListener('ws:member_removed', onMemberEvent)
      window.removeEventListener('ws:member_role_added', onMemberEvent)
      window.removeEventListener('ws:member_role_removed', onMemberEvent)
      window.removeEventListener('ws:member_moderation', onMemberModeration)
    }
  }, [queryClient])

  // ── React to guild role WS events ──────────────────────────────────────────

  useEffect(() => {
    function onRoleEvent(e: Event) {
      const detail = (e as CustomEvent<{
        guild_id?: string | number
        role?: { guild_id?: string | number }
      } | undefined>).detail
      const guildId = detail?.guild_id !== undefined
        ? String(detail.guild_id)
        : detail?.role?.guild_id !== undefined
          ? String(detail.role.guild_id)
          : undefined
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
    function applySettings(settings: NonNullable<Awaited<ReturnType<typeof userApi.userMeSettingsGet>>['data']['settings']>) {
      queryClient.setQueryData(['user-settings'], settings)

      // Presence status
      const savedStatus = settings.status?.status
      if (savedStatus && VALID_STATUSES.has(savedStatus)) {
        setOwnStatus(savedStatus as UserStatus)
        sendPresenceStatus(savedStatus as UserStatus)
      }

      // Guild folder layout
      useFolderStore.getState().loadFromSettings(settings.guild_folders, settings.guilds)

      // Appearance
      const { setFontScale, setChatSpacing } = useAppearanceStore.getState()
      setFontScale(settings.appearance?.chat_font_scale ?? DEFAULT_FONT_SCALE)
      setChatSpacing(settings.appearance?.chat_spacing ?? DEFAULT_CHAT_SPACING)

      // Language
      if (settings.language) {
        void i18n.changeLanguage(settings.language)
      }

      // Notification settings
      useNotificationSettingsStore.getState().setSettings({
        guilds: settings.guilds,
        channels: settings.channels,
        users: settings.users,
      })
    }

    function onUserSettingsUpdate(e: Event) {
      const detail = (e as CustomEvent).detail
      // The WS event payload may carry the full settings — use it directly to
      // avoid an extra GET.  If it doesn't, fall back to a network fetch.
      const maybeSettings = detail?.settings ?? (detail && 'status' in detail ? detail : null)
      if (maybeSettings) {
        applySettings(maybeSettings)
        return
      }
      userApi
        .userMeSettingsGet()
        .then((res) => {
          const settings = res.data?.settings
          if (settings) applySettings(settings)
        })
        .catch(() => {
          // Non-critical — keep current state if the fetch fails
        })
    }

    window.addEventListener('ws:user_settings_update', onUserSettingsUpdate)
    return () => window.removeEventListener('ws:user_settings_update', onUserSettingsUpdate)
  }, [setOwnStatus])
}
