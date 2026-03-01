import { create } from 'zustand'

interface ChannelEntry {
  guildId: string | null
}

interface UnreadState {
  channels: Map<string, ChannelEntry>
  markUnread: (channelId: string, guildId: string | null) => void
  markRead: (channelId: string) => void
  isChannelUnread: (channelId: string) => boolean
  isGuildUnread: (guildId: string) => boolean
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  channels: new Map(),

  markUnread: (channelId, guildId) => {
    // Only update state if the channel isn't already marked unread
    if (!get().channels.has(channelId)) {
      const next = new Map(get().channels)
      next.set(channelId, { guildId })
      set({ channels: next })
    }
  },

  markRead: (channelId) => {
    if (get().channels.has(channelId)) {
      const next = new Map(get().channels)
      next.delete(channelId)
      set({ channels: next })
    }
  },

  isChannelUnread: (channelId) => get().channels.has(channelId),

  isGuildUnread: (guildId) => {
    for (const entry of get().channels.values()) {
      if (entry.guildId === guildId) return true
    }
    return false
  },
}))
