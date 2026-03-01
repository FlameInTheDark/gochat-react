import { create } from 'zustand'
import type { DtoUser } from '@/types'

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
  token: localStorage.getItem('auth_token'),
  refreshToken: localStorage.getItem('auth_refresh_token'),
  user: null,

  setToken: (token) => {
    localStorage.setItem('auth_token', token)
    set({ token })
  },

  setRefreshToken: (token) => {
    localStorage.setItem('auth_refresh_token', token)
    set({ refreshToken: token })
  },

  setUser: (user) => set({ user }),

  logout: () => {
    localStorage.removeItem('auth_token')
    localStorage.removeItem('auth_refresh_token')
    set({ token: null, refreshToken: null, user: null })
  },
}))
