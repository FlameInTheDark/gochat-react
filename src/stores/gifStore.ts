import { create } from 'zustand'
import { userApi } from '@/api/client'

interface GifState {
  favoriteGifs: string[]
  setFavorites: (urls: string[]) => void
  addFavorite: (url: string) => void
  removeFavorite: (url: string) => void
}

export const useGifStore = create<GifState>((set, get) => ({
  favoriteGifs: [],

  setFavorites: (urls) => set({ favoriteGifs: urls }),

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
    const res = await userApi.userMeSettingsGet()
    const existing = res.data?.settings ?? {}
    await userApi.userMeSettingsPost({ request: { ...existing, favorite_gifs: urls } })
  } catch {
    // non-critical — ignore
  }
}
