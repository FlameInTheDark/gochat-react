import { useState, useEffect, useRef } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useIdlePresence } from '@/hooks/useIdlePresence'
import { useDeepLink } from '@/hooks/useDeepLink'
import { axiosInstance, userApi } from '@/api/client'
import AppShell from '@/components/layout/AppShell'
import InviteModal from '@/components/modals/InviteModal'
import JoinServerModal from '@/components/modals/JoinServerModal'
import AppSettingsModal from '@/components/modals/AppSettingsModal'
import ServerSettingsModal from '@/components/modals/ServerSettingsModal'
import ChannelSettingsModal from '@/components/modals/ChannelSettingsModal'
import UserProfilePanel from '@/components/layout/UserProfilePanel'
import type { DtoUser } from '@/types'
import { usePresenceStore, type UserStatus } from '@/stores/presenceStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { sendPresenceStatus } from '@/services/wsService'
import { useFolderStore } from '@/stores/folderStore'
import { useReadStateStore } from '@/stores/readStateStore'
import { useMentionStore } from '@/stores/mentionStore'
import { useEmojiStore } from '@/stores/emojiStore'
import { useGifStore } from '@/stores/gifStore'
import i18n from '@/i18n'
import { setupTokenRefreshScheduler } from '@/lib/tokenRefresh'
import { getApiBaseUrl } from '@/lib/connectionConfig'
import { compareSnowflakes } from '@/lib/snowflake'

const VALID_STATUSES = new Set<string>(['online', 'idle', 'dnd', 'offline'])

// ── Inner component ────────────────────────────────────────────────────────
// Only mounts once auth is confirmed. Tying useWebSocket() here means:
//   • WS connects AFTER the token is validated (and silently refreshed if needed)
//   • WS disconnects automatically when the user logs out (component unmounts)
//   • No speculative connection with a stale/invalid token
function AuthenticatedApp() {
  useWebSocket()
  useIdlePresence()
  useDeepLink()

  // Keep authStore user in sync with WS t=406 profile update events
  useEffect(() => {
    const handler = (e: Event) => {
      const updated = (e as CustomEvent<DtoUser>).detail
      if (updated) {
        const current = useAuthStore.getState().user
        // Merge so sparse WS updates don't clear fields like avatar
        useAuthStore.getState().setUser(current ? { ...current, ...updated } : updated)
      }
    }
    window.addEventListener('ws:user_update', handler)
    return () => window.removeEventListener('ws:user_update', handler)
  }, [])

  return (
    <AppShell>
      <Outlet />
      <InviteModal />
      <JoinServerModal />
      <AppSettingsModal />
      <ServerSettingsModal />
      <ChannelSettingsModal />
      <UserProfilePanel />
    </AppShell>
  )
}

// ── Loading screen ─────────────────────────────────────────────────────────
function LoadingScreen() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4 text-muted-foreground">
        <div className="w-10 h-10 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        <p className="text-sm">{i18n.t('app.loading')}</p>
      </div>
    </div>
  )
}

