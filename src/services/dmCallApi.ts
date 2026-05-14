import { axiosInstance } from '@/api/client'
import { getApiBaseUrl } from '@/lib/connectionConfig'
import type {
  CreateVoiceStreamResponse,
  JoinVoiceStreamResponse,
  StreamAudioMode,
  StreamSourceType,
  VoiceStreamSummary,
} from './streamApi'

export interface DMCallSummary {
  callId: string
  channelId: string
  callerId: string
  recipientId: string
  region?: string
  participants: Record<string, number>
  startedAt: number
  soloSince?: number
  dismissed?: boolean
}

export interface DMCallJoinResponse {
  call: DMCallSummary
  sfuUrl: string
  sfuToken: string
  region?: string
}

export interface RawDMCallSummary {
  call_id?: string | number
  channel_id?: string | number
  caller_id?: string | number
  recipient_id?: string | number
  region?: string
  participants?: Record<string, string | number>
  started_at?: number
  solo_since?: number
  dismissed?: boolean
}

interface RawDMCallJoinResponse {
  call?: RawDMCallSummary
  sfu_url?: string
  sfu_token?: string
  region?: string
}

export function normalizeDMCall(raw: RawDMCallSummary | undefined): DMCallSummary {
  const participants: Record<string, number> = {}
  for (const [userId, joinedAt] of Object.entries(raw?.participants ?? {})) {
    participants[String(userId)] = Number(joinedAt ?? 0)
  }
  return {
    callId: String(raw?.call_id ?? ''),
    channelId: String(raw?.channel_id ?? ''),
    callerId: String(raw?.caller_id ?? ''),
    recipientId: String(raw?.recipient_id ?? ''),
    region: raw?.region,
    participants,
    startedAt: Number(raw?.started_at ?? 0),
    soloSince: raw?.solo_since ? Number(raw.solo_since) : undefined,
    dismissed: raw?.dismissed ?? false,
  }
}

export function hasDMCallParticipants(call: Pick<DMCallSummary, 'participants'> | null | undefined): boolean {
  return Object.keys(call?.participants ?? {}).length > 0
}

function normalizeJoin(raw: RawDMCallJoinResponse): DMCallJoinResponse {
  return {
    call: normalizeDMCall(raw.call),
    sfuUrl: raw.sfu_url ?? '',
    sfuToken: raw.sfu_token ?? '',
    region: raw.region,
  }
}

function dmCallUrl(channelId: string): string {
  return `${getApiBaseUrl()}/user/me/channels/${channelId}/call`
}

export const dmCallApi = {
  async startCall(channelId: string): Promise<DMCallJoinResponse> {
    const { data } = await axiosInstance.post<RawDMCallJoinResponse>(dmCallUrl(channelId))
    return normalizeJoin(data)
  },

  async joinCall(channelId: string): Promise<DMCallJoinResponse> {
    const { data } = await axiosInstance.post<RawDMCallJoinResponse>(`${dmCallUrl(channelId)}/join`)
    return normalizeJoin(data)
  },

  async declineCall(channelId: string): Promise<void> {
    await axiosInstance.post(`${dmCallUrl(channelId)}/decline`)
  },

  async leaveCall(channelId: string): Promise<void> {
    await axiosInstance.delete(dmCallUrl(channelId))
  },

  async listStreams(channelId: string): Promise<VoiceStreamSummary[]> {
    const { data } = await axiosInstance.get<VoiceStreamSummary[]>(`${dmCallUrl(channelId)}/streams`)
    return (data ?? []).map((stream) => ({
      id: String(stream.id ?? ''),
      ownerUserId: String(stream.ownerUserId ?? (stream as unknown as { owner_user_id?: string | number }).owner_user_id ?? ''),
      channelId: String(stream.channelId ?? (stream as unknown as { channel_id?: string | number }).channel_id ?? ''),
      sourceType: stream.sourceType ?? (stream as unknown as { source_type?: StreamSourceType }).source_type ?? 'screen',
      audioMode: stream.audioMode ?? (stream as unknown as { audio_mode?: StreamAudioMode }).audio_mode ?? 'none',
      startedAt: Number(stream.startedAt ?? (stream as unknown as { started_at?: number }).started_at ?? 0),
    })).filter((stream) => stream.id)
  },

  async startStream(channelId: string, sourceType: StreamSourceType, audioMode: StreamAudioMode): Promise<CreateVoiceStreamResponse> {
    const { data } = await axiosInstance.post(`${dmCallUrl(channelId)}/streams`, {
      source_type: sourceType,
      audio_mode: audioMode,
    })
    return {
      streamId: String(data.stream_id ?? ''),
      streamUrl: data.stream_url ?? '',
      streamToken: data.stream_token ?? '',
      stream: {
        id: String(data.stream?.id ?? ''),
        ownerUserId: String(data.stream?.owner_user_id ?? ''),
        channelId: String(data.stream?.channel_id ?? ''),
        sourceType: data.stream?.source_type ?? 'screen',
        audioMode: data.stream?.audio_mode ?? 'none',
        startedAt: Number(data.stream?.started_at ?? 0),
      },
    }
  },

  async joinStream(channelId: string, streamId: string): Promise<JoinVoiceStreamResponse> {
    const { data } = await axiosInstance.post(`${dmCallUrl(channelId)}/streams/${streamId}/join`)
    return {
      streamId: String(data.stream_id ?? ''),
      streamUrl: data.stream_url ?? '',
      streamToken: data.stream_token ?? '',
    }
  },

  async stopStream(channelId: string, streamId: string): Promise<void> {
    await axiosInstance.delete(`${dmCallUrl(channelId)}/streams/${streamId}`)
  },
}
