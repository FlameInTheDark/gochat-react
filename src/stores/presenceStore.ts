import { create } from 'zustand'

export type UserStatus = 'online' | 'idle' | 'dnd' | 'offline'

// Status display metadata
export const STATUS_META: Record<UserStatus, { label: string; color: string }> = {
  online: { label: 'Online', color: 'bg-green-500' },
  idle: { label: 'Idle', color: 'bg-yellow-500' },
  dnd: { label: 'Do Not Disturb', color: 'bg-red-500' },
  offline: { label: 'Invisible', color: 'bg-gray-500' },
}

interface VoiceChannelUser {
  userId: string
  username: string
  avatarUrl?: string
  muted?: boolean
  deafened?: boolean
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
  /** Map of channelId (string) → array of users in that voice channel */
  voiceChannelUsers: Record<string, VoiceChannelUser[]>

  setPresence: (userId: string, status: UserStatus) => void
  setCustomStatus: (userId: string, text: string) => void
  setBulkPresence: (updates: Array<{ user_id: string; status: UserStatus }>) => void
  setOwnStatus: (status: UserStatus) => void
  setCustomStatusText: (text: string) => void
  clearAll: () => void
  // Voice channel user management
  addUserToVoiceChannel: (channelId: string, user: VoiceChannelUser) => void
  removeUserFromVoiceChannel: (channelId: string, userId: string) => void
  removeUserFromAllVoiceChannels: (userId: string) => void
  clearVoiceChannel: (channelId: string) => void
  clearAllVoiceChannels: () => void
}

export const usePresenceStore = create<PresenceState>((set) => ({
  statuses: {},
  customStatuses: {},
  ownStatus: 'online',
  customStatusText: '',
  voiceChannelUsers: {},

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

  clearAll: () => set({ statuses: {}, customStatuses: {}, voiceChannelUsers: {} }),

  addUserToVoiceChannel: (channelId, user) =>
    set((state) => {
      const currentUsers = state.voiceChannelUsers[channelId]
      if (!currentUsers) {
        // First user in this channel
        return {
          voiceChannelUsers: {
            ...state.voiceChannelUsers,
            [channelId]: [user],
          },
        }
      }
      // Check if user already exists
      const existingIndex = currentUsers.findIndex((u) => u.userId === user.userId)
      if (existingIndex >= 0) {
        // Update existing user (e.g., mute/deafen state changed)
        const updatedUsers = [...currentUsers]
        updatedUsers[existingIndex] = { ...updatedUsers[existingIndex], ...user }
        return {
          voiceChannelUsers: {
            ...state.voiceChannelUsers,
            [channelId]: updatedUsers,
          },
        }
      }
      return {
        voiceChannelUsers: {
          ...state.voiceChannelUsers,
          [channelId]: [...currentUsers, user],
        },
      }
    }),

  removeUserFromVoiceChannel: (channelId, userId) =>
    set((state) => {
      const currentUsers = state.voiceChannelUsers[channelId]
      if (!currentUsers) return state
      const filtered = currentUsers.filter((u) => u.userId !== userId)
      // Only update if the user was actually removed
      if (filtered.length === currentUsers.length) return state
      return {
        voiceChannelUsers: {
          ...state.voiceChannelUsers,
          [channelId]: filtered,
        },
      }
    }),

  removeUserFromAllVoiceChannels: (userId) =>
    set((state) => {
      let changed = false
      const next: Record<string, VoiceChannelUser[]> = {}
      for (const [channelId, users] of Object.entries(state.voiceChannelUsers)) {
        const filtered = users.filter((u) => u.userId !== userId)
        if (filtered.length !== users.length) {
          changed = true
        }
        if (filtered.length > 0) {
          next[channelId] = filtered
        }
      }
      // Only update if something actually changed
      if (!changed) return state
      return { voiceChannelUsers: next }
    }),

  clearVoiceChannel: (channelId) =>
    set((state) => {
      if (!state.voiceChannelUsers[channelId]) return state
      const next = { ...state.voiceChannelUsers }
      delete next[channelId]
      return { voiceChannelUsers: next }
    }),

  clearAllVoiceChannels: () => set({ voiceChannelUsers: {} }),
}))
