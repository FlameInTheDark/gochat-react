import { create } from 'zustand'

interface ChannelEntry {
  guildId: string | null
}

interface UnreadState {
  channels: Map<string, ChannelEntry>
  replaceChannels: (channels: Map<string, ChannelEntry>) => void
  markUnread: (channelId: string, guildId: string | null) => void
  markRead: (channelId: string) => void
  removeChannel: (channelId: string) => void
  isChannelUnread: (channelId: string) => boolean
  isGuildUnread: (guildId: string) => boolean
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  channels: new Map(),

  replaceChannels: (channels) => {
    set({ channels: new Map(channels) })
  },

  markUnread: (channelId, guildId) => {
    const existing = get().channels.get(channelId)
    if (existing && (existing.guildId === guildId || guildId == null)) return

    const next = new Map(get().channels)
    next.set(channelId, { guildId: guildId ?? existing?.guildId ?? null })
    set({ channels: next })
  },

  markRead: (channelId) => {
    if (get().channels.has(channelId)) {
      const next = new Map(get().channels)
      next.delete(channelId)
      set({ channels: next })
    }
  },

  removeChannel: (channelId) => {
    if (!get().channels.has(channelId)) return
    const next = new Map(get().channels)
    next.delete(channelId)
    set({ channels: next })
  },

  isChannelUnread: (channelId) => get().channels.has(channelId),

  isGuildUnread: (guildId) => {
    for (const entry of get().channels.values()) {
      if (entry.guildId === guildId) return true
    }
    return false
  },
}))
