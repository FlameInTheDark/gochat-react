import { create } from 'zustand'
import { compareSnowflakes } from '@/lib/snowflake'

interface MentionEntry {
  guildId: string | null
  messageIds: string[]
}

interface MentionState {
  mentions: Record<string, MentionEntry> // keyed by channelId
  addMention: (guildId: string, channelId: string, messageId: string) => void
  clearMentionsUpTo: (channelId: string, messageId: string) => void
  clearChannel: (channelId: string) => void
  associateGuild: (channelId: string, guildId: string) => void
  /** Bulk-seed mention counts from the settings API response (called once at init). */
  seedMentions: (data: Record<string, MentionEntry>) => void
  getChannelMentionCount: (channelId: string) => number
  getGuildMentionCount: (guildId: string) => number
  hasGuildMentions: (guildId: string) => boolean
}

function normalizeMessageIds(messageIds: string[]): string[] {
  return [...new Set(messageIds)].sort(compareSnowflakes)
}

export const useMentionStore = create<MentionState>((set, get) => ({
  mentions: {},

  addMention: (guildId, channelId, messageId) => {
    set((state) => {
      const existing = state.mentions[channelId]
      const nextMessageId = String(messageId)
      if (existing?.messageIds.includes(nextMessageId) && existing.guildId === guildId) {
        return state
      }

      return {
        mentions: {
          ...state.mentions,
          [channelId]: {
            guildId: existing?.guildId ?? guildId,
            messageIds: normalizeMessageIds([
              ...(existing?.messageIds ?? []),
              nextMessageId,
            ]),
          },
        },
      }
    })
  },

  seedMentions: (data) => {
    const mentions: Record<string, MentionEntry> = {}
    for (const [channelId, entry] of Object.entries(data)) {
      const messageIds = normalizeMessageIds((entry.messageIds ?? []).map(String))
      if (messageIds.length === 0) continue
      mentions[channelId] = {
        guildId: entry.guildId ?? null,
        messageIds,
      }
    }
    set({ mentions })
  },

  clearMentionsUpTo: (channelId, messageId) => {
    set((state) => {
      const entry = state.mentions[channelId]
      if (!entry) return state

      const remainingMessageIds = entry.messageIds.filter(
        (id) => compareSnowflakes(id, messageId) > 0,
      )
      if (remainingMessageIds.length === entry.messageIds.length) return state

      if (remainingMessageIds.length === 0) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [channelId]: _removed, ...rest } = state.mentions
        return { mentions: rest }
      }

      return {
        mentions: {
          ...state.mentions,
          [channelId]: {
            ...entry,
            messageIds: remainingMessageIds,
          },
        },
      }
    })
  },

  clearChannel: (channelId) => {
    set((state) => {
      if (!(channelId in state.mentions)) return state
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [channelId]: _removed, ...rest } = state.mentions
      return { mentions: rest }
    })
  },

  associateGuild: (channelId, guildId) => {
    set((state) => {
      const entry = state.mentions[channelId]
      if (!entry || entry.guildId === guildId) return state
      return {
        mentions: {
          ...state.mentions,
          [channelId]: {
            ...entry,
            guildId,
          },
        },
      }
    })
  },

  getChannelMentionCount: (channelId) => get().mentions[channelId]?.messageIds.length ?? 0,

  getGuildMentionCount: (guildId) => {
    let total = 0
    for (const entry of Object.values(get().mentions)) {
      if (entry.guildId === guildId) total += entry.messageIds.length
    }
    return total
  },

  hasGuildMentions: (guildId) => {
    for (const entry of Object.values(get().mentions)) {
      if (entry.guildId === guildId) return true
    }
    return false
  },
}))
