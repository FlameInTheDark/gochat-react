import { create } from 'zustand'
import type { DtoUser } from '@/types'
import { tokenStorage } from '@/lib/tokenStorage'

interface AuthState {
  token: string | null
  refreshToken: string | null
  user: DtoUser | null
  setToken: (token: string) => void
  setRefreshToken: (token: string) => void
  setUser: (user: DtoUser) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  token: tokenStorage.get('auth_token'),
  refreshToken: tokenStorage.get('auth_refresh_token'),
  user: null,

  setToken: (token) => {
    tokenStorage.set('auth_token', token)
    set({ token })
  },

  setRefreshToken: (token) => {
    tokenStorage.set('auth_refresh_token', token)
    set({ refreshToken: token })
  },

  setUser: (user) => set({ user }),

  logout: () => {
    tokenStorage.delete('auth_token')
    tokenStorage.delete('auth_refresh_token')
    set({ token: null, refreshToken: null, user: null })
  },
}))
