import JSONBig from 'json-bigint'
import { useMessageStore } from '@/stores/messageStore'
import { usePresenceStore, type UserStatus } from '@/stores/presenceStore'
import { useUnreadStore } from '@/stores/unreadStore'
import { useTypingStore } from '@/stores/typingStore'
import { useReadStateStore } from '@/stores/readStateStore'
import type { DtoMessage } from '@/types'

// Resolve the WebSocket URL lazily at connection time.
// If the env var is a relative path (e.g. "/ws/subscribe"), expand it
// against the current host so the Vite dev proxy can handle it.
function getWsUrl(): string {
  const raw: string = import.meta.env.VITE_WEBSOCKET_URL ?? '/ws/subscribe'
  if (raw.startsWith('ws://') || raw.startsWith('wss://')) return raw
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${raw}`
}

// BigInt-aware serializer for outgoing WS messages that contain Snowflake IDs.
// The Go backend expects int64 numbers — plain JSON.stringify emits quoted strings
// for BigInt which Go cannot decode into int64.
const _bigJsonStringify = JSONBig({ useNativeBigInt: true })

// BigInt-safe parser for incoming WS messages.
// storeAsString: true keeps large integers as strings, consistent with the API
// client (json-bigint storeAsString mode) so all String() calls below are safe.
const _bigJsonParse = JSONBig({ storeAsString: true })

let socket: WebSocket | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

// Reconnect state
let currentToken: string | null = null
let intentionalClose = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1_000 // ms — doubles each attempt, capped at 30 s
const MAX_RECONNECT_DELAY = 30_000

// Active subscriptions — restored after every reconnect
const activeGuildSubs = new Set<string>()
let activeChannelSub: string | null = null
const activePresenceSubs = new Set<string>()

// Own status kept in sync with presenceStore.ownStatus
let currentOwnStatus: UserStatus = 'online'
// Custom status text included in every op:3 presence broadcast
let currentCustomStatusText = ''

// Last event sequence ID received — echoed back in heartbeats (op:2, d.e)
let lastEventId = 0

// Session ID from the most recent Hello reply.
// Passed as heartbeat_session_id on reconnect so the server reuses the
// existing presence session, avoiding spurious offline→online transitions.
let currentSessionId: string | null = null

// ── Helpers ──────────────────────────────────────────────────────────────────

// All outgoing messages that contain Snowflake IDs must go through sendJson so
// they are serialised with BigInt support.  Plain JSON.stringify turns BigInt
// values into quoted strings; the Go backend cannot decode those as int64.
function sendJson(data: unknown) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(_bigJsonStringify.stringify(data))
  }
}

function clearHeartbeat() {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function sendHeartbeat() {
  if (socket?.readyState === WebSocket.OPEN) {
    // op=2: Heartbeat — echo the last event ID we've processed.
    // The server resets its timeout timer only if e >= its internal counter.
    socket.send(JSON.stringify({ op: 2, d: { e: lastEventId } }))
  }
}

function startHeartbeat(intervalMs: number) {
  clearHeartbeat()
  heartbeatTimer = setInterval(sendHeartbeat, intervalMs)
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
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

// Re-apply all active subscriptions after a reconnect (called from hello handler)
function resubscribe() {
  if (socket?.readyState !== WebSocket.OPEN) return

  if (activeGuildSubs.size > 0) {
    sendJson({ op: 5, d: { guilds: [...activeGuildSubs].map((id) => BigInt(id)) } })
  }
  if (activeChannelSub) {
    sendJson({ op: 5, d: { channel: BigInt(activeChannelSub) } })
  }

  // Re-send own presence status (with custom text if set)
  sendJson({
    op: 3,
    d: {
      status: currentOwnStatus,
      platform: 'web',
      ...(currentCustomStatusText ? { custom_status_text: currentCustomStatusText } : {}),
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
}

// t=100 / t=405: actual message event — d = { guild_id, message: DtoMessage }
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

// Presence dispatch payload — server sends as op:3 (not op:0)
interface WsPresenceEvent {
  user_id?: string | number
  status?: string
  custom_status_text?: string
  since?: number
  voice_channel_id?: string | number
  client_status?: Record<string, string>
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
    }
    return
  }

  // ── Op 0: dispatched events ───────────────────────────────────────────────
  if (op === 0) {
    // ── Message events ───────────────────────────────────────────────────────

    // t=100: Message Create (channel subscription)
    //   d = { guild_id, message: DtoMessage } — full message body present
    // t=405: User DM Message — same shape as t=100
    if (t === 100 || t === 405) {
      const msg = extractMessage(d)
      if (msg?.channel_id !== undefined) {
        const channelId = String(msg.channel_id)
        useMessageStore.getState().addMessage(channelId, msg)

        // Track the latest known message ID for this channel
        if (msg.id != null) {
          useReadStateStore.getState().updateLastMessage(channelId, String(msg.id))
        }

        // Mark unread if this message arrived for a channel we're not currently viewing
        if (activeChannelSub !== channelId) {
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
      // For DM messages also signal the DM sidebar to refresh its channel list
      if (t === 405) {
        window.dispatchEvent(new CustomEvent('ws:dm_channel_create', { detail: d }))
      }
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
        useUnreadStore.getState().markUnread(channelId, guildId)
        // Update the latest-known message ID so unread detection stays accurate
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
        const name = te.username ?? te.user_name ?? te.name ?? userId
        useTypingStore.getState().startTyping(channelId, userId, name)
      }
      window.dispatchEvent(new CustomEvent('ws:channel_typing', { detail: d }))
      return
    }

    // t=302: Mention — the current user was @mentioned
    if (t === 302) {
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
      if (del?.channel_id !== undefined && del?.id !== undefined) {
        useMessageStore.getState().removeMessage(String(del.channel_id), String(del.id))
      }
      return
    }

    // ── Guild events ─────────────────────────────────────────────────────────

    // t=103: Guild Create
    if (t === 103) {
      window.dispatchEvent(new CustomEvent('ws:guild_create', { detail: d }))
      return
    }

    // t=104: Guild Update
    if (t === 104) {
      window.dispatchEvent(new CustomEvent('ws:guild_update', { detail: d }))
      return
    }

    // t=105: Guild Delete
    if (t === 105) {
      window.dispatchEvent(new CustomEvent('ws:guild_delete', { detail: d }))
      return
    }

    // ── Channel events ───────────────────────────────────────────────────────

    // t=106: Channel Create
    if (t === 106) {
      window.dispatchEvent(new CustomEvent('ws:channel_create', { detail: d }))
      return
    }

    // t=107: Channel Update
    if (t === 107) {
      window.dispatchEvent(new CustomEvent('ws:channel_update', { detail: d }))
      return
    }

    // t=108: Channel Order changed
    if (t === 108) {
      window.dispatchEvent(new CustomEvent('ws:channel_order', { detail: d }))
      return
    }

    // t=109: Channel Delete
    if (t === 109) {
      window.dispatchEvent(new CustomEvent('ws:channel_delete', { detail: d }))
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
      window.dispatchEvent(new CustomEvent('ws:member_join_voice', { detail: d }))
      return
    }

    // t=206: Guild Member Leave Voice
    if (t === 206) {
      window.dispatchEvent(new CustomEvent('ws:member_leave_voice', { detail: d }))
      return
    }

    // t=208: Voice Region Changing (pre-rebind notification)
    if (t === 208) {
      window.dispatchEvent(new CustomEvent('ws:voice_region_changing', { detail: d }))
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
      const rs = d as { channel_id?: string | number; last_read_message_id?: string | number } | undefined
      if (rs?.channel_id != null && rs?.last_read_message_id != null) {
        useReadStateStore.getState().setReadState(
          String(rs.channel_id),
          String(rs.last_read_message_id),
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
  scheduleReconnect()
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

// Subscribe to a single channel's message stream (op=5, d.channel).
// ID is sent as int64 BigInt.
export function subscribeChannel(channelId: string) {
  activeChannelSub = channelId
  if (socket?.readyState === WebSocket.OPEN) {
    sendJson({ op: 5, d: { channel: BigInt(channelId) } })
  }
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
      },
    })
  }
}

// Send a raw message with BigInt-aware serialization (used by voice service for SFU signalling).
export function sendRaw(data: unknown) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(_bigJsonStringify.stringify(data))
  }
}

// Notify the server that the current user is typing in a channel (op=4).
// The caller is responsible for rate-limiting (e.g., once per 3 s).
export function sendTyping(channelId: string) {
  sendJson({ op: 4, d: { channel: BigInt(channelId) } })
}

// Legacy helper kept for backward compatibility (voice service etc.)
export function subscribe(guildIds: string[], channelIds: string[]) {
  for (const id of guildIds) activeGuildSubs.add(id)
  for (const id of channelIds) activeChannelSub = id // last one wins
  if (socket?.readyState !== WebSocket.OPEN) return
  if (guildIds.length > 0) {
    sendJson({ op: 5, d: { guilds: guildIds.map((id) => BigInt(id)) } })
  }
  for (const ch of channelIds) {
    sendJson({ op: 5, d: { channel: BigInt(ch) } })
  }
}

export function disconnect() {
  intentionalClose = true
  currentToken = null
  currentSessionId = null
  lastEventId = 0
  activeGuildSubs.clear()
  activeChannelSub = null
  activePresenceSubs.clear()
  clearReconnectTimer()
  clearHeartbeat()
  if (socket) {
    socket.removeEventListener('close', onClose)
    socket.close()
    socket = null
  }
}
