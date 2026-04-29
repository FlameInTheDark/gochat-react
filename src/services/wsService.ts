import JSONBig from 'json-bigint'
import { useMessageStore } from '@/stores/messageStore'
import { usePresenceStore, type ActiveStreamPresence, type UserStatus } from '@/stores/presenceStore'
import { useUnreadStore } from '@/stores/unreadStore'
import { useTypingStore } from '@/stores/typingStore'
import { useMentionStore } from '@/stores/mentionStore'
import { useReadStateStore } from '@/stores/readStateStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { useStreamStore } from '@/stores/streamStore'
import { useAuthStore } from '@/stores/authStore'
import { performLogout } from '@/lib/logoutCleanup'
import { useEmojiStore } from '@/stores/emojiStore'
import { playMentionSound } from '@/lib/sounds'
import { axiosInstance } from '@/api/client'
import { ChannelType, type DtoChannel, type DtoMessage, type DtoMessageReaction } from '@/types'
import { getWsUrl, getApiBaseUrl } from '@/lib/connectionConfig'
import { useNotificationSettingsStore } from '@/stores/notificationSettingsStore'
import { ModelNotificationsType } from '@/client'
import type { ModelUserSettingsNotifications } from '@/client'

// BigInt-aware serializer for outgoing WS messages that contain Snowflake IDs.
// The Go backend expects int64 numbers — plain JSON.stringify would either lose
// precision (Number(bigint)) or emit quoted strings (toString). Instead we use a
// placeholder swap: BigInt values become unquoted integers in the final JSON.
function _bigJsonStringify(data: unknown): string {
  const PLACEHOLDER = '__BIGINT_'
  const json = JSON.stringify(data, (_, v) =>
    typeof v === 'bigint' ? `${PLACEHOLDER}${v}__` : v
  )
  return json.replace(/"__BIGINT_(\d+)__"/g, '$1')
}

// BigInt-safe parser for incoming WS messages.
// storeAsString: true keeps large integers as strings, consistent with the API
// client (json-bigint storeAsString mode) so all String() calls below are safe.
const _bigJsonParse = JSONBig({ storeAsString: true })

let socket: WebSocket | null = null

// Heartbeat is driven by a Web Worker so timer callbacks are NOT subject to the
// ≥1 second throttle browsers apply to setInterval/setTimeout in background tabs.
// Falls back to plain setInterval if workers are unavailable (e.g. strict CSP).
let heartbeatWorker: Worker | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null  // fallback only
let heartbeatIntervalMs = 0
let lastHeartbeatAt = 0

// Reconnect state
let currentToken: string | null = null
let intentionalClose = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1_000 // ms — doubles each attempt, capped at 30 s
const MAX_RECONNECT_DELAY = 30_000

// Active subscriptions — restored after every reconnect
const activeGuildSubs = new Set<string>()
const explicitChannelCounts = new Map<string, number>()
const visibleChannelCounts = new Map<string, number>()
const activePresenceSubs = new Set<string>()

// Own status kept in sync with presenceStore.ownStatus
let currentOwnStatus: UserStatus = 'online'
// Custom status text included in every op:3 presence broadcast
let currentCustomStatusText = ''
// Current voice channel ID — included in every op:3 presence broadcast
let currentVoiceChannelId: string | null = null
// Current local camera state — included in every op:3 presence broadcast
let currentSelfVideo = false

// Last event sequence ID received — echoed back in heartbeats (op:2, d.e)
let lastEventId = 0

// Session ID from the most recent Hello reply.
// Passed as heartbeat_session_id on reconnect so the server reuses the
// existing presence session, avoiding spurious offline→online transitions.
let currentSessionId: string | null = null

// True once the server has confirmed auth for the current socket (op:1 received).
// Reset to false each time createSocket() opens a new socket. Used in onClose()
// to distinguish auth failures (never got op:1) from normal network drops.
let authSucceeded = false

// Timestamp when the current socket's 'open' event fired.
// A close before AUTH_QUICK_CLOSE_MS ms after open strongly indicates the
// server rejected the token — trigger a proactive token refresh.
let socketOpenTime: number | null = null
const AUTH_QUICK_CLOSE_MS = 5_000

// Set true by the browser 'offline' event; cleared by 'online'.
// Suppresses reconnect attempts while there is no network path.
let isNetworkOffline = false

// Prevents concurrent refreshTokenAndReconnect calls (e.g. both visibilitychange
// and onClose firing at the same time after a long background suspension).
let isRefreshingToken = false

// ── Helpers ──────────────────────────────────────────────────────────────────

// All outgoing messages that contain Snowflake IDs must go through sendJson so
// they are serialised with BigInt support.  Plain JSON.stringify turns BigInt
// values into quoted strings; the Go backend cannot decode those as int64.
function sendJson(data: unknown) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(_bigJsonStringify(data))
  }
}

function sendHeartbeat() {
  if (socket?.readyState === WebSocket.OPEN) {
    // op=2: Heartbeat — echo the last event ID we've processed.
    // The server resets its timeout timer only if e >= its internal counter.
    socket.send(JSON.stringify({ op: 2, d: { e: lastEventId } }))
  }
}

function dispatchHeartbeat() {
  if (heartbeatIntervalMs <= 0) {
    sendHeartbeat()
    return
  }

  const now = Date.now()
  // When both the worker and the fallback timer are running, coalesce them
  // into a single outbound heartbeat for the current interval window.
  if (lastHeartbeatAt !== 0 && now - lastHeartbeatAt < Math.max(1_000, heartbeatIntervalMs / 2)) {
    return
  }

  lastHeartbeatAt = now
  sendHeartbeat()
}

function ensureHeartbeatFallback() {
  if (heartbeatIntervalMs <= 0 || heartbeatTimer !== null) {
    return
  }
  heartbeatTimer = setInterval(dispatchHeartbeat, heartbeatIntervalMs)
}

