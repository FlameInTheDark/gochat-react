import { create } from 'zustand'

export type AuthRefreshProblemKind = 'invalid' | 'transient'

interface AuthProblemState {
  isOpen: boolean
  isRetrying: boolean
  kind: AuthRefreshProblemKind | null
  message: string | null
  open: (kind: AuthRefreshProblemKind, message?: string) => void
  close: () => void
  setRetrying: (isRetrying: boolean) => void
}

export const useAuthProblemStore = create<AuthProblemState>((set) => ({
  isOpen: false,
  isRetrying: false,
  kind: null,
  message: null,

  open: (kind, message) => {
    set({
      isOpen: true,
      kind,
      message: message ?? null,
      isRetrying: false,
    })
  },

  close: () => {
    set({
      isOpen: false,
      kind: null,
      message: null,
      isRetrying: false,
    })
  },

  setRetrying: (isRetrying) => set({ isRetrying }),
}))
