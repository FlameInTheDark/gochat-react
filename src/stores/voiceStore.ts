import { create } from 'zustand'

export interface VoicePeer {
  speaking: boolean
  muted: boolean // server-muted
}

interface VoiceState {
  channelId: string | null
  guildId: string | null
  channelName: string | null
  localMuted: boolean
  localDeafened: boolean
  peers: Record<string, VoicePeer> // keyed by userId string

  setVoiceChannel: (guildId: string, channelId: string, channelName: string) => void
  addPeer: (userId: string) => void
  removePeer: (userId: string) => void
  setPeerSpeaking: (userId: string, speaking: boolean) => void
  setPeerMuted: (userId: string, muted: boolean) => void
  setLocalMuted: (muted: boolean) => void
  setLocalDeafened: (deafened: boolean) => void
  reset: () => void
}

export const useVoiceStore = create<VoiceState>((set) => ({
  channelId: null,
  guildId: null,
  channelName: null,
  localMuted: false,
  localDeafened: false,
  peers: {},

  setVoiceChannel: (guildId, channelId, channelName) =>
    set({ guildId, channelId, channelName }),

  addPeer: (userId) =>
    set((state) => ({
      peers: state.peers[userId]
        ? state.peers
        : { ...state.peers, [userId]: { speaking: false, muted: false } },
    })),

  removePeer: (userId) =>
    set((state) => {
      const next = { ...state.peers }
      delete next[userId]
      return { peers: next }
    }),

  setPeerSpeaking: (userId, speaking) =>
    set((state) => ({
      peers: {
        ...state.peers,
        [userId]: { ...(state.peers[userId] ?? { muted: false }), speaking },
      },
    })),

  setPeerMuted: (userId, muted) =>
    set((state) => ({
      peers: {
        ...state.peers,
        [userId]: { ...(state.peers[userId] ?? { speaking: false }), muted },
      },
    })),

  setLocalMuted: (localMuted) => set({ localMuted }),

  setLocalDeafened: (localDeafened) => set({ localDeafened }),

  reset: () =>
    set({
      channelId: null,
      guildId: null,
      channelName: null,
      localMuted: false,
      localDeafened: false,
      peers: {},
    }),
}))
