import { create } from 'zustand'
import type {
  StreamAudioMode,
  StreamFrameRate,
  StreamResolution,
  StreamSourceType,
  VoiceStreamSummary,
} from '@/services/streamApi'

export type StreamConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'error'

export interface PublishingStreamState {
  streamId: string
  channelId: string
  ownerUserId: string
  sourceType: StreamSourceType
  audioMode: StreamAudioMode
  resolution: StreamResolution
  frameRate: StreamFrameRate
  previewStream: MediaStream | null
  connectionState: StreamConnectionState
  error: string | null
}

export interface WatchingStreamState {
  streamId: string
  channelId: string
  ownerUserId: string
  sourceType: StreamSourceType
  audioMode: StreamAudioMode
  mediaStream: MediaStream | null
  connectionState: StreamConnectionState
  volume: number
  muted: boolean
  error: string | null
}

interface StreamState {
  channelStreams: Record<string, VoiceStreamSummary[]>
  publishing: PublishingStreamState | null
  watched: Record<string, WatchingStreamState>

  setChannelStreams: (channelId: string, streams: VoiceStreamSummary[]) => void
  upsertChannelStream: (stream: VoiceStreamSummary) => void
  removeChannelStream: (channelId: string, streamId: string) => void
  clearChannelStreams: (channelId: string) => void

  setPublishing: (publishing: PublishingStreamState | null) => void
  updatePublishing: (patch: Partial<PublishingStreamState>) => void

  setWatchedStream: (watching: WatchingStreamState) => void
  updateWatchedStream: (streamId: string, patch: Partial<WatchingStreamState>) => void
  removeWatchedStream: (streamId: string) => void

  setWatchedVolume: (streamId: string, volume: number) => void
  setWatchedMuted: (streamId: string, muted: boolean) => void

  reset: () => void
}

function sortStreams(streams: VoiceStreamSummary[]): VoiceStreamSummary[] {
  return [...streams].sort((a, b) => {
    if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt
    return a.ownerUserId.localeCompare(b.ownerUserId)
  })
}

function dedupeStreams(streams: VoiceStreamSummary[]): VoiceStreamSummary[] {
  const byId = new Map<string, VoiceStreamSummary>()
  for (const stream of streams) {
    if (!stream.id) continue
    byId.set(stream.id, stream)
  }
  return sortStreams([...byId.values()])
}

export const useStreamStore = create<StreamState>((set) => ({
  channelStreams: {},
  publishing: null,
  watched: {},

  setChannelStreams: (channelId, streams) =>
    set((state) => ({
      channelStreams: {
        ...state.channelStreams,
        [channelId]: dedupeStreams(streams),
      },
    })),

  upsertChannelStream: (stream) =>
    set((state) => {
      const current = state.channelStreams[stream.channelId] ?? []
      const next = dedupeStreams([...current.filter((item) => item.id !== stream.id), stream])
      return {
        channelStreams: {
          ...state.channelStreams,
          [stream.channelId]: next,
        },
      }
    }),

  removeChannelStream: (channelId, streamId) =>
    set((state) => {
      const current = state.channelStreams[channelId]
      if (!current) return state
      const next = current.filter((stream) => stream.id !== streamId)
      if (next.length === current.length) return state
      return {
        channelStreams: {
          ...state.channelStreams,
          [channelId]: next,
        },
      }
    }),

  clearChannelStreams: (channelId) =>
    set((state) => {
      if (!state.channelStreams[channelId]) return state
      const next = { ...state.channelStreams }
      delete next[channelId]
      return { channelStreams: next }
    }),

  setPublishing: (publishing) => set({ publishing }),

  updatePublishing: (patch) =>
    set((state) => ({
      publishing: state.publishing ? { ...state.publishing, ...patch } : state.publishing,
    })),

  setWatchedStream: (watching) =>
    set((state) => ({
      watched: {
        ...state.watched,
        [watching.streamId]: watching,
      },
    })),

  updateWatchedStream: (streamId, patch) =>
    set((state) => ({
      watched: state.watched[streamId]
        ? {
            ...state.watched,
            [streamId]: { ...state.watched[streamId], ...patch },
          }
        : state.watched,
    })),

  removeWatchedStream: (streamId) =>
    set((state) => {
      if (!state.watched[streamId]) return state
      const next = { ...state.watched }
      delete next[streamId]
      return { watched: next }
    }),

  setWatchedVolume: (streamId, volume) =>
    set((state) => ({
      watched: state.watched[streamId]
        ? {
            ...state.watched,
            [streamId]: {
              ...state.watched[streamId],
              volume: Math.max(0, Math.min(100, volume)),
            },
          }
        : state.watched,
    })),

  setWatchedMuted: (streamId, muted) =>
    set((state) => ({
      watched: state.watched[streamId]
        ? {
            ...state.watched,
            [streamId]: {
              ...state.watched[streamId],
              muted,
            },
          }
        : state.watched,
    })),

  reset: () => set({ channelStreams: {}, publishing: null, watched: {} }),
}))
