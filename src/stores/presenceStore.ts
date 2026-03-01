import { create } from 'zustand'

export type UserStatus = 'online' | 'idle' | 'dnd' | 'offline'

// Status display metadata
export const STATUS_META: Record<UserStatus, { label: string; color: string }> = {
  online: { label: 'Online', color: 'bg-green-500' },
  idle: { label: 'Idle', color: 'bg-yellow-500' },
  dnd: { label: 'Do Not Disturb', color: 'bg-red-500' },
  offline: { label: 'Invisible', color: 'bg-gray-500' },
}

interface PresenceState {
  /** Map of userId (string) → status */
  statuses: Record<string, UserStatus>
  /** Map of userId (string) → custom status text (empty string = not set) */
  customStatuses: Record<string, string>
  /** Our own current status (what we broadcast to the server) */
  ownStatus: UserStatus
  /** Our own custom status text shown below username (empty string = not set) */
  customStatusText: string

  setPresence: (userId: string, status: UserStatus) => void
  setCustomStatus: (userId: string, text: string) => void
  setBulkPresence: (updates: Array<{ user_id: string; status: UserStatus }>) => void
  setOwnStatus: (status: UserStatus) => void
  setCustomStatusText: (text: string) => void
  clearAll: () => void
}

export const usePresenceStore = create<PresenceState>((set) => ({
  statuses: {},
  customStatuses: {},
  ownStatus: 'online',
  customStatusText: '',

  setPresence: (userId, status) =>
    set((state) => ({ statuses: { ...state.statuses, [userId]: status } })),

  setCustomStatus: (userId, text) =>
    set((state) => ({ customStatuses: { ...state.customStatuses, [userId]: text } })),

  setBulkPresence: (updates) =>
    set((state) => {
      const next = { ...state.statuses }
      for (const { user_id, status } of updates) {
        next[user_id] = status
      }
      return { statuses: next }
    }),

  setOwnStatus: (status) => set({ ownStatus: status }),

  setCustomStatusText: (text) => set({ customStatusText: text }),

  clearAll: () => set({ statuses: {}, customStatuses: {} }),
}))