function getOrCreateHeartbeatWorker(): Worker | null {
  if (heartbeatWorker) return heartbeatWorker
  try {
    heartbeatWorker = new Worker(
      new URL('./heartbeatWorker', import.meta.url),
      { type: 'module' },
    )
    heartbeatWorker.onmessage = () => dispatchHeartbeat()
    heartbeatWorker.onerror = () => {
      // Worker failed (e.g. strict CSP or bundler/runtime issue) — keep the
      // connection alive with the main-thread timer instead of dropping heartbeats.
      heartbeatWorker = null
      ensureHeartbeatFallback()
    }
    return heartbeatWorker
  } catch {
    return null
  }
}

function clearHeartbeat() {
  heartbeatIntervalMs = 0
  lastHeartbeatAt = 0
  if (heartbeatWorker) {
    heartbeatWorker.postMessage({ type: 'stop' })
  }
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function startHeartbeat(intervalMs: number) {
  clearHeartbeat()
  heartbeatIntervalMs = intervalMs
  const worker = getOrCreateHeartbeatWorker()
  if (worker) {
    worker.postMessage({ type: 'start', intervalMs })
  }
  // Always keep a normal timer as a safety net. The worker still helps in
  // background tabs, but the fallback prevents silent heartbeat loss if the
  // worker fails after startup.
  ensureHeartbeatFallback()
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function getSubscribedChannelIds(): string[] {
  const all = new Set<string>(explicitChannelCounts.keys())
  for (const channelId of visibleChannelCounts.keys()) {
    all.add(channelId)
  }
  return [...all]
}

function isChannelVisible(channelId: string): boolean {
  return (visibleChannelCounts.get(channelId) ?? 0) > 0
}

// Mention type constants matching the backend enum in mention.go
const MentionType = { User: 0, Role: 1, Everyone: 2, Here: 3 } as const

function getEffectiveNotif(
  guildId: string | null,
  channelId: string,
): ModelUserSettingsNotifications | undefined {
  const store = useNotificationSettingsStore.getState()
  return store.getChannelNotif(channelId) ?? (guildId ? store.getGuildNotif(guildId) : undefined)
}

function isEffectivelyMuted(notif: ModelUserSettingsNotifications | undefined): boolean {
  if (!notif?.muted) return false
  if (!notif.muted_until) return true
  return new Date(notif.muted_until) > new Date()
}

function isMentionSuppressed(
  notif: ModelUserSettingsNotifications | undefined,
  mentionType: number | undefined,
): boolean {
  if (!notif || mentionType == null) return false
  if (mentionType === MentionType.Everyone && notif.suppress_everyone_mentions) return true
  if (mentionType === MentionType.Here && notif.suppress_here_mentions) return true
  if (mentionType === MentionType.Role && notif.suppress_role_mentions) return true
  if (mentionType === MentionType.User && notif.suppress_user_mentions) return true
  return false
}

function syncChannelSubscriptions() {
  if (socket?.readyState !== WebSocket.OPEN) return
  sendJson({ op: 5, d: { channels: getSubscribedChannelIds().map((id) => BigInt(id)) } })
}

function scheduleReconnect() {
  if (intentionalClose || !currentToken) return
  clearReconnectTimer()
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!intentionalClose && currentToken) {
      createSocket(currentToken)
    }
  }, reconnectDelay)
  // Exponential backoff
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
}

function resetReconnectDelay() {
  reconnectDelay = 1_000
}

/**
 * Validate (and silently refresh if expired) the access token via a lightweight
 * HTTP probe, then reconnect the WebSocket with the fresh token.
 *
 * Called when:
 *   • The server closed the socket before op:1 arrived (likely expired token)
 *   • The tab becomes visible again after a background suspension
 *   • The network comes back online
 *
 * The 401 interceptor on axiosInstance already handles the full
 * access→refresh→retry cycle and updates authStore, so a single
 * GET /user/me call is sufficient to ensure the token is live.
 */
async function refreshTokenAndReconnect() {
  if (intentionalClose || !currentToken || isRefreshingToken) return
  isRefreshingToken = true
  try {
    const baseUrl = getApiBaseUrl()
    // The 401 interceptor will refresh the token if needed and retry.
    // On success the store always holds the most recent valid token.
    await axiosInstance.get(`${baseUrl}/user/me`)
    const freshToken = useAuthStore.getState().token
    if (!freshToken) return
    currentToken = freshToken
  } catch {
    // Both access and refresh tokens are invalid.
    // Logout clears authStore → useWebSocket observes token=null → calls disconnect().
    performLogout()
    return
  } finally {
    isRefreshingToken = false
  }
  if (!intentionalClose && currentToken) {
    // Use exponential backoff instead of reconnecting immediately,
    // to avoid hammering /user/me + WS when the backend is unavailable.
    scheduleReconnect()
  }
}

// Re-apply all active subscriptions after a reconnect (called from hello handler)
function resubscribe() {
  if (socket?.readyState !== WebSocket.OPEN) return

  if (activeGuildSubs.size > 0) {
    sendJson({ op: 5, d: { guilds: [...activeGuildSubs].map((id) => BigInt(id)) } })
  }
  syncChannelSubscriptions()

  // Re-send own presence status (with custom text and voice channel if set)
  sendJson({
    op: 3,
    d: {
      status: currentOwnStatus,
      platform: 'web',
      ...(currentCustomStatusText ? { custom_status_text: currentCustomStatusText } : {}),
      ...(currentVoiceChannelId ? { voice_channel_id: BigInt(currentVoiceChannelId) } : {}),
      self_video: currentSelfVideo,
    },
  })

  // Re-subscribe to tracked users' presence
  if (activePresenceSubs.size > 0) {
    sendJson({ op: 6, d: { set: [...activePresenceSubs].map((id) => BigInt(id)) } })
  }
}

// ── Message type interfaces ───────────────────────────────────────────────────

interface WsPayload {
  op: number
  t?: number
  d?: unknown
}

interface WsHelloData {
  heartbeat_interval?: number
  session_id?: string
}

interface WsDeletedMessage {
  channel_id?: string | number
  id?: string | number
  message_id?: string | number
}