// ── Auth guard / init orchestrator ─────────────────────────────────────────
// Initialization order:
//   1. Validate the stored access token via GET /user/me
//      → if expired: the 401 interceptor on axiosInstance transparently uses
//        the refresh token to obtain a new access token, then retries
//      → if both tokens are invalid/absent: logout + redirect to /
//   2. On success: set the user in authStore, unmount loading screen
//   3. AuthenticatedApp mounts → useWebSocket() connects
//   4. WS hello received → guild subscriptions sent (resubscribe)
//   5. Child components mount and fetch their own data (guilds, channels, …)
export default function AppLayout() {
  const navigate = useNavigate()
  const token = useAuthStore((s) => s.token)
  const setUser = useAuthStore((s) => s.setUser)
  const logout = useAuthStore((s) => s.logout)

  // Proactive token refresh: decodes the JWT expiry and schedules a refresh
  // 30 s before it expires so the WS and API never hit a stale token.
  // Runs once and subscribes to future token changes (e.g. after each refresh).
  useEffect(() => setupTokenRefreshScheduler(), [])

  // Only show the loading screen when we actually have a token to validate.
  // Avoids a blank-flash on the unauthenticated redirect path.
  const [isValidating, setIsValidating] = useState(!!token)

  // Tracks the token that was most recently validated successfully.
  // A non-null → different non-null transition means the 401 interceptor silently
  // refreshed the token — skip re-validation to prevent a loading-screen flash.
  const validatedTokenRef = useRef<string | null>(null)

  useEffect(() => {
    if (!token) {
      validatedTokenRef.current = null
      setIsValidating(false)
      navigate('/', { replace: true })
      return
    }

    // Silent token refresh: the 401 interceptor already renewed the token while
    // the user was authenticated.  Just update the ref — no need to hit /user/me
    // again or show the loading spinner.
    if (validatedTokenRef.current !== null) {
      validatedTokenRef.current = token
      return
    }

    setIsValidating(true)

    const baseUrl = getApiBaseUrl()
    const controller = new AbortController()

    // Fetch user identity and settings in parallel.
    // axiosInstance carries the request interceptor (Authorization header) and
    // the response interceptor (401 → refresh token → retry). Plain axios does
    // not, so an expired access token would incorrectly force a logout here.
    // Settings fetch is non-critical — a failure is swallowed so it never
    // blocks auth or causes a spurious logout.
    Promise.all([
      axiosInstance.get<DtoUser>(`${baseUrl}/user/me`, { signal: controller.signal }),
      userApi.userMeSettingsGet({}, { signal: controller.signal }).catch(() => null),
    ])
      .then(([userRes, settingsRes]) => {
        if (userRes.data) {
          setUser(userRes.data)
        } else {
          throw new Error('Empty /user/me response')
        }
        // Mark this token as validated so future silent refreshes are skipped.
        validatedTokenRef.current = token
        // Restore saved presence status + custom status text before the WS
        // connects so resubscribe() sends the correct op:3 on the very first hello.
        const savedStatus = settingsRes?.data?.settings?.status?.status
        const savedCustomText = settingsRes?.data?.settings?.status?.custom_status_text ?? ''
        if (savedCustomText) {
          usePresenceStore.getState().setCustomStatusText(savedCustomText)
        }
        const effectiveStatus = (savedStatus && VALID_STATUSES.has(savedStatus)
          ? savedStatus : 'online') as UserStatus
        if (savedStatus && VALID_STATUSES.has(savedStatus)) {
          usePresenceStore.getState().setOwnStatus(effectiveStatus)
        }
        // Seeds wsService module-level caches; socket not open yet so no actual send
        sendPresenceStatus(effectiveStatus, savedCustomText)
        // Restore guild folder layout + ordering from settings
        useFolderStore.getState().loadFromSettings(
          settingsRes?.data?.settings?.guild_folders,
          settingsRes?.data?.settings?.guilds,
        )
        // Load per-channel read states and latest-message IDs so pagination can
        // determine where to scroll on channel open (unread separator position).
        if (settingsRes?.data) {
          useReadStateStore.getState().setFromSettings(settingsRes.data)

          // Seed mention badges from the `mentions` snapshot in the settings response.
          // The Go server sends PascalCase keys (ChannelId, MessageId) at runtime,
          // not the camelCase names in the generated TypeScript types.
          // guildId is not in the mention object — derive it from guilds_last_messages.
          const rawMentions = settingsRes.data.mentions ?? {}
          const readStates = useReadStateStore.getState().readStates
          // Build channelId → guildId reverse lookup from guilds_last_messages
          const channelGuildMap: Record<string, string> = {}
          for (const [gId, channelMap] of Object.entries(settingsRes.data.guilds_last_messages ?? {})) {
            for (const chId of Object.keys(channelMap)) {
              channelGuildMap[chId] = gId
            }
          }
          const mentionSeed: Record<string, { messageIds: string[]; guildId: string | null }> = {}
          for (const [channelId, items] of Object.entries(rawMentions)) {
            if (!Array.isArray(items) || !items.length) continue
            const guildId = channelGuildMap[channelId] ?? null
            let messageIds = items
              .map((m) => {
                const raw = m as unknown as Record<string, unknown>
                const msgId = (raw['MessageId'] ?? raw['messageId']) as string | number | undefined
                return msgId != null ? String(msgId) : null
              })
              .filter((msgId): msgId is string => msgId != null)
            const lastRead = readStates[channelId]
            if (lastRead) {
              messageIds = messageIds.filter((msgId) => compareSnowflakes(msgId, lastRead) > 0)
            }
            if (messageIds.length > 0) {
              mentionSeed[channelId] = { messageIds, guildId }
            }
          }
          useMentionStore.getState().seedMentions(mentionSeed)
        }
        // Seed custom emoji store from guild_emojis in settings
        const guildEmojis = settingsRes?.data?.guild_emojis
        if (guildEmojis) {
          const emojiStore = useEmojiStore.getState()
          for (const [guildId, emojiRefs] of Object.entries(guildEmojis)) {
            emojiStore.setGuildEmojis(
              guildId,
              (emojiRefs ?? []).map((e) => ({
                id: String(e.id ?? ''),
                name: String(e.name ?? ''),
                guild_id: guildId,
              })),
            )
          }
        }
        // Restore favorite GIFs
        const savedFavoriteGifs = settingsRes?.data?.settings?.favorite_gifs
        if (Array.isArray(savedFavoriteGifs)) {
          useGifStore.getState().setFavorites(savedFavoriteGifs)
        }
        // Load trusted content hosts for inline GIF rendering
        const contentHosts = settingsRes?.data?.content_hosts
        if (Array.isArray(contentHosts)) {
          useGifStore.getState().setContentHosts(contentHosts)
        }
        // Apply saved display language
        const savedLanguage = settingsRes?.data?.settings?.language
        if (savedLanguage && savedLanguage.trim()) {
          void i18n.changeLanguage(savedLanguage)
        }
        // Restore voice settings
        if (settingsRes?.data?.settings?.devices) {
          const d = settingsRes.data.settings.devices
          useVoiceStore.getState().setSettings({
            audioInputDevice: d.audio_input_device ?? '',
            audioOutputDevice: d.audio_output_device ?? '',
            audioInputLevel: d.audio_input_level || 100,
            audioOutputLevel: d.audio_output_level || 100,
            autoGainControl: d.auto_gain_control ?? true,
            echoCancellation: d.echo_cancellation ?? true,
            noiseSuppression: d.noise_suppression ?? true,
          })
        }
      })
      .catch(() => {
        // Aborted by StrictMode cleanup — the effect will re-run; do nothing.
        if (controller.signal.aborted) return
        // Refresh also failed (or no refresh token) — clear everything and
        // send the user back to the login screen.
        validatedTokenRef.current = null
        logout()
        navigate('/', { replace: true })
      })
      .finally(() => {
        // Guard against calling setState after the effect was cleaned up.
        // When the signal is aborted (token changed while validating), the new
        // effect invocation takes responsibility for isValidating state.
        if (!controller.signal.aborted) setIsValidating(false)
      })

    return () => {
      controller.abort()
    }
    // token is the only real dependency; navigate/setUser/logout are stable refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  // No token — effect already navigated away; render nothing during transition
  if (!token) return null

  // Token exists but not yet validated — show spinner so child components
  // don't mount and fire off queries while auth is still undecided
  if (isValidating) return <LoadingScreen />

  // Validated — hand off to the authenticated shell + WebSocket
  return <AuthenticatedApp />
}
