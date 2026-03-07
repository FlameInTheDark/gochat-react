import { create } from 'zustand'

export interface GuildEmoji {
  id: string
  name: string
  guild_id: string
  animated?: boolean
}

interface EmojiStore {
  /** Emojis indexed by guild ID */
  guildEmojis: Record<string, GuildEmoji[]>
  setGuildEmojis: (guildId: string, emojis: GuildEmoji[]) => void
  addEmoji: (emoji: GuildEmoji) => void
  updateEmoji: (emoji: GuildEmoji) => void
  removeEmoji: (guildId: string, emojiId: string) => void
}

export const useEmojiStore = create<EmojiStore>((set) => ({
  guildEmojis: {},

  setGuildEmojis: (guildId, emojis) =>
    set((s) => ({ guildEmojis: { ...s.guildEmojis, [guildId]: emojis } })),

  addEmoji: (emoji) =>
    set((s) => {
      const existing = s.guildEmojis[emoji.guild_id] ?? []
      // Avoid duplicates
      if (existing.some((e) => e.id === emoji.id)) return s
      return { guildEmojis: { ...s.guildEmojis, [emoji.guild_id]: [...existing, emoji] } }
    }),

  updateEmoji: (emoji) =>
    set((s) => {
      const existing = s.guildEmojis[emoji.guild_id] ?? []
      return {
        guildEmojis: {
          ...s.guildEmojis,
          [emoji.guild_id]: existing.map((e) => (e.id === emoji.id ? emoji : e)),
        },
      }
    }),

  removeEmoji: (guildId, emojiId) =>
    set((s) => ({
      guildEmojis: {
        ...s.guildEmojis,
        [guildId]: (s.guildEmojis[guildId] ?? []).filter((e) => e.id !== emojiId),
      },
    })),
}))
