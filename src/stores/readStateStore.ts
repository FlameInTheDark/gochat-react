import { create } from 'zustand'
import { messageApi } from '@/api/client'
import { useUnreadStore } from './unreadStore'
import { useMentionStore } from './mentionStore'
import type { UserUserSettingsResponse } from '@/client'
import { compareSnowflakes, maxSnowflake } from '@/lib/snowflake'

interface ReadStateStore {
  /** Last ACKed message ID per channel (from settings.read_states). */
  readStates: Record<string, string>
  /** Latest known message ID per channel (from settings snapshots + WS). */
  lastMessages: Record<string, string>

  /** Populate both maps from the settings API response and seed unreadStore. */
  setFromSettings: (res: UserUserSettingsResponse) => void
  /** Update the latest-known message ID for a channel (called from WS events). */
  updateLastMessage: (channelId: string, messageId: string) => void
  /**
   * Combined update for WS t=100 — updates lastMessages and optionally readStates
   * in a SINGLE set() call so React only schedules one re-render instead of two.
   */
  receiveChannelMessage: (channelId: string, messageId: string, ackAsRead: boolean) => void
  /** Update local read state from a server-side read-state push (WS t=400). */
  setReadState: (channelId: string, messageId: string) => void
  /** ACK a channel: updates local state immediately and debounces the API call 800 ms. */
  ackChannel: (channelId: string, messageId: string) => void
  /** Remove local state for a deleted/removed channel. */
  removeChannel: (channelId: string) => void
  /** True if the channel has messages newer than the last ACK. */
  isUnread: (channelId: string) => boolean
}

// Debounce map: only the most-recent ACK per channel fires after 800 ms idle.
const pendingAcks = new Map<string, ReturnType<typeof setTimeout>>()

function hasUnreadMessages(lastReadId: string | undefined, lastMessageId: string | undefined): boolean {
  if (!lastMessageId) return false
  if (!lastReadId) return true
  return compareSnowflakes(lastReadId, lastMessageId) < 0
}

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
    for (const [threadId, msgId] of Object.entries(res.threads_last_messages ?? {})) {
      lastMessages[threadId] = String(msgId)
    }

    set({ readStates, lastMessages })

    // Seed the visual unread store from the diff
    const unreadChannels = new Map<string, { guildId: string | null }>()
    for (const [guildId, channelMap] of Object.entries(glm)) {
      for (const [channelId, lastMsgId] of Object.entries(channelMap)) {
        const lastRead = readStates[channelId]
        if (hasUnreadMessages(lastRead, String(lastMsgId))) {
          unreadChannels.set(channelId, { guildId })
        }
      }
    }
    for (const [threadId, lastMsgId] of Object.entries(res.threads_last_messages ?? {})) {
      const lastRead = readStates[threadId]
      if (hasUnreadMessages(lastRead, String(lastMsgId))) {
        unreadChannels.set(threadId, { guildId: null })
      }
    }
    useUnreadStore.getState().replaceChannels(unreadChannels)
  },

  updateLastMessage: (channelId, messageId) => {
    const current = get().lastMessages[channelId]
    if (compareSnowflakes(messageId, current) > 0) {
      set((s) => ({ lastMessages: { ...s.lastMessages, [channelId]: messageId } }))
    }
  },

  receiveChannelMessage: (channelId, messageId, ackAsRead) => {
    const { lastMessages, readStates } = get()
    const shouldUpdateLast = compareSnowflakes(messageId, lastMessages[channelId]) > 0

    if (ackAsRead) {
      const currentReadState = readStates[channelId]
      const nextMessageId = maxSnowflake(currentReadState, messageId) ?? messageId
      if (compareSnowflakes(nextMessageId, currentReadState) > 0) {
        // Single set() for both lastMessages and readStates
        set((s) => ({
          lastMessages: shouldUpdateLast
            ? { ...s.lastMessages, [channelId]: messageId }
            : s.lastMessages,
          readStates: {
            ...s.readStates,
            [channelId]: maxSnowflake(s.readStates[channelId], nextMessageId) ?? nextMessageId,
          },
        }))
        useUnreadStore.getState().markRead(channelId)
        useMentionStore.getState().clearMentionsUpTo(channelId, nextMessageId)

        const pending = pendingAcks.get(channelId)
        if (pending !== undefined) clearTimeout(pending)
        pendingAcks.set(
          channelId,
          setTimeout(() => {
            pendingAcks.delete(channelId)
            void messageApi
              .messageChannelChannelIdMessageIdAckPost({
                channelId: channelId as unknown as number,
                messageId: nextMessageId as unknown as number,
              })
              .catch(() => {/* silently ignore transient errors */})
          }, 800),
        )
        return
      }
    }

    if (shouldUpdateLast) {
      set((s) => ({ lastMessages: { ...s.lastMessages, [channelId]: messageId } }))
    }
  },

  setReadState: (channelId, messageId) => {
    const nextMessageId = maxSnowflake(get().readStates[channelId], messageId) ?? String(messageId)
    if (compareSnowflakes(nextMessageId, get().readStates[channelId]) > 0) {
      set((s) => ({ readStates: { ...s.readStates, [channelId]: nextMessageId } }))
    }
    useUnreadStore.getState().markRead(channelId)
    useMentionStore.getState().clearMentionsUpTo(channelId, nextMessageId)
  },

  ackChannel: (channelId, messageId) => {
    const currentReadState = get().readStates[channelId]
    const nextMessageId = maxSnowflake(currentReadState, messageId) ?? String(messageId)
    if (compareSnowflakes(nextMessageId, currentReadState) <= 0) {
      return
    }

    set((s) => ({
      readStates: {
        ...s.readStates,
        [channelId]: maxSnowflake(s.readStates[channelId], nextMessageId) ?? nextMessageId,
      },
    }))
    useUnreadStore.getState().markRead(channelId)
    useMentionStore.getState().clearMentionsUpTo(channelId, nextMessageId)

    // Cancel any pending ACK and restart the timer with the latest messageId
    const pending = pendingAcks.get(channelId)
    if (pending !== undefined) clearTimeout(pending)

    pendingAcks.set(
      channelId,
      setTimeout(() => {
        pendingAcks.delete(channelId)

        // Fire-and-forget server ACK
        void messageApi
          .messageChannelChannelIdMessageIdAckPost({
            channelId: channelId as unknown as number,
            messageId: nextMessageId as unknown as number,
          })
          .catch(() => {/* silently ignore transient errors */})
      }, 800),
    )
  },

  removeChannel: (channelId) => {
    const pending = pendingAcks.get(channelId)
    if (pending !== undefined) {
      clearTimeout(pending)
      pendingAcks.delete(channelId)
    }

    set((state) => {
      const nextReadStates = { ...state.readStates }
      const nextLastMessages = { ...state.lastMessages }
      let changed = false

      if (channelId in nextReadStates) {
        delete nextReadStates[channelId]
        changed = true
      }
      if (channelId in nextLastMessages) {
        delete nextLastMessages[channelId]
        changed = true
      }

      return changed
        ? { readStates: nextReadStates, lastMessages: nextLastMessages }
        : state
    })
  },

  isUnread: (channelId) => {
    const { readStates, lastMessages } = get()
    const lastRead = readStates[channelId]
    const lastMsg = lastMessages[channelId]
    return hasUnreadMessages(lastRead, lastMsg)
  },
}))
