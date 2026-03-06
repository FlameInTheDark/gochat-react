import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AppearanceState {
  fontScale: number
  chatSpacing: number
  setFontScale: (scale: number) => void
  setChatSpacing: (spacing: number) => void
  getFontScale: () => number
  getChatSpacing: () => number
}

const DEFAULT_FONT_SCALE = 0.9
const DEFAULT_CHAT_SPACING = 0

export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set, get) => ({
      fontScale: DEFAULT_FONT_SCALE,
      chatSpacing: DEFAULT_CHAT_SPACING,
      setFontScale: (fontScale) => set({ fontScale: fontScale > 0 ? fontScale : DEFAULT_FONT_SCALE }),
      setChatSpacing: (chatSpacing) => set({ chatSpacing: chatSpacing >= 0 ? chatSpacing : DEFAULT_CHAT_SPACING }),
      getFontScale: () => get().fontScale ?? DEFAULT_FONT_SCALE,
      getChatSpacing: () => get().chatSpacing ?? DEFAULT_CHAT_SPACING,
    }),
    {
      name: 'appearance-storage',
      onRehydrateStorage: () => (state) => {
        if (state) {
          if (state.fontScale == null || state.fontScale <= 0) {
            state.fontScale = DEFAULT_FONT_SCALE
          }
          if (state.chatSpacing == null || state.chatSpacing <= 0) {
            state.chatSpacing = DEFAULT_CHAT_SPACING
          }
        }
      },
    },
  ),
)

export { DEFAULT_FONT_SCALE, DEFAULT_CHAT_SPACING }