// t=103/104: reaction event — d = { guild_id, channel_id, message_id, reaction }
interface WsReactionEvent {
  guild_id?: string | number
  channel_id?: string | number
  message_id?: string | number
  reaction?: DtoMessageReaction
}

// t=100: actual message event — d = { guild_id, message: DtoMessage }
interface WsGuildMessageEvent {
  guild_id?: string | number
  message?: DtoMessage
}

// t=300: lightweight guild-channel notification — NOT a full message.
//   d = { guild_id, channel_id, message_id }
// Used to show unread indicators; the message body is NOT present.
interface WsChannelNotification {
  guild_id?: string | number
  channel_id?: string | number
  message_id?: string | number
}

// t=301: channel typing event — another user started typing.
//   d = { channel_id, user_id, username? }
interface WsTypingEvent {
  channel_id?: string | number
  user_id?: string | number
  username?: string
  user_name?: string
  name?: string
}

// t=302: mention event — current user was @mentioned.
//   d = { guild_id, channel_id, message_id, author_id, type }
interface WsMentionEvent {
  guild_id?: string | number
  channel_id?: string | number
  message_id?: string | number
  author_id?: string | number
  type?: number
}

// t=405: lightweight DM activity notification, delivered on user.{userId}
interface WsDmNotification {
  channel_id?: string | number
  message_id?: string | number
  from?: {
    id?: string | number
    name?: string
    discriminator?: string
    avatar?: unknown
  }
}

interface WsThreadEvent {
  guild_id?: string | number
  thread?: DtoChannel
}

interface WsThreadDeleteEvent {
  guild_id?: string | number
  thread_id?: string | number
}

// Presence dispatch payload — server sends as op:3 (not op:0)
interface WsPresenceEvent {
  user_id?: string | number
  status?: string
  custom_status_text?: string
  since?: number
  voice_channel_id?: string | number
  mute?: boolean
  deafen?: boolean
  self_video?: boolean
  username?: string
  avatar_url?: string
  client_status?: Record<string, string>
  active_stream?: {
    id?: string | number
    channel_id?: string | number
    source_type?: ActiveStreamPresence['sourceType']
    audio_mode?: ActiveStreamPresence['audioMode']
    started_at?: number
  } | null
}

function extractMessage(d: unknown): DtoMessage | null {
  if (!d) return null
  const data = d as WsGuildMessageEvent & DtoMessage
  // Primary path: t=100 / t=405 wrap the message → { guild_id, message: DtoMessage }
  if (data.message?.channel_id !== undefined) return data.message
  // Fallback: message is the payload directly (e.g. some t=101 update formats)
  if (data.channel_id !== undefined && data.author !== undefined) return data as DtoMessage
  return null
}

const VALID_STATUSES = new Set<UserStatus>(['online', 'idle', 'dnd', 'offline'])

function normalizeStatus(s: string | undefined): UserStatus {
  if (s && VALID_STATUSES.has(s as UserStatus)) return s as UserStatus
  return 'offline'
}

function normalizeActiveStream(
  raw: WsPresenceEvent['active_stream'],
): ActiveStreamPresence | null {
  if (!raw?.id || !raw.channel_id) return null
  return {
    id: String(raw.id),
    channelId: String(raw.channel_id),
    sourceType: raw.source_type ?? 'screen',
    audioMode: raw.audio_mode ?? 'none',
    startedAt: Number(raw.started_at ?? 0),
  }
}

function isThreadChannel(channel: DtoChannel | null | undefined): channel is DtoChannel {
  return channel?.type === ChannelType.ChannelTypeThread
}

// ── Incoming message handler ──────────────────────────────────────────────────

