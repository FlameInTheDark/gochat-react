import { create } from 'zustand'
import { messageApi } from '@/api/client'
import { useUnreadStore } from './unreadStore'
import type { UserUserSettingsResponse } from '@/client'

interface ReadStateStore {
  /** Last ACKed message ID per channel (from settings.read_states). */
  readStates: Record<string, string>
  /** Latest known message ID per channel (from settings.guilds_last_messages + WS). */
  lastMessages: Record<string, string>

  /** Populate both maps from the settings API response and seed unreadStore. */
  setFromSettings: (res: UserUserSettingsResponse) => void
  /** Update the latest-known message ID for a channel (called from WS events). */
  updateLastMessage: (channelId: string, messageId: string) => void
  /** Update local read state from a server-side read-state push (WS t=400). */
  setReadState: (channelId: string, messageId: string) => void
  /** ACK a channel: debounces the API call 800 ms, updates store, marks visual read. */
  ackChannel: (channelId: string, messageId: string) => void
  /** True if the channel has messages newer than the last ACK. */
  isUnread: (channelId: string) => boolean
}

// Debounce map: only the most-recent ACK per channel fires after 800 ms idle.
const pendingAcks = new Map<string, ReturnType<typeof setTimeout>>()

export const useReadStateStore = create<ReadStateStore>((set, get) => ({
  readStates: {},
  lastMessages: {},

  setFromSettings: (res) => {
    // Normalise read_states (values are already strings via JSONBig storeAsString)
    const readStates: Record<string, string> = {}
    for (const [k, v] of Object.entries(res.read_states ?? {})) {
      readStates[k] = String(v)
    }

    // Flatten guilds_last_messages: { guildId → { channelId → msgId } }
    const lastMessages: Record<string, string> = {}
    const glm = res.guilds_last_messages ?? {}
    for (const channelMap of Object.values(glm)) {
      for (const [chId, msgId] of Object.entries(channelMap)) {
        lastMessages[chId] = String(msgId)
      }
    }

    set({ readStates, lastMessages })

    // Seed the visual unread store from the diff
    const unread = useUnreadStore.getState()
    for (const [guildId, channelMap] of Object.entries(glm)) {
      for (const [channelId, lastMsgId] of Object.entries(channelMap)) {
        const lastRead = readStates[channelId]
        let isUnread = false
        try {
          isUnread = !lastRead || BigInt(lastRead) < BigInt(lastMsgId)
        } catch { /* ignore BigInt parse errors for non-numeric IDs */ }
        if (isUnread) unread.markUnread(channelId, guildId)
      }
    }
  },

  updateLastMessage: (channelId, messageId) => {
    const current = get().lastMessages[channelId]
    try {
      if (!current || BigInt(messageId) > BigInt(current)) {
        set((s) => ({ lastMessages: { ...s.lastMessages, [channelId]: messageId } }))
      }
    } catch { /* ignore */ }
  },

  setReadState: (channelId, messageId) => {
    set((s) => ({ readStates: { ...s.readStates, [channelId]: messageId } }))
    useUnreadStore.getState().markRead(channelId)
  },

  ackChannel: (channelId, messageId) => {
    // Cancel any pending ACK and restart the timer with the latest messageId
    const pending = pendingAcks.get(channelId)
    if (pending !== undefined) clearTimeout(pending)

    pendingAcks.set(
      channelId,
      setTimeout(() => {
        pendingAcks.delete(channelId)

        // Optimistic local update
        set((s) => ({ readStates: { ...s.readStates, [channelId]: messageId } }))
        useUnreadStore.getState().markRead(channelId)

        // Fire-and-forget server ACK
        void messageApi
          .messageChannelChannelIdMessageIdAckPost({ channelId, messageId })
          .catch(() => {/* silently ignore transient errors */})
      }, 800),
    )
  },

  isUnread: (channelId) => {
    const { readStates, lastMessages } = get()
    const lastRead = readStates[channelId]
    const lastMsg = lastMessages[channelId]
    if (!lastMsg) return false
    if (!lastRead) return true
    try { return BigInt(lastRead) < BigInt(lastMsg) } catch { return false }
  },
}))
