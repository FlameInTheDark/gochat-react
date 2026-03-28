import { create } from 'zustand'

export interface VoicePeer {
  speaking: boolean
  muted: boolean // server-muted
  deafened: boolean // server-deafened
  volume: number // 0-200, user-adjustable volume for this peer
  videoStream: MediaStream | null // remote video stream (null if camera off)
}

export type VoiceConnectionState = 'connecting' | 'routing' | 'connected' | 'disconnected'

interface VoiceState {
  channelId: string | null
  guildId: string | null
  channelName: string | null
  guildName: string | null
  sfuUrl: string | null
  voiceRegion: string | null
  localMuted: boolean
  localDeafened: boolean
  localSpeaking: boolean // true when VAD/PTT is actively transmitting
  localCameraEnabled: boolean
  localVideoStream: MediaStream | null
  ping: number // RTT in ms
  connectionState: VoiceConnectionState
  daveEnabled: boolean         // server reported dave_enabled=true in Ready
  daveProtocolVersion: 0 | 1  // 0 = transport-only, 1 = E2EE active
  daveTransitioning: boolean   // true while a DAVE epoch/downgrade transition is in progress
  daveEpoch: number            // current DAVE epoch (0 = not started)
  davePrivacyCode: string | null // voice privacy code from davey (null when not E2EE)
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
    videoInputDevice: string       // deviceId for camera, '' = default
    denoiserType: 'default' | 'rnnoise' | 'speex'  // noise suppression backend
  }
  peers: Record<string, VoicePeer> // keyed by userId string

  setVoiceChannel: (guildId: string, channelId: string, channelName: string, guildName?: string, sfuUrl?: string, voiceRegion?: string) => void
  setSettings: (settings: Partial<VoiceState['settings']>) => void
  addPeer: (userId: string) => void
  removePeer: (userId: string) => void
  setPeerSpeaking: (userId: string, speaking: boolean) => void
  setPeerMuted: (userId: string, muted: boolean) => void
  setPeerDeafened: (userId: string, deafened: boolean) => void
  setPeerVolume: (userId: string, volume: number) => void
  setLocalMuted: (muted: boolean) => void
  setLocalDeafened: (deafened: boolean) => void
  setLocalSpeaking: (speaking: boolean) => void
  setLocalCameraEnabled: (enabled: boolean) => void
  setLocalVideoStream: (stream: MediaStream | null) => void
  setPeerVideoStream: (userId: string, stream: MediaStream | null) => void
  setPing: (ping: number) => void
  setConnectionState: (state: VoiceConnectionState) => void
  setDaveEnabled: (enabled: boolean) => void
  setDaveState: (version: 0 | 1, transitioning: boolean, epoch?: number) => void
  setDavePrivacyCode: (code: string | null) => void
  reset: () => void
}

export const useVoiceStore = create<VoiceState>((set) => ({
  channelId: null,
  guildId: null,
  channelName: null,
  guildName: null,
  sfuUrl: null,
  voiceRegion: null,
  localMuted: false,
  localDeafened: false,
  localSpeaking: false,
  localCameraEnabled: false,
  localVideoStream: null,
  ping: 0,
  connectionState: 'disconnected',
  daveEnabled: false,
  daveProtocolVersion: 0,
  daveTransitioning: false,
  daveEpoch: 0,
  davePrivacyCode: null,
  settings: {
    audioInputDevice: '',
    audioOutputDevice: '',
    audioInputLevel: 100,
    audioOutputLevel: 100,
    autoGainControl: true,
    echoCancellation: true,
    noiseSuppression: true,
    inputMode: 'voice_activity',
    voiceActivityThreshold: -60, // -60 dBFS, good default for speech
    pushToTalkKey: '',
    videoInputDevice: '',
    denoiserType: 'default',
  },
  peers: {},

  setVoiceChannel: (guildId, channelId, channelName, guildName, sfuUrl, voiceRegion) =>
    set({ guildId, channelId, channelName, guildName: guildName ?? null, sfuUrl: sfuUrl ?? null, voiceRegion: voiceRegion ?? null }),

  setSettings: (settings) =>
    set((state) => ({ settings: { ...state.settings, ...settings } })),

  addPeer: (userId) =>
    set((state) => ({
      peers: state.peers[userId]
        ? state.peers
        : { ...state.peers, [userId]: { speaking: false, muted: false, deafened: false, volume: 100, videoStream: null } },
    })),

  removePeer: (userId) =>
    set((state) => {
      const next = { ...state.peers }
      if (next[userId]?.videoStream) {
        next[userId].videoStream.getTracks().forEach(t => t.stop())
      }
      delete next[userId]
      return { peers: next }
    }),

  setPeerSpeaking: (userId, speaking) =>
    set((state) => ({
      peers: {
        ...state.peers,
        [userId]: { ...(state.peers[userId] ?? { muted: false, deafened: false, volume: 100, videoStream: null }), speaking },
      },
    })),

  setPeerMuted: (userId, muted) =>
    set((state) => ({
      peers: {
        ...state.peers,
        [userId]: { ...(state.peers[userId] ?? { speaking: false, deafened: false, volume: 100, videoStream: null }), muted },
      },
    })),

  setPeerDeafened: (userId, deafened) =>
    set((state) => ({
      peers: {
        ...state.peers,
        [userId]: { ...(state.peers[userId] ?? { speaking: false, muted: false, volume: 100, videoStream: null }), deafened },
      },
    })),

  setPeerVolume: (userId, volume) =>
    set((state) => ({
      peers: {
        ...state.peers,
        [userId]: { ...(state.peers[userId] ?? { speaking: false, muted: false, deafened: false, videoStream: null }), volume },
      },
    })),

  setPeerVideoStream: (userId, stream) =>
    set((state) => ({
      peers: {
        ...state.peers,
        [userId]: { ...(state.peers[userId] ?? { speaking: false, muted: false, deafened: false, volume: 100 }), videoStream: stream },
      },
    })),

  setLocalMuted: (localMuted) => set({ localMuted }),

  setLocalDeafened: (localDeafened) => set({ localDeafened }),

  setLocalSpeaking: (localSpeaking) => set({ localSpeaking }),

  setLocalCameraEnabled: (localCameraEnabled) => set({ localCameraEnabled }),

  setLocalVideoStream: (localVideoStream) => set({ localVideoStream }),

  setPing: (ping) => set({ ping }),

  setConnectionState: (connectionState) => set({ connectionState }),

  setDaveEnabled: (daveEnabled) => set({ daveEnabled }),

  setDaveState: (daveProtocolVersion, daveTransitioning, daveEpoch) =>
    set((s) => ({ daveProtocolVersion, daveTransitioning, daveEpoch: daveEpoch ?? s.daveEpoch })),

  setDavePrivacyCode: (davePrivacyCode) => set({ davePrivacyCode }),

  reset: () =>
    set({
      channelId: null,
      guildId: null,
      channelName: null,
      guildName: null,
      sfuUrl: null,
      voiceRegion: null,
      localMuted: false,
      localDeafened: false,
      localCameraEnabled: false,
      localVideoStream: null,
      ping: 0,
      connectionState: 'disconnected',
      daveEnabled: false,
      daveProtocolVersion: 0,
      daveTransitioning: false,
      daveEpoch: 0,
      davePrivacyCode: null,
      peers: {},
    }),
}))