function handleMessage(event: MessageEvent) {
  let payload: WsPayload
  try {
    // Use BigInt-safe parser so large int64 Snowflake IDs are preserved as strings
    payload = _bigJsonParse.parse(event.data as string) as WsPayload
  } catch {
    return
  }

  const { op, t, d } = payload

  // ── Op 1: Hello Reply ────────────────────────────────────────────────────
  // Server sends {op:1, d:{heartbeat_interval, session_id}} after validating
  // the client's auth token.  Save the session_id for reconnect use.
  if (op === 1) {
    authSucceeded = true   // auth confirmed — onClose will use normal backoff if it fires
    resetReconnectDelay()
    lastEventId = 0
    const hello = d as WsHelloData | undefined
    // Persist session_id so we can pass it as heartbeat_session_id on reconnect,
    // letting the server reuse the presence session and avoid spurious offline events.
    if (hello?.session_id) currentSessionId = hello.session_id
    const interval = (hello?.heartbeat_interval ?? 30_000) - 1_000
    startHeartbeat(interval)
    resubscribe()
    return
  }

  // ── Op 3: Presence Update (server → client) ───────────────────────────────
  // Delivered when a subscribed user's presence changes (via OP 6 subscription).
  // The server dispatches these as op:3, NOT op:0.
  if (op === 3) {
    const presence = d as WsPresenceEvent | undefined
    if (presence?.user_id !== undefined) {
      const uid = String(presence.user_id)
      const store = usePresenceStore.getState()
      store.setPresence(uid, normalizeStatus(presence.status))
      // Always sync custom_status_text — empty string clears a previously set status
      store.setCustomStatus(uid, presence.custom_status_text ?? '')
      store.setActiveStream(uid, normalizeActiveStream(presence.active_stream))

      // Sync mute/deafen state for users in voice channels.
      // Only act when voice_channel_id is explicitly present in the payload —
      // an absent field means the server didn't send voice state in this update,
      // so we must not touch voice channel membership.
      if (presence.voice_channel_id !== undefined) {
        const voiceChannelIdNum = Number(presence.voice_channel_id)
        if (voiceChannelIdNum !== 0) {
          const voiceStore = useVoiceStore.getState()
          const presenceStore = usePresenceStore.getState()
          const currentUserId = useAuthStore.getState().user?.id
          const channelId = String(presence.voice_channel_id)
          const selfVideo = presence.self_video ?? false

          // Track user in voice channel for sidebar display (including current user)
          // Add/update user in voice channel with mute/deafen state
          presenceStore.addUserToVoiceChannel(channelId, {
            userId: uid,
            username: presence.username ?? `User ${uid.slice(0, 6)}`,
            avatarUrl: presence.avatar_url,
            muted: presence.mute ?? false,
            deafened: presence.deafen ?? false,
            selfVideo,
          })

          // Sync mute/deafen state for other users (not ourselves)
          if (uid !== String(currentUserId ?? '')) {
            voiceStore.setPeerMuted(uid, presence.mute ?? false)
            voiceStore.setPeerDeafened(uid, presence.deafen ?? false)
            if (!selfVideo) {
              voiceStore.setPeerVideoStream(uid, null)
            }
          }
          window.dispatchEvent(new CustomEvent('ws:presence_self_video', {
            detail: {
              user_id: uid,
              voice_channel_id: channelId,
              self_video: selfVideo,
            },
          }))
        } else {
          // voice_channel_id explicitly 0 → user left voice channel
          const presenceStore = usePresenceStore.getState()
          const voiceUsers = presenceStore.voiceChannelUsers
          const wasInAnyChannel = Object.values(voiceUsers).some((users) =>
            users.some((u) => u.userId === uid)
          )
          if (wasInAnyChannel) {
            presenceStore.removeUserFromAllVoiceChannels(uid)
          }
        }
      }
    }
    return
  }

  // ── Op 0: dispatched events ───────────────────────────────────────────────
  if (op === 0) {
    // ── Message events ───────────────────────────────────────────────────────

    // t=100: Message Create (channel subscription)
    //   d = { guild_id, message: DtoMessage } — full message body present
    if (t === 100) {
      const msg = extractMessage(d)
      if (msg?.channel_id !== undefined) {
        const channelId = String(msg.channel_id)
        const currentUserId = useAuthStore.getState().user?.id
        const isOwnMessage =
          currentUserId != null &&
          msg.author?.id != null &&
          String(msg.author.id) === String(currentUserId)
        useMessageStore.getState().receiveMessage(channelId, msg)

        // Track the latest known message ID and ACK own messages — combined into
        // a single readStateStore set() to minimise React re-renders.
        if (msg.id != null) {
          useReadStateStore.getState().receiveChannelMessage(channelId, String(msg.id), isOwnMessage)
        }

        // Mark unread if this message arrived for a channel we're not currently viewing
        if (!isOwnMessage && !isChannelVisible(channelId)) {
          const guildId = (d as WsGuildMessageEvent)?.guild_id != null
            ? String((d as WsGuildMessageEvent).guild_id)
            : null
          useUnreadStore.getState().markUnread(channelId, guildId)
        }

        // Clear typing indicator for the message author (they finished typing)
        if (msg.author?.id != null) {
          useTypingStore.getState().stopTyping(channelId, String(msg.author.id))
        }
      }
      return
    }

    // t=405: User DM Message notification
    if (t === 405) {
      const notif = d as WsDmNotification | undefined
      if (notif?.channel_id != null) {
        const channelId = String(notif.channel_id)
        if (!isChannelVisible(channelId)) {
          useUnreadStore.getState().markUnread(channelId, null)
        }
        if (notif.message_id != null) {
          useReadStateStore.getState().updateLastMessage(channelId, String(notif.message_id))
        }
      }
      window.dispatchEvent(new CustomEvent('ws:dm_channel_create', { detail: d }))
      return
    }

    // t=300: Guild Channel Notification
    //   d = { guild_id, channel_id, message_id } — IDs only, NO message body.
    //   Mark the channel as unread (notification for a channel we may not be viewing).
    if (t === 300) {
      const notif = d as WsChannelNotification | undefined
      if (notif?.channel_id != null) {
        const channelId = String(notif.channel_id)
        const guildId = notif.guild_id != null ? String(notif.guild_id) : null
        if (!isChannelVisible(channelId)) {
          const notifSettings = getEffectiveNotif(guildId, channelId)
          const level = notifSettings?.notifications ?? ModelNotificationsType.NotificationsAll
          // Only show unread dot for "All Messages" level when not muted
          if (!isEffectivelyMuted(notifSettings) && level === ModelNotificationsType.NotificationsAll) {
            useUnreadStore.getState().markUnread(channelId, guildId)
          }
        }
        // Always track latest message ID for accurate read-state detection
        if (notif.message_id != null) {
          useReadStateStore.getState().updateLastMessage(channelId, String(notif.message_id))
        }
      }
      window.dispatchEvent(new CustomEvent('ws:channel_notification', { detail: notif }))
      return
    }

    // t=301: Channel Typing — user started typing in a subscribed channel
    if (t === 301) {
      const te = d as WsTypingEvent | undefined
      if (te?.channel_id != null && te?.user_id != null) {
        const channelId = String(te.channel_id)
        const userId = String(te.user_id)
        // Skip own typing events — we don't want to show ourselves as "typing"
        const me = useAuthStore.getState().user
        if (
          isChannelVisible(channelId) &&
          (me == null || String(me.id) !== userId)
        ) {
          const name = te.username ?? te.user_name ?? te.name ?? userId
          useTypingStore.getState().startTyping(channelId, userId, name)
        }
      }
      window.dispatchEvent(new CustomEvent('ws:channel_typing', { detail: d }))
      return
    }

    // t=302: Mention — the current user was @mentioned
    //   d = { guild_id, channel_id, message_id, author_id, type }
    //   Delivered on user.{userId} topic so only the mentioned user receives it.
    if (t === 302) {
      const mention = d as WsMentionEvent | undefined
      if (mention?.guild_id != null && mention?.channel_id != null && mention?.message_id != null) {
        const guildId = String(mention.guild_id)
        const channelId = String(mention.channel_id)
        // Only track & notify if user is NOT currently viewing that channel
        if (!isChannelVisible(channelId)) {
          const notifSettings = getEffectiveNotif(guildId, channelId)
          const level = notifSettings?.notifications ?? ModelNotificationsType.NotificationsAll
          const muted = isEffectivelyMuted(notifSettings)
          const suppressed = isMentionSuppressed(notifSettings, mention.type)
          if (!suppressed && !muted && level !== ModelNotificationsType.NotificationsNone) {
            useMentionStore.getState().addMention(guildId, channelId, String(mention.message_id))
            playMentionSound()
            window.electronAPI?.notify({ title: 'GoChat', body: 'You have a new mention' })
          }
        }
      }
      window.dispatchEvent(new CustomEvent('ws:mention', { detail: d }))
      return
    }

    // t=101: Message Update
    if (t === 101) {
      const msg = extractMessage(d)
      if (msg?.channel_id !== undefined) {
        useMessageStore.getState().updateMessage(String(msg.channel_id), msg)
      }
      return
    }

    // t=102: Message Delete
    if (t === 102) {
      const del = d as WsDeletedMessage | undefined
      const messageId = del?.message_id ?? del?.id
      if (del?.channel_id !== undefined && messageId !== undefined) {
        useMessageStore.getState().removeMessage(String(del.channel_id), String(messageId))
      }
      return
    }

    // t=103: Message Reaction Add
    if (t === 103) {
      const ev = d as WsReactionEvent | undefined
      if (ev?.channel_id != null && ev?.message_id != null && ev?.reaction?.emoji?.name) {
        useMessageStore.getState().updateMessageReaction(
          String(ev.channel_id),
          String(ev.message_id),
          ev.reaction,
        )
      }
      return
    }

    // t=104: Message Reaction Remove
    if (t === 104) {
      const ev = d as WsReactionEvent | undefined
      if (ev?.channel_id != null && ev?.message_id != null && ev?.reaction?.emoji?.name) {
        useMessageStore.getState().updateMessageReaction(
          String(ev.channel_id),
          String(ev.message_id),
          ev.reaction,
        )
      }
      return
    }

    // ── Guild events ─────────────────────────────────────────────────────────

    // t=105: Guild Create
    if (t === 105) {
      window.dispatchEvent(new CustomEvent('ws:guild_create', { detail: d }))
      return
    }

    // t=106: Guild Update
    if (t === 106) {
      window.dispatchEvent(new CustomEvent('ws:guild_update', { detail: d }))
      return
    }

    // t=107: Guild Delete
    if (t === 107) {
      window.dispatchEvent(new CustomEvent('ws:guild_delete', { detail: d }))
      return
    }

    // ── Channel events ───────────────────────────────────────────────────────

    // t=108: Channel Create
    if (t === 108) {
      window.dispatchEvent(new CustomEvent('ws:channel_create', { detail: d }))
      return
    }

    // t=109: Channel Update
    if (t === 109) {
      window.dispatchEvent(new CustomEvent('ws:channel_update', { detail: d }))
      return
    }

    // t=110: Channel Order changed
    if (t === 110) {
      window.dispatchEvent(new CustomEvent('ws:channel_order', { detail: d }))
      return
    }

    // t=111: Channel Delete
    if (t === 111) {
      window.dispatchEvent(new CustomEvent('ws:channel_delete', { detail: d }))
      return
    }

    // ── Guild role events ────────────────────────────────────────────────────
    // d = { guild_id, role: DtoRole }

    // t=112: Role Create
    if (t === 112) {
      window.dispatchEvent(new CustomEvent('ws:role_create', { detail: d }))
      return
    }

    // t=113: Role Update (includes position changes from order reorder)
    if (t === 113) {
      window.dispatchEvent(new CustomEvent('ws:role_update', { detail: d }))
      return
    }

    // t=114: Role Delete
    if (t === 114) {
      window.dispatchEvent(new CustomEvent('ws:role_delete', { detail: d }))
      return
    }

    // ── Thread lifecycle events ───────────────────────────────────────────────

    // t=115: Thread Create
    if (t === 115) {
      const eventData = d as WsThreadEvent | undefined
      if (isThreadChannel(eventData?.thread)) {
        useMessageStore.getState().syncThreadMetadata(eventData.thread)
      }
      window.dispatchEvent(new CustomEvent('ws:thread_create', { detail: d }))
      return
    }

    // t=116: Thread Update
    if (t === 116) {
      const eventData = d as WsThreadEvent | undefined
      if (isThreadChannel(eventData?.thread)) {
        useMessageStore.getState().syncThreadMetadata(eventData.thread)
      }
      window.dispatchEvent(new CustomEvent('ws:thread_update', { detail: d }))
      return
    }

    // t=117: Thread Delete
    if (t === 117) {
      const eventData = d as WsThreadDeleteEvent | undefined
      if (eventData?.thread_id != null) {
        const threadId = String(eventData.thread_id)
        useMessageStore.getState().removeThreadMetadata(threadId)
        useMessageStore.getState().removeChannelMessages(threadId)
        useUnreadStore.getState().removeChannel(threadId)
        useMentionStore.getState().clearChannel(threadId)
        useReadStateStore.getState().removeChannel(threadId)
      }
      window.dispatchEvent(new CustomEvent('ws:thread_delete', { detail: d }))
      return
    }

    // ── Guild emoji events ───────────────────────────────────────────────────

    // t=118: Guild Emoji Create — emoji upload finalized and ready
    //   d = { emoji: { id, guild_id, name, animated } }
    if (t === 118) {
      const data = d as { emoji?: { id?: string; guild_id?: string; name?: string; animated?: boolean } } | undefined
      if (data?.emoji?.id && data.emoji.guild_id && data.emoji.name) {
        useEmojiStore.getState().addEmoji({
          id: String(data.emoji.id),
          guild_id: String(data.emoji.guild_id),
          name: data.emoji.name,
          animated: data.emoji.animated,
        })
      }
      window.dispatchEvent(new CustomEvent('ws:emoji_create', { detail: d }))
      return
    }

    // t=119: Guild Emoji Update — emoji renamed
    //   d = { emoji: { id, guild_id, name, animated } }
    if (t === 119) {
      const data = d as { emoji?: { id?: string; guild_id?: string; name?: string; animated?: boolean } } | undefined
      if (data?.emoji?.id && data.emoji.guild_id && data.emoji.name) {
        useEmojiStore.getState().updateEmoji({
          id: String(data.emoji.id),
          guild_id: String(data.emoji.guild_id),
          name: data.emoji.name,
          animated: data.emoji.animated,
        })
      }
      window.dispatchEvent(new CustomEvent('ws:emoji_update', { detail: d }))
      return
    }

    // t=120: Guild Emoji Delete — emoji removed
    //   d = { guild_id, emoji_id }
    if (t === 120) {
      const data = d as { guild_id?: string | number; emoji_id?: string | number } | undefined
      if (data?.guild_id != null && data?.emoji_id != null) {
        useEmojiStore.getState().removeEmoji(String(data.guild_id), String(data.emoji_id))
      }
      window.dispatchEvent(new CustomEvent('ws:emoji_delete', { detail: d }))
      return
    }

    // ── Guild member events ──────────────────────────────────────────────────
    // NOTE: t=200/201 are Guild Member events, NOT presence updates.
    //       Presence changes have no t field and are handled above.

    // t=200: Guild Member Added
    if (t === 200) {
      window.dispatchEvent(new CustomEvent('ws:member_added', { detail: d }))
      return
    }

    // t=201: Guild Member Updated
    if (t === 201) {
      window.dispatchEvent(new CustomEvent('ws:member_updated', { detail: d }))
      return
    }

    // t=202: Guild Member Removed
    if (t === 202) {
      window.dispatchEvent(new CustomEvent('ws:member_removed', { detail: d }))
      return
    }

    // t=203: Guild Member Role Added
    if (t === 203) {
      window.dispatchEvent(new CustomEvent('ws:member_role_added', { detail: d }))
      return
    }

    // t=204: Guild Member Role Removed
    if (t === 204) {
      window.dispatchEvent(new CustomEvent('ws:member_role_removed', { detail: d }))
      return
    }

    // ── Voice member events ──────────────────────────────────────────────────

    // t=205: Guild Member Join Voice
    if (t === 205) {
      const eventData = d as { user_id?: string | number; channel_id?: string | number; username?: string; avatar_url?: string; mute?: boolean; deafen?: boolean } | undefined
      if (eventData?.user_id !== undefined && eventData?.channel_id !== undefined) {
        const userId = String(eventData.user_id)
        const channelId = String(eventData.channel_id)
        usePresenceStore.getState().addUserToVoiceChannel(channelId, {
          userId,
          username: eventData.username ?? `User ${userId.slice(0, 6)}`,
          avatarUrl: eventData.avatar_url,
          muted: eventData.mute ?? false,
          deafened: eventData.deafen ?? false,
        })
      }
      window.dispatchEvent(new CustomEvent('ws:member_join_voice', { detail: d }))
      return
    }

    // t=206: Guild Member Leave Voice
    if (t === 206) {
      const eventData = d as { user_id?: string | number; channel_id?: string | number } | undefined
      if (eventData?.user_id !== undefined && eventData?.channel_id !== undefined) {
        const userId = String(eventData.user_id)
        const channelId = String(eventData.channel_id)
        usePresenceStore.getState().removeUserFromVoiceChannel(channelId, userId)
      }
      window.dispatchEvent(new CustomEvent('ws:member_leave_voice', { detail: d }))
      return
    }

    // t=207: Guild Member Moderation
    if (t === 207) {
      window.dispatchEvent(new CustomEvent('ws:member_moderation', { detail: d }))
      return
    }

    // t=208: Voice Region Changing (pre-rebind notification)
    if (t === 208) {
      window.dispatchEvent(new CustomEvent('ws:voice_region_changing', { detail: d }))
      return
    }

    // t=209: Voice State Update — mute/deafen state changed for a user
    if (t === 209) {
      const voiceState = d as { user_id?: string | number; channel_id?: string | number; mute?: boolean; deafen?: boolean; username?: string; avatar_url?: string } | undefined
      if (voiceState?.user_id !== undefined && voiceState?.channel_id !== undefined) {
        const userId = String(voiceState.user_id)
        const channelId = String(voiceState.channel_id)
        // Update voice store for peer state
        useVoiceStore.getState().setPeerMuted(userId, voiceState.mute ?? false)
        useVoiceStore.getState().setPeerDeafened(userId, voiceState.deafen ?? false)
        // Update presence store for sidebar display
        usePresenceStore.getState().addUserToVoiceChannel(channelId, {
          userId,
          username: voiceState.username ?? `User ${userId.slice(0, 6)}`,
          avatarUrl: voiceState.avatar_url,
          muted: voiceState.mute ?? false,
          deafened: voiceState.deafen ?? false,
        })
      }
      window.dispatchEvent(new CustomEvent('ws:voice_state_update', { detail: d }))
      return
    }

    // t=210: Guild Member Start Stream
    if (t === 210) {
      const eventData = d as {
        guild_id?: string | number
        channel_id?: string | number
        user_id?: string | number
        stream?: {
          id?: string | number
          channel_id?: string | number
          source_type?: 'screen' | 'application'
          audio_mode?: 'desktop' | 'application' | 'none'
          started_at?: number
        }
      } | undefined
      if (eventData?.stream?.id != null && eventData.user_id != null && eventData.channel_id != null) {
        useStreamStore.getState().upsertChannelStream({
          id: String(eventData.stream.id),
          ownerUserId: String(eventData.user_id),
          channelId: String(eventData.channel_id),
          sourceType: eventData.stream.source_type ?? 'screen',
          audioMode: eventData.stream.audio_mode ?? 'none',
          startedAt: Number(eventData.stream.started_at ?? 0),
        })
        usePresenceStore.getState().setActiveStream(String(eventData.user_id), {
          id: String(eventData.stream.id),
          channelId: String(eventData.channel_id),
          sourceType: eventData.stream.source_type ?? 'screen',
          audioMode: eventData.stream.audio_mode ?? 'none',
          startedAt: Number(eventData.stream.started_at ?? 0),
        })
      }
      window.dispatchEvent(new CustomEvent('ws:member_start_stream', { detail: d }))
      return
    }

    // t=211: Guild Member Stop Stream
    if (t === 211) {
      const eventData = d as {
        channel_id?: string | number
        user_id?: string | number
        stream_id?: string | number
      } | undefined
      if (eventData?.channel_id != null && eventData?.stream_id != null) {
        useStreamStore.getState().removeChannelStream(
          String(eventData.channel_id),
          String(eventData.stream_id),
        )
      }
      if (eventData?.user_id != null) {
        usePresenceStore.getState().setActiveStream(String(eventData.user_id), null)
      }
      window.dispatchEvent(new CustomEvent('ws:member_stop_stream', { detail: d }))
      return
    }

    // t=212: Guild Streams Rebind
    if (t === 212) {
      window.dispatchEvent(new CustomEvent('ws:member_stream_rebind', { detail: d }))
      return
    }

    // ── Friend / DM events ───────────────────────────────────────────────────

    // t=402: Incoming friend request
    if (t === 402) {
      window.dispatchEvent(new CustomEvent('ws:friend_request', { detail: d }))
      return
    }

    // t=403: Friend added (request accepted)
    if (t === 403) {
      window.dispatchEvent(new CustomEvent('ws:friend_added', { detail: d }))
      return
    }

    // t=404: Friend removed
    if (t === 404) {
      window.dispatchEvent(new CustomEvent('ws:friend_removed', { detail: d }))
      return
    }

    // ── User events ──────────────────────────────────────────────────────────

    // t=400: User Read State Update
    // d = { channel_id, last_read_message_id } — sync from another client session
    if (t === 400) {
      const rs = d as {
        channel_id?: string | number
        last_read_message_id?: string | number
        message_id?: string | number
      } | undefined
      const messageId = rs?.message_id ?? rs?.last_read_message_id
      if (rs?.channel_id != null && messageId != null) {
        useReadStateStore.getState().setReadState(
          String(rs.channel_id),
          String(messageId),
        )
      }
      window.dispatchEvent(new CustomEvent('ws:read_state_update', { detail: d }))
      return
    }

    // t=401: User Settings Update
    if (t === 401) {
      window.dispatchEvent(new CustomEvent('ws:user_settings_update', { detail: d }))
      return
    }

    // t=406: User Profile Update
    if (t === 406) {
      window.dispatchEvent(new CustomEvent('ws:user_update', { detail: d }))
      return
    }
  }

  // ── Op 7: RTC events (dispatched by the WS gateway, not the SFU) ─────────
  if (op === 7) {
    // t=509: RTCBindingAlive is client→server only; no handler needed server-side.

    // t=512: RTC Moved — admin moved the user to a different voice channel.
    // d = { channel, sfu_url, sfu_token } — client must disconnect old SFU and reconnect.
    if (t === 512) {
      window.dispatchEvent(new CustomEvent('ws:rtc_moved', { detail: d }))
      return
    }

    // t=513: Server Rebind — SFU region migration; client must call JoinVoice again.
    if (t === 513) {
      window.dispatchEvent(new CustomEvent('ws:rtc_rebind', { detail: d }))
      return
    }
  }
}

