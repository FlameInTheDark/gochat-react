import emojiGroupsData from 'unicode-emoji-json/data-by-group.json'

export interface EmojiEntry {
  emoji: string
  name: string
  slug: string
  skin_tone_support: boolean
  group?: string
}

const emojiGroups = emojiGroupsData.map((group) => ({
  ...group,
  emojis: group.emojis.map((emoji) => ({ ...emoji, group: group.slug })),
}))

export const allEmojis: EmojiEntry[] = emojiGroups.flatMap((g) => g.emojis)
export const emojiIndex = new Map<string, EmojiEntry>(allEmojis.map((e) => [e.emoji, e]))
