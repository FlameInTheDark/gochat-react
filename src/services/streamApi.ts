import { axiosInstance } from '@/api/client'
import { getApiBaseUrl } from '@/lib/connectionConfig'

export type StreamSourceType = 'screen' | 'application'
export type StreamAudioMode = 'desktop' | 'application' | 'none'
export const STREAM_RESOLUTION_OPTIONS = ['720p', '1080p', '1440p', '2160p'] as const
export type StreamResolution = typeof STREAM_RESOLUTION_OPTIONS[number]
export const STREAM_FRAME_RATE_OPTIONS = [15, 30, 60] as const
export type StreamFrameRate = typeof STREAM_FRAME_RATE_OPTIONS[number]

export interface StreamQualitySettings {
  resolution: StreamResolution
  frameRate: StreamFrameRate
}

export const DEFAULT_STREAM_QUALITY: StreamQualitySettings = {
  resolution: '1080p',
  frameRate: 30,
}

export interface VoiceStreamSummary {
  id: string
  ownerUserId: string
  channelId: string
  sourceType: StreamSourceType
  audioMode: StreamAudioMode
  startedAt: number
}

export interface CreateVoiceStreamResponse {
  streamId: string
  streamUrl: string
  streamToken: string
  stream: VoiceStreamSummary
}

export interface JoinVoiceStreamResponse {
  streamId: string
  streamUrl: string
  streamToken: string
}

interface RawVoiceStreamSummary {
  id?: string | number
  owner_user_id?: string | number
  channel_id?: string | number
  source_type?: StreamSourceType
  audio_mode?: StreamAudioMode
  started_at?: number
}

interface RawCreateVoiceStreamResponse {
  stream_id?: string | number
  stream_url?: string
  stream_token?: string
  stream?: RawVoiceStreamSummary
}

interface RawJoinVoiceStreamResponse {
  stream_id?: string | number
  stream_url?: string
  stream_token?: string
}

function normalizeStreamSummary(raw: RawVoiceStreamSummary): VoiceStreamSummary {
  return {
    id: String(raw.id ?? ''),
    ownerUserId: String(raw.owner_user_id ?? ''),
    channelId: String(raw.channel_id ?? ''),
    sourceType: raw.source_type ?? 'screen',
    audioMode: raw.audio_mode ?? 'none',
    startedAt: Number(raw.started_at ?? 0),
  }
}

function guildVoiceStreamsUrl(guildId: string, channelId: string): string {
  return `${getApiBaseUrl()}/guild/${guildId}/voice/${channelId}/streams`
}

export const streamApi = {
  async listStreams(guildId: string, channelId: string): Promise<VoiceStreamSummary[]> {
    const { data } = await axiosInstance.get<RawVoiceStreamSummary[]>(
      guildVoiceStreamsUrl(guildId, channelId),
    )
    return (data ?? [])
      .map(normalizeStreamSummary)
      .filter((stream) => stream.id && stream.ownerUserId && stream.channelId)
  },

  async startStream(
    guildId: string,
    channelId: string,
    sourceType: StreamSourceType,
    audioMode: StreamAudioMode,
  ): Promise<CreateVoiceStreamResponse> {
    const { data } = await axiosInstance.post<RawCreateVoiceStreamResponse>(
      guildVoiceStreamsUrl(guildId, channelId),
      { source_type: sourceType, audio_mode: audioMode },
    )

    return {
      streamId: String(data.stream_id ?? ''),
      streamUrl: data.stream_url ?? '',
      streamToken: data.stream_token ?? '',
      stream: normalizeStreamSummary(data.stream ?? {}),
    }
  },

  async joinStream(
    guildId: string,
    channelId: string,
    streamId: string,
  ): Promise<JoinVoiceStreamResponse> {
    const { data } = await axiosInstance.post<RawJoinVoiceStreamResponse>(
      `${guildVoiceStreamsUrl(guildId, channelId)}/${streamId}/join`,
    )

    return {
      streamId: String(data.stream_id ?? ''),
      streamUrl: data.stream_url ?? '',
      streamToken: data.stream_token ?? '',
    }
  },

  async stopStream(guildId: string, channelId: string, streamId: string): Promise<void> {
    await axiosInstance.delete(`${guildVoiceStreamsUrl(guildId, channelId)}/${streamId}`)
  },
}