// ── Socket lifecycle ──────────────────────────────────────────────────────────

function createSocket(token: string) {
  // Reset auth-tracking state for the new socket
  authSucceeded = false
  socketOpenTime = null

  // Close any existing socket without triggering the reconnect path
  if (socket) {
    socket.removeEventListener('close', onClose)
    socket.close()
    socket = null
  }
  clearHeartbeat()

  socket = new WebSocket(getWsUrl())
  socket.addEventListener('message', handleMessage)
  socket.addEventListener('close', onClose)
  socket.addEventListener('open', () => {
    socketOpenTime = Date.now()
    // Op 1: authenticate.  Include the previous session_id (if any) so the
    // server can reuse the presence session instead of publishing offline→online.
    const helloData: Record<string, unknown> = { token }
    if (currentSessionId) helloData.heartbeat_session_id = currentSessionId
    socket!.send(JSON.stringify({ op: 1, d: helloData }))
  })
}

function onClose() {
  clearHeartbeat()
  socket = null

  const openTime = socketOpenTime
  socketOpenTime = null

  if (intentionalClose) return
  if (isNetworkOffline) return  // 'online' event will trigger reconnect

  if (!authSucceeded) {
    // Socket closed before op:1 was received.
    // A close within AUTH_QUICK_CLOSE_MS of the TCP open strongly indicates
    // the server rejected the token (expired access token).
    // For a slow close (server restart mid-handshake) fall through to normal backoff.
    const wasQuickClose = openTime !== null && (Date.now() - openTime) < AUTH_QUICK_CLOSE_MS
    if (wasQuickClose || openTime === null) {
      // Likely auth failure — refresh the token then reconnect
      void refreshTokenAndReconnect()
      return
    }
  }

  // Normal network-level disconnect — reconnect with exponential backoff
  scheduleReconnect()
}

