import { create } from 'zustand'
import { saveSettings } from '@/lib/settingsApi'

interface GifState {
  favoriteGifs: string[]
  contentHosts: string[]
  setFavorites: (urls: string[]) => void
  addFavorite: (url: string) => void
  removeFavorite: (url: string) => void
  setContentHosts: (hosts: string[]) => void
}

export const useGifStore = create<GifState>((set, get) => ({
  favoriteGifs: [],
  contentHosts: [],

  setFavorites: (urls) => set({ favoriteGifs: urls }),
  setContentHosts: (hosts) => set({ contentHosts: hosts }),

  addFavorite: (url) => {
    if (get().favoriteGifs.includes(url)) return
    const next = [url, ...get().favoriteGifs]
    set({ favoriteGifs: next })
    void saveGifs(next)
  },

  removeFavorite: (url) => {
    const next = get().favoriteGifs.filter((u) => u !== url)
    set({ favoriteGifs: next })
    void saveGifs(next)
  },
}))

async function saveGifs(urls: string[]) {
  try {
    await saveSettings({ favorite_gifs: urls })
  } catch {
    // non-critical — ignore
  }
}
