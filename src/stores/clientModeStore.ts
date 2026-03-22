import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ClientMode = 'desktop' | 'mobile'

interface ClientModeStore {
  override: ClientMode | null
  setOverride: (mode: ClientMode | null) => void
}

export const useClientModeStore = create<ClientModeStore>()(
  persist(
    (set) => ({
      override: null,
      setOverride: (mode) => set({ override: mode }),
    }),
    { name: 'client-mode' },
  ),
)