// ── Browser connectivity & visibility recovery ────────────────────────────────
//
// These listeners are attached once at module-load time and remain active for
// the lifetime of the page.  The intentionalClose / currentToken guards ensure
// they are no-ops when the user is logged out.

if (typeof window !== 'undefined') {
  // Network went away — stop burning the reconnect backoff budget
  window.addEventListener('offline', () => {
    isNetworkOffline = true
    clearReconnectTimer()
    clearHeartbeat()
    // Leave a live socket alone; it will close on its own and onClose will bail
    // out because isNetworkOffline is true.
  })

  // Network restored — reconnect immediately with a validated token
  window.addEventListener('online', () => {
    isNetworkOffline = false
    if (!intentionalClose && currentToken && socket?.readyState !== WebSocket.OPEN) {
      clearReconnectTimer()
      reconnectDelay = 1_000
      void refreshTokenAndReconnect()
    }
  })

  // Tab became visible — if the socket died while in the background, reconnect
  // right away and validate the token (it may have expired during suspension)
  document.addEventListener('visibilitychange', () => {
    if (
      !document.hidden &&
      !intentionalClose &&
      currentToken &&
      socket?.readyState !== WebSocket.OPEN
    ) {
      clearReconnectTimer()
      reconnectDelay = 1_000
      void refreshTokenAndReconnect()
    }
  })
}

