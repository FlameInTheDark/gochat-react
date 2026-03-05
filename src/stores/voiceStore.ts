import { create } from 'zustand'

export interface VoicePeer {
  speaking: boolean
  muted: boolean // server-muted
  deafened: boolean // server-deafened
  volume: number // 0-200, user-adjustable volume for this peer
}

interface VoiceState {
  channelId: string | null
  guildId: string | null
  channelName: string | null
  localMuted: boolean
  localDeafened: boolean
  settings: {
    audioInputDevice: string
    audioOutputDevice: string
    audioInputLevel: number
    audioOutputLevel: number
    autoGainControl: boolean
    echoCancellation: boolean
    noiseSuppression: boolean
    inputMode: 'voice_activity' | 'push_to_talk'
    voiceActivityThreshold: number // 0–100, sensitivity threshold for voice activity
    pushToTalkKey: string          // key code for PTT, e.g. 'KeyV'
  }
  peers: Record<string, VoicePeer> // keyed by userId string

  setVoiceChannel: (guildId: string, channelId: string, channelName: string) => void
  setSettings: (settings: Partial<VoiceState['settings']>) => void
  addPeer: (userId: string) => void
  removePeer: (userId: string) => void
  setPeerSpeaking: (userId: string, speaking: boolean) => void
  setPeerMuted: (userId: string, muted: boolean) => void
  setPeerDeafened: (userId: string, deafened: boolean) => void
  setPeerVolume: (userId: string, volume: number) => void
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
  settings: {
    audioInputDevice: '',
    audioOutputDevice: '',
    audioInputLevel: 100,
    audioOutputLevel: 100,
    autoGainControl: true,
    echoCancellation: true,
    noiseSuppression: true,
    inputMode: 'voice_activity',
    voiceActivityThreshold: 50,
    pushToTalkKey: '',
  },
  peers: {},

  setVoiceChannel: (guildId, channelId, channelName) =>
    set({ guildId, channelId, channelName }),

  setSettings: (settings) =>
    set((state) => ({ settings: { ...state.settings, ...settings } })),

  addPeer: (userId) =>
    set((state) => ({
      peers: state.peers[userId]
        ? state.peers
        : { ...state.peers, [userId]: { speaking: false, muted: false, deafened: false, volume: 100 } },
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
        [userId]: { ...(state.peers[userId] ?? { muted: false, deafened: false, volume: 100 }), speaking },
      },
    })),

  setPeerMuted: (userId, muted) =>
    set((state) => ({
      peers: {
        ...state.peers,
        [userId]: { ...(state.peers[userId] ?? { speaking: false, deafened: false, volume: 100 }), muted },
      },
    })),

  setPeerDeafened: (userId, deafened) =>
    set((state) => ({
      peers: {
        ...state.peers,
        [userId]: { ...(state.peers[userId] ?? { speaking: false, muted: false, volume: 100 }), deafened },
      },
    })),

  setPeerVolume: (userId, volume) =>
    set((state) => ({
      peers: {
        ...state.peers,
        [userId]: { ...(state.peers[userId] ?? { speaking: false, muted: false, deafened: false }), volume },
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
