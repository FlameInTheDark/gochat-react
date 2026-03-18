import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface BackgroundState {
  backgroundDataUrl: string | null
  setBackground: (dataUrl: string | null) => void
}

export const useBackgroundStore = create<BackgroundState>()(
  persist(
    (set) => ({
      backgroundDataUrl: null,
      setBackground: (dataUrl) => set({ backgroundDataUrl: dataUrl }),
    }),
    { name: 'gochat-background' },
  ),
)