// ── Public API ────────────────────────────────────────────────────────────────

export function connect(token: string) {
  intentionalClose = false
  currentToken = token
  resetReconnectDelay()
  clearReconnectTimer()
  createSocket(token)
}

// Update the module-level reconnect token without touching the live socket.
// Called by useWebSocket when the 401 interceptor silently renews the access
// token so that the next auto-reconnect (on network drop) uses the fresh token.
export function updateToken(newToken: string) {
  currentToken = newToken
}

// Subscribe to guild-level events (op=5, d.guilds).
// IDs are sent as int64 BigInt so Go can decode them.
export function subscribeGuilds(guildIds: string[]) {
  for (const id of guildIds) activeGuildSubs.add(id)
  if (socket?.readyState === WebSocket.OPEN && guildIds.length > 0) {
    sendJson({ op: 5, d: { guilds: guildIds.map((id) => BigInt(id)) } })
  }
}

// Subscribe to a single channel's message stream.
// OP 5 channel subscriptions are an exact set, so every change re-sends the
// complete `channels` list for this connection.
export function subscribeChannel(channelId: string) {
  const nextCount = (explicitChannelCounts.get(channelId) ?? 0) + 1
  explicitChannelCounts.set(channelId, nextCount)
  if (nextCount === 1) {
    syncChannelSubscriptions()
  }
}

