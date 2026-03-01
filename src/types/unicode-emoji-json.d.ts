declare module 'unicode-emoji-json/data-by-group.json' {
  interface EmojiEntry {
    emoji: string
    name: string
    slug: string
    skin_tone_support: boolean
    unicode_version: string
    emoji_version: string
  }
  interface EmojiGroup {
    name: string
    slug: string
    emojis: EmojiEntry[]
  }
  const data: EmojiGroup[]
  export default data
}
