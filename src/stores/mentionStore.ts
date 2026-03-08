import { create } from 'zustand'

interface MentionEntry {
  count: number
  guildId: string
}

interface MentionState {
  mentions: Record<string, MentionEntry> // keyed by channelId
  addMention: (guildId: string, channelId: string) => void
  clearMentions: (channelId: string) => void
  /** Bulk-seed mention counts from the settings API response (called once at init). */
  seedMentions: (data: Record<string, MentionEntry>) => void
  getChannelMentionCount: (channelId: string) => number
  getGuildMentionCount: (guildId: string) => number
  hasGuildMentions: (guildId: string) => boolean
}

export const useMentionStore = create<MentionState>((set, get) => ({
  mentions: {},

  addMention: (guildId, channelId) => {
    set((state) => {
      const existing = state.mentions[channelId]
      return {
        mentions: {
          ...state.mentions,
          [channelId]: {
            count: (existing?.count ?? 0) + 1,
            guildId,
          },
        },
      }
    })
  },

  seedMentions: (data) => {
    set({ mentions: data })
  },

  clearMentions: (channelId) => {
    set((state) => {
      if (!state.mentions[channelId]) return state
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [channelId]: _removed, ...rest } = state.mentions
      return { mentions: rest }
    })
  },

  getChannelMentionCount: (channelId) => get().mentions[channelId]?.count ?? 0,

  getGuildMentionCount: (guildId) => {
    let total = 0
    for (const entry of Object.values(get().mentions)) {
      if (entry.guildId === guildId) total += entry.count
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