export function unsubscribeChannel(channelId: string) {
  const currentCount = explicitChannelCounts.get(channelId) ?? 0
  if (currentCount <= 1) {
    explicitChannelCounts.delete(channelId)
    if (!visibleChannelCounts.has(channelId)) {
      syncChannelSubscriptions()
    }
    return
  }
  explicitChannelCounts.set(channelId, currentCount - 1)
}

export function activateChannel(channelId: string) {
  const nextCount = (visibleChannelCounts.get(channelId) ?? 0) + 1
  visibleChannelCounts.set(channelId, nextCount)
  if (nextCount === 1 && !explicitChannelCounts.has(channelId)) {
    syncChannelSubscriptions()
  }
}

export function deactivateChannel(channelId: string) {
  const currentCount = visibleChannelCounts.get(channelId) ?? 0
  if (currentCount <= 1) {
    visibleChannelCounts.delete(channelId)
    if (!explicitChannelCounts.has(channelId)) {
      syncChannelSubscriptions()
    }
    return
  }
  visibleChannelCounts.set(channelId, currentCount - 1)
}

// Replace the full presence subscription set (op=6, d.set).
// IDs sent as int64 BigInt.
export function subscribePresence(userIds: string[]) {
  for (const id of userIds) activePresenceSubs.add(id)
  if (socket?.readyState === WebSocket.OPEN && userIds.length > 0) {
    sendJson({ op: 6, d: { set: [...activePresenceSubs].map((id) => BigInt(id)) } })
  }
}

// Add new users to the presence subscription without replacing the existing set (op=6, d.add).
// No-op for IDs already subscribed.
export function addPresenceSubscription(userIds: string[]) {
  const newIds = userIds.filter((id) => !activePresenceSubs.has(id))
  if (newIds.length === 0) return
  for (const id of newIds) activePresenceSubs.add(id)
  if (socket?.readyState === WebSocket.OPEN) {
    sendJson({ op: 6, d: { add: newIds.map((id) => BigInt(id)) } })
  }
}

// Broadcast our own presence status (op=3).
// Pass customStatusText to update it; omit (undefined) to keep the current value.
export function sendPresenceStatus(status: UserStatus, customStatusText?: string) {
  currentOwnStatus = status
  if (customStatusText !== undefined) currentCustomStatusText = customStatusText
  if (socket?.readyState === WebSocket.OPEN) {
    sendJson({
      op: 3,
      d: {
        status,
        platform: 'web',
        ...(currentCustomStatusText ? { custom_status_text: currentCustomStatusText } : {}),
        ...(currentVoiceChannelId ? { voice_channel_id: BigInt(currentVoiceChannelId) } : {}),
        self_video: currentSelfVideo,
      },
    })
  }
}

// Update the tracked voice channel for presence broadcasts.
// Call with null when leaving voice — the next sendPresenceStatus will omit voice_channel_id.
export function setPresenceVoiceChannel(channelId: string | null) {
  currentVoiceChannelId = channelId
}

// Update the tracked local camera state for presence broadcasts.
export function setPresenceSelfVideo(enabled: boolean) {
  currentSelfVideo = enabled
}

// Send a raw message with BigInt-aware serialization (used by voice service for SFU signalling).
export function sendRaw(data: unknown) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(_bigJsonStringify(data))
  }
}

// Legacy helper kept for backward compatibility (voice service etc.)
export function subscribe(guildIds: string[], channelIds: string[]) {
  for (const id of guildIds) activeGuildSubs.add(id)
  let channelsChanged = false
  for (const id of channelIds) {
    const nextCount = (explicitChannelCounts.get(id) ?? 0) + 1
    explicitChannelCounts.set(id, nextCount)
    channelsChanged ||= nextCount === 1
  }
  if (socket?.readyState !== WebSocket.OPEN) return
  if (guildIds.length > 0) {
    sendJson({ op: 5, d: { guilds: guildIds.map((id) => BigInt(id)) } })
  }
  if (channelsChanged) {
    syncChannelSubscriptions()
  }
}

export function disconnect() {
  intentionalClose = true
  currentToken = null
  currentSessionId = null
  lastEventId = 0
  activeGuildSubs.clear()
  explicitChannelCounts.clear()
  visibleChannelCounts.clear()
  activePresenceSubs.clear()
  clearReconnectTimer()
  clearHeartbeat()
  if (socket) {
    socket.removeEventListener('close', onClose)
    socket.close()
    socket = null
  }
  // Dispose the worker on logout so it doesn't linger after the user signs out.
  // A new worker is created lazily on the next connect().
  if (heartbeatWorker) {
    heartbeatWorker.postMessage({ type: 'dispose' })
    heartbeatWorker = null
  }
}
