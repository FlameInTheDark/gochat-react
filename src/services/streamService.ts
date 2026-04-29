import JSONBig from 'json-bigint'
import { Buffer } from 'buffer'
import { Codec, DAVESession, MediaType, ProposalsOperationType, SessionStatus, generateP256Keypair, type SigningKeyPair } from '@/lib/dave'
import {
  DaveScriptTransformRuntime,
  supportsAnyEncodedTransforms,
  supportsDirectEncodedTransforms,
  supportsScriptEncodedTransforms,
} from '@/lib/daveScriptTransform'
import { useAuthStore } from '@/stores/authStore'
import { usePresenceStore } from '@/stores/presenceStore'
import { useStreamStore } from '@/stores/streamStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { buildVoiceGatewayIdentifyData, stringifyVoiceGatewayPacket } from './voiceGatewayProtocol'
import {
  DEFAULT_STREAM_QUALITY,
  STREAM_FRAME_RATE_OPTIONS,
  STREAM_RESOLUTION_OPTIONS,
  streamApi,
  type StreamFrameRate,
  type StreamQualitySettings,
  type StreamResolution,
  type StreamAudioMode,
  type StreamSourceType,
  type VoiceStreamSummary,
} from './streamApi'

const _bigJsonParse = JSONBig({ storeAsString: true })

const GW_IDENTIFY = 0
const GW_SELECT_PROTOCOL = 1
const GW_READY = 2
const GW_HEARTBEAT = 3
const GW_SESSION_DESC = 4
const GW_HELLO = 8
const GW_DAVE_PREPARE_TRANSITION = 21
const GW_DAVE_EXECUTE_TRANSITION = 22
const GW_DAVE_TRANSITION_READY = 23
const GW_DAVE_PREPARE_EPOCH = 24
const GW_DAVE_INVALID_COMMIT = 31

const DAVE_BIN_EXTERNAL_SENDER = 25
const DAVE_BIN_KEY_PACKAGE = 26
const DAVE_BIN_PROPOSALS = 27
const DAVE_BIN_COMMIT_WELCOME = 28
const DAVE_BIN_ANNOUNCE_COMMIT = 29
const DAVE_BIN_WELCOME = 30

const DAVE_LATE_PACKET_WINDOW_SECONDS = 10
const DAVE_TRANSFORM_WARN_INTERVAL_MS = 2_000
const DAVE_DECRYPT_RECREATE_FAILURES = 12
const DAVE_DECRYPT_RECREATE_AFTER_MS = 1_500
const DAVE_DECRYPT_RECREATE_MAX_ATTEMPTS = 2

type RuntimeRole = 'publisher' | 'viewer'
type DaveMode = 'passthrough' | 'pending_upgrade' | 'pending_downgrade'

interface GatewayEnvelope {
  op?: number
  d?: unknown
}

interface GatewayHello {
  heartbeat_interval?: number
}

interface GatewayIceServer {
  urls?: string[]
  username?: string
  credential?: string
}

interface GatewayReady {
  ice_servers?: GatewayIceServer[]
  can_publish_audio?: boolean
  can_publish_video?: boolean
  max_audio_bitrate_kbps?: number
  max_video_bitrate_kbps?: number
  dave_enabled?: boolean
  dave_required?: boolean
}

interface GatewaySessionDescription {
  type?: string
  sdp?: string
  rtc_connection_id?: string
  dave_protocol_version?: 0 | 1
  dave_epoch?: number
  audio_codec?: string
  video_codec?: string
}

interface RuntimeDaveState {
  enabled: boolean
  required: boolean
  mode: DaveMode
  protocolVersion: 0 | 1
  epoch: number
  lastTransitionReadySent: number | null
  lastExecutedTransitionId: number | null
  invalidCommitRequestedForTransition: number | null
  decryptRecreateRequests: number
  decryptFailures: Map<string, { count: number; firstAt: number }>
  session: DAVESession | null
  pendingSession: DAVESession | null
  weCommitted: boolean
  awaitingWelcome: boolean
  pendingTransitionId: number | null
  negotiatedVideoCodec: Codec
  transformedSenders: Set<RTCRtpSender>
  pendingSenderTransforms: Map<RTCRtpSender, { mediaType: MediaType; codec: () => Codec }>
  transformedReceivers: Set<RTCRtpReceiver>
  pendingReceiverTransforms: Map<RTCRtpReceiver, { mediaType: MediaType; userId: string }>
  pendingReceiverAudioUnblocks: Map<RTCRtpReceiver, () => void>
  pendingTransformRetryTimer: number | null
  transformWarnAt: Record<string, number>
  scriptRuntime: DaveScriptTransformRuntime | null
  sessionKeyPair: SigningKeyPair | null
  pendingSessionKeyPair: SigningKeyPair | null
}

interface BaseRuntime {
  role: RuntimeRole
  guildId: string
  channelId: string
  streamId: string
  ownerUserId: string
  sourceType: StreamSourceType
  audioMode: StreamAudioMode
  socket: WebSocket | null
  peerConnection: RTCPeerConnection | null
  heartbeatTimer: number | null
  rtcConnectionId: string
  closing: boolean
  dave: RuntimeDaveState
}

interface PublisherRuntime extends BaseRuntime {
  role: 'publisher'
  captureStream: MediaStream
  sourceStream: MediaStream
  quality: StreamQualitySettings
  senderQualities: Map<RTCRtpSender, PublisherSenderQuality>
  qualityMonitorTimer: number | null
}

interface ViewerRuntime extends BaseRuntime {
  role: 'viewer'
  mediaStream: MediaStream
}

interface PublisherSenderQuality {
  targetFrameRate: number
  maxBitrateBps: number
  minBitrateBps: number
  currentBitrateBps: number
  stableSamples: number
  pressureSamples: number
  lastAdjustmentAt: number
  lastTimestamp: number | null
  lastFramesEncoded: number | null
  lastBytesSent: number | null
}

interface StreamRebindDetail {
  stream_ids?: Array<string | number>
  jitter_ms?: number
}

interface StreamStopDetail {
  stream_id?: string | number
}

interface ExtendedDisplayMediaStreamOptions extends DisplayMediaStreamOptions {
  preferCurrentTab?: boolean
  selfBrowserSurface?: 'include' | 'exclude'
  surfaceSwitching?: 'include' | 'exclude'
  systemAudio?: 'include' | 'exclude'
  monitorTypeSurfaces?: 'include' | 'exclude'
  windowAudio?: 'exclude' | 'window' | 'system'
}

type ExtendedDisplayVideoConstraints = MediaTrackConstraints & {
  displaySurface?: 'browser' | 'monitor' | 'window'
}

type ExtendedDisplayAudioConstraints = MediaTrackConstraints & {
  suppressLocalAudioPlayback?: boolean
}

interface CapturedDisplayStream {
  stream: MediaStream
  sourceStream: MediaStream
  effectiveAudioMode: StreamAudioMode
}

type ManualCanvasCaptureTrack = MediaStreamTrack & {
  requestFrame?: () => void
}

const STREAM_QUALITY_DIMENSIONS: Record<StreamResolution, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '2160p': { width: 3840, height: 2160 },
}

const STREAM_VIDEO_BITRATE_CAPS_BPS: Record<StreamResolution, Record<StreamFrameRate, number>> = {
  '720p': {
    15: 1_500_000,
    30: 3_000_000,
    60: 4_500_000,
  },
  '1080p': {
    15: 2_500_000,
    30: 5_000_000,
    60: 7_000_000,
  },
  '1440p': {
    15: 4_000_000,
    30: 6_000_000,
    60: 8_000_000,
  },
  '2160p': {
    15: 5_000_000,
    30: 8_000_000,
    60: 12_000_000,
  },
}

const STREAM_AUDIO_BITRATE_CAP_BPS = 256_000
const STREAM_VIDEO_BITRATE_MIN_FACTOR = 0.45
const STREAM_VIDEO_BITRATE_BACKOFF_FACTOR = 0.78
const STREAM_VIDEO_BITRATE_RECOVERY_FACTOR = 1.08
const STREAM_VIDEO_QUALITY_MONITOR_INTERVAL_MS = 4_000
const STREAM_VIDEO_QUALITY_ADJUST_COOLDOWN_MS = 10_000
export const STREAM_DEBUG_OVERLAY_EVENT = 'gochat:stream-debug-overlay-change'

export interface StreamDebugTrackStats {
  kind: 'audio' | 'video'
  codec: string | null
  bitrateBps: number | null
  packetsReceived: number | null
  packetsLost: number | null
  jitterMs: number | null
  framesPerSecond?: number | null
  frameWidth?: number | null
  frameHeight?: number | null
  framesDecoded?: number | null
  framesDropped?: number | null
  totalSamplesReceived?: number | null
  concealedSamples?: number | null
}

export interface StreamDebugStats {
  streamId: string
  role: RuntimeRole
  connectionState: RTCPeerConnectionState | null
  iceConnectionState: RTCIceConnectionState | null
  signalingState: RTCSignalingState | null
  currentRoundTripTimeMs: number | null
  availableIncomingBitrateBps: number | null
  video: StreamDebugTrackStats | null
  audio: StreamDebugTrackStats | null
  updatedAt: number
}

interface StreamDebugConsole {
  enableOverlay: (streamId?: string) => void
  disableOverlay: () => void
  toggleOverlay: (streamId?: string) => void
  isOverlayEnabled: (streamId?: string) => boolean
  stats: (streamId: string) => Promise<StreamDebugStats | null>
}

declare global {
  interface Window {
    gochatStreamDebug?: StreamDebugConsole
    enableStreamDebugOverlay?: (streamId?: string) => void
    disableStreamDebugOverlay?: () => void
    toggleStreamDebugOverlay?: (streamId?: string) => void
  }
}

let publisherRuntime: PublisherRuntime | null = null
const viewerRuntimes = new Map<string, ViewerRuntime>()
let eventBindingsInitialized = false
const channelStreamSyncRetryTimers = new Map<string, number>()
const streamDebugBitrateSamples = new Map<string, { bytes: number; timestamp: number }>()
const capturedStreamCleanups = new WeakMap<MediaStream, () => void>()
const streamDebugOverlayState: { enabled: boolean; streamId: string | null } = {
  enabled: false,
  streamId: null,
}

const TAG = '%c[Stream]'
const STYLE = 'color:#0f766e;font-weight:bold'
const WARN_STYLE = 'color:#d97706;font-weight:bold'
function slog(message: string, ...args: unknown[]) {
  console.log(`${TAG} ${message}`, STYLE, ...args)
}

function swarn(message: string, ...args: unknown[]) {
  console.warn(`${TAG} ${message}`, WARN_STYLE, ...args)
}

function emitStreamDebugOverlayChange() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(STREAM_DEBUG_OVERLAY_EVENT, {
    detail: {
      enabled: streamDebugOverlayState.enabled,
      streamId: streamDebugOverlayState.streamId,
    },
  }))
}

export function setStreamDebugOverlayEnabled(enabled: boolean, streamId?: string) {
  streamDebugOverlayState.enabled = enabled
  streamDebugOverlayState.streamId = enabled && streamId ? String(streamId) : null
  emitStreamDebugOverlayChange()
  slog(
    'debug overlay %s%s',
    enabled ? 'enabled' : 'disabled',
    streamDebugOverlayState.streamId ? ` for stream ${streamDebugOverlayState.streamId}` : '',
  )
}

export function isStreamDebugOverlayEnabled(streamId?: string): boolean {
  if (!streamDebugOverlayState.enabled) return false
  if (!streamDebugOverlayState.streamId || !streamId) return true
  return streamDebugOverlayState.streamId === streamId
}

function installStreamDebugConsole() {
  if (typeof window === 'undefined') return
  const api: StreamDebugConsole = {
    enableOverlay: (streamId?: string) => setStreamDebugOverlayEnabled(true, streamId),
    disableOverlay: () => setStreamDebugOverlayEnabled(false),
    toggleOverlay: (streamId?: string) => setStreamDebugOverlayEnabled(!isStreamDebugOverlayEnabled(streamId), streamId),
    isOverlayEnabled: (streamId?: string) => isStreamDebugOverlayEnabled(streamId),
    stats: (streamId: string) => getStreamDebugStats(streamId),
  }
  window.gochatStreamDebug = api
  window.enableStreamDebugOverlay = api.enableOverlay
  window.disableStreamDebugOverlay = api.disableOverlay
  window.toggleStreamDebugOverlay = api.toggleOverlay
}

installStreamDebugConsole()

type RtcStatsLike = Record<string, unknown> & {
  id?: string
  type?: string
  timestamp?: number
}

function numberStat(report: RtcStatsLike, key: string): number | null {
  const value = report[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringStat(report: RtcStatsLike, key: string): string | null {
  const value = report[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function boolStat(report: RtcStatsLike, key: string): boolean {
  return report[key] === true
}

function clearStreamDebugSamples(streamId: string) {
  for (const key of streamDebugBitrateSamples.keys()) {
    if (key.startsWith(`${streamId}:`)) {
      streamDebugBitrateSamples.delete(key)
    }
  }
}

function codecLabel(stats: RTCStatsReport, codecId: string | null): string | null {
  if (!codecId) return null
  const codec = stats.get(codecId) as RtcStatsLike | undefined
  const mimeType = codec ? stringStat(codec, 'mimeType') : null
  if (!mimeType) return null
  const [, codecName = mimeType] = mimeType.split('/')
  const clockRate = codec ? numberStat(codec, 'clockRate') : null
  return clockRate ? `${codecName} @ ${Math.round(clockRate / 1000)}kHz` : codecName
}

function inboundTrackKind(report: RtcStatsLike): 'audio' | 'video' | null {
  const kind = stringStat(report, 'kind') ?? stringStat(report, 'mediaType')
  return kind === 'audio' || kind === 'video' ? kind : null
}

function trackBitrateBps(streamId: string, kind: 'audio' | 'video', report: RtcStatsLike): number | null {
  const bytes = numberStat(report, 'bytesReceived')
  const timestamp = numberStat(report, 'timestamp')
  const reportId = report.id ?? 'unknown'
  if (bytes === null || timestamp === null) return null

  const key = `${streamId}:${kind}:${reportId}`
  const previous = streamDebugBitrateSamples.get(key)
  streamDebugBitrateSamples.set(key, { bytes, timestamp })
  if (!previous || timestamp <= previous.timestamp || bytes < previous.bytes) return null

  return Math.round(((bytes - previous.bytes) * 8 * 1000) / (timestamp - previous.timestamp))
}

function buildInboundTrackStats(runtime: ViewerRuntime, stats: RTCStatsReport, report: RtcStatsLike): StreamDebugTrackStats | null {
  const kind = inboundTrackKind(report)
  if (!kind) return null

  const jitter = numberStat(report, 'jitter')
  return {
    kind,
    codec: codecLabel(stats, stringStat(report, 'codecId')),
    bitrateBps: trackBitrateBps(runtime.streamId, kind, report),
    packetsReceived: numberStat(report, 'packetsReceived'),
    packetsLost: numberStat(report, 'packetsLost'),
    jitterMs: jitter === null ? null : Math.round(jitter * 1000),
    framesPerSecond: kind === 'video' ? numberStat(report, 'framesPerSecond') : undefined,
    frameWidth: kind === 'video' ? numberStat(report, 'frameWidth') : undefined,
    frameHeight: kind === 'video' ? numberStat(report, 'frameHeight') : undefined,
    framesDecoded: kind === 'video' ? numberStat(report, 'framesDecoded') : undefined,
    framesDropped: kind === 'video' ? numberStat(report, 'framesDropped') : undefined,
    totalSamplesReceived: kind === 'audio' ? numberStat(report, 'totalSamplesReceived') : undefined,
    concealedSamples: kind === 'audio' ? numberStat(report, 'concealedSamples') : undefined,
  }
}

function selectedCandidateStats(stats: RTCStatsReport): {
  currentRoundTripTimeMs: number | null
  availableIncomingBitrateBps: number | null
} {
  for (const raw of stats.values()) {
    const report = raw as RtcStatsLike
    if (report.type !== 'candidate-pair') continue
    const selected = boolStat(report, 'selected')
      || (boolStat(report, 'nominated') && stringStat(report, 'state') === 'succeeded')
    if (!selected) continue

    const rtt = numberStat(report, 'currentRoundTripTime')
    return {
      currentRoundTripTimeMs: rtt === null ? null : Math.round(rtt * 1000),
      availableIncomingBitrateBps: numberStat(report, 'availableIncomingBitrate'),
    }
  }
  return { currentRoundTripTimeMs: null, availableIncomingBitrateBps: null }
}

export async function getStreamDebugStats(streamId: string): Promise<StreamDebugStats | null> {
  const runtime = viewerRuntimes.get(streamId)
  const pc = runtime?.peerConnection
  if (!runtime || !pc) return null

  const stats = await pc.getStats()
  let video: StreamDebugTrackStats | null = null
  let audio: StreamDebugTrackStats | null = null

  for (const raw of stats.values()) {
    const report = raw as RtcStatsLike
    if (report.type !== 'inbound-rtp' || report.isRemote === true) continue
    const trackStats = buildInboundTrackStats(runtime, stats, report)
    if (!trackStats) continue
    if (trackStats.kind === 'video') {
      video = video ?? trackStats
    } else {
      audio = audio ?? trackStats
    }
  }

  const candidate = selectedCandidateStats(stats)
  return {
    streamId,
    role: runtime.role,
    connectionState: pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    signalingState: pc.signalingState,
    currentRoundTripTimeMs: candidate.currentRoundTripTimeMs,
    availableIncomingBitrateBps: candidate.availableIncomingBitrateBps,
    video,
    audio,
    updatedAt: Date.now(),
  }
}

function parseGatewayMessage(event: MessageEvent): GatewayEnvelope | null {
  try {
    return _bigJsonParse.parse(event.data as string) as GatewayEnvelope
  } catch {
    return null
  }
}

function sendGatewayPacket(socket: WebSocket, payload: unknown) {
  socket.send(stringifyVoiceGatewayPacket(payload))
}

function buildSignalUrl(url: string): string {
  try {
    const next = new URL(url)
    next.searchParams.set('v', '2')
    return next.toString()
  } catch {
    return url.includes('?') ? `${url}&v=2` : `${url}?v=2`
  }
}

function getStreamResolutionDimensions(resolution: StreamResolution): { width: number; height: number } {
  return STREAM_QUALITY_DIMENSIONS[resolution]
}

function getStreamVideoBitrateCap(quality: StreamQualitySettings): number {
  return STREAM_VIDEO_BITRATE_CAPS_BPS[quality.resolution][quality.frameRate]
}

function readyBitrateCapBps(kbps: number | undefined): number | undefined {
  const value = Number(kbps)
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.max(1, Math.floor(value * 1000))
}

function applyServerBitrateCap(desiredBps: number, serverCapBps: number | undefined): number {
  return serverCapBps && serverCapBps > 0 ? Math.min(desiredBps, serverCapBps) : desiredBps
}

function clampBitrate(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)))
}

function videoCodecPreferenceRank(codec: RTCRtpCodec): number {
  const mime = codec.mimeType.toLowerCase()
  if (mime === 'video/vp9') return 0
  if (mime === 'video/vp8') return 1
  if (mime === 'video/h264') {
    const fmtp = codec.sdpFmtpLine?.toLowerCase() ?? ''
    return fmtp.includes('packetization-mode=1') ? 2 : 3
  }
  if (mime === 'video/av1') return 4
  if (mime === 'video/rtx') return 20
  return 10
}

function applyStreamVideoCodecPreferences(
  transceiver: RTCRtpTransceiver | undefined,
  capabilities: RTCRtpCapabilities | null | undefined,
  streamId: string,
  direction: 'send' | 'receive',
) {
  if (!transceiver?.setCodecPreferences || !capabilities?.codecs?.length) return

  const preferred = [...capabilities.codecs].sort((left, right) => (
    videoCodecPreferenceRank(left) - videoCodecPreferenceRank(right)
  ))
  try {
    transceiver.setCodecPreferences(preferred)
    const firstVideoCodec = preferred.find((codec) => codec.mimeType.toLowerCase().startsWith('video/') && codec.mimeType.toLowerCase() !== 'video/rtx')
    slog('preferred %s stream video codec for %s -> %s', direction, streamId, firstVideoCodec?.mimeType ?? 'browser default')
  } catch (error) {
    swarn('unable to set stream codec preferences for %s: %o', streamId, error)
  }
}

function preferStreamSenderVideoCodec(pc: RTCPeerConnection, sender: RTCRtpSender, streamId: string) {
  applyStreamVideoCodecPreferences(
    pc.getTransceivers().find((item) => item.sender === sender),
    RTCRtpSender.getCapabilities?.('video'),
    streamId,
    'send',
  )
}

function preferStreamReceiverVideoCodec(transceiver: RTCRtpTransceiver, streamId: string) {
  applyStreamVideoCodecPreferences(
    transceiver,
    RTCRtpReceiver.getCapabilities?.('video') ?? RTCRtpSender.getCapabilities?.('video'),
    streamId,
    'receive',
  )
}

function setTrackContentHint(track: MediaStreamTrack, quality: StreamQualitySettings) {
  if (track.kind !== 'video') return
  try {
    track.contentHint = quality.frameRate >= 30 ? 'motion' : 'detail'
  } catch {
    // Older browser builds can expose contentHint as read-only.
  }
}

async function setSenderVideoBitrate(
  sender: RTCRtpSender,
  bitrateBps: number,
  targetFrameRate: number,
) {
  const parameters = sender.getParameters()
  parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}]
  for (const encoding of parameters.encodings) {
    encoding.maxBitrate = bitrateBps
    encoding.maxFramerate = targetFrameRate
    encoding.scaleResolutionDownBy = 1
  }
  ;(parameters as RTCRtpSendParameters & {
    degradationPreference?: RTCDegradationPreference
  }).degradationPreference = 'maintain-framerate'
  await sender.setParameters(parameters)
}

function registerPublisherSenderQuality(
  runtime: PublisherRuntime,
  sender: RTCRtpSender,
  track: MediaStreamTrack,
  appliedMaxBitrate: number,
) {
  if (track.kind !== 'video' || appliedMaxBitrate <= 0) return
  const adaptiveMin = Math.round(appliedMaxBitrate * STREAM_VIDEO_BITRATE_MIN_FACTOR)
  runtime.senderQualities.set(sender, {
    targetFrameRate: runtime.quality.frameRate,
    maxBitrateBps: appliedMaxBitrate,
    minBitrateBps: Math.max(800_000, Math.min(appliedMaxBitrate, adaptiveMin)),
    currentBitrateBps: appliedMaxBitrate,
    stableSamples: 0,
    pressureSamples: 0,
    lastAdjustmentAt: 0,
    lastTimestamp: null,
    lastFramesEncoded: null,
    lastBytesSent: null,
  })
}

function clearPublisherQualityMonitor(runtime: PublisherRuntime) {
  if (runtime.qualityMonitorTimer !== null) {
    window.clearInterval(runtime.qualityMonitorTimer)
    runtime.qualityMonitorTimer = null
  }
  runtime.senderQualities.clear()
}

function outboundVideoStats(stats: RTCStatsReport): RtcStatsLike | null {
  for (const raw of stats.values()) {
    const report = raw as RtcStatsLike
    if (report.type !== 'outbound-rtp' || report.isRemote === true) continue
    const kind = stringStat(report, 'kind') ?? stringStat(report, 'mediaType')
    if (kind === 'video') return report
  }
  return null
}

async function updatePublisherSenderBitrate(
  runtime: PublisherRuntime,
  sender: RTCRtpSender,
  quality: PublisherSenderQuality,
  nextBitrateBps: number,
  reason: string,
) {
  const next = clampBitrate(nextBitrateBps, quality.minBitrateBps, quality.maxBitrateBps)
  if (Math.abs(next - quality.currentBitrateBps) < 250_000) return

  try {
    await setSenderVideoBitrate(sender, next, quality.targetFrameRate)
    slog(
      'adaptive bitrate %s for stream %s: %d -> %d bps (%s)',
      next < quality.currentBitrateBps ? 'backoff' : 'recovery',
      runtime.streamId,
      quality.currentBitrateBps,
      next,
      reason,
    )
    quality.currentBitrateBps = next
    quality.lastAdjustmentAt = Date.now()
    quality.pressureSamples = 0
    quality.stableSamples = 0
  } catch (error) {
    swarn('adaptive bitrate update failed for stream %s: %o', runtime.streamId, error)
  }
}

async function monitorPublisherSenderQuality(
  runtime: PublisherRuntime,
  sender: RTCRtpSender,
  quality: PublisherSenderQuality,
) {
  const stats = await sender.getStats()
  const report = outboundVideoStats(stats)
  if (!report) return

  const timestamp = numberStat(report, 'timestamp')
  const framesEncoded = numberStat(report, 'framesEncoded')
  const bytesSent = numberStat(report, 'bytesSent')
  const reportedFps = numberStat(report, 'framesPerSecond')
  const limitationReason = stringStat(report, 'qualityLimitationReason') ?? 'none'

  let measuredFps = reportedFps
  if (
    measuredFps === null
    && timestamp !== null
    && framesEncoded !== null
    && quality.lastTimestamp !== null
    && quality.lastFramesEncoded !== null
    && timestamp > quality.lastTimestamp
    && framesEncoded >= quality.lastFramesEncoded
  ) {
    measuredFps = ((framesEncoded - quality.lastFramesEncoded) * 1000) / (timestamp - quality.lastTimestamp)
  }

  let measuredBitrate: number | null = null
  if (
    timestamp !== null
    && bytesSent !== null
    && quality.lastTimestamp !== null
    && quality.lastBytesSent !== null
    && timestamp > quality.lastTimestamp
    && bytesSent >= quality.lastBytesSent
  ) {
    measuredBitrate = ((bytesSent - quality.lastBytesSent) * 8 * 1000) / (timestamp - quality.lastTimestamp)
  }

  const hasBaseline = quality.lastTimestamp !== null
  quality.lastTimestamp = timestamp
  quality.lastFramesEncoded = framesEncoded
  quality.lastBytesSent = bytesSent
  if (!hasBaseline) return

  const lowFps = measuredFps !== null && quality.targetFrameRate >= 30 && measuredFps < quality.targetFrameRate * 0.72
  const pressure = limitationReason === 'cpu' || limitationReason === 'bandwidth' || lowFps
  if (pressure) {
    quality.pressureSamples += 1
    quality.stableSamples = 0
  } else {
    quality.stableSamples += 1
    quality.pressureSamples = 0
  }

  const now = Date.now()
  if (now - quality.lastAdjustmentAt < STREAM_VIDEO_QUALITY_ADJUST_COOLDOWN_MS) return

  if (quality.pressureSamples >= 2 && quality.currentBitrateBps > quality.minBitrateBps) {
    const detail = `reason=${limitationReason} fps=${measuredFps === null ? 'n/a' : measuredFps.toFixed(1)} bitrate=${measuredBitrate === null ? 'n/a' : Math.round(measuredBitrate)}`
    await updatePublisherSenderBitrate(
      runtime,
      sender,
      quality,
      quality.currentBitrateBps * STREAM_VIDEO_BITRATE_BACKOFF_FACTOR,
      detail,
    )
    return
  }

  if (quality.stableSamples >= 6 && quality.currentBitrateBps < quality.maxBitrateBps) {
    await updatePublisherSenderBitrate(
      runtime,
      sender,
      quality,
      quality.currentBitrateBps * STREAM_VIDEO_BITRATE_RECOVERY_FACTOR,
      'stable encoder stats',
    )
  }
}

function ensurePublisherQualityMonitor(runtime: PublisherRuntime) {
  if (runtime.qualityMonitorTimer !== null || runtime.senderQualities.size === 0) return
  runtime.qualityMonitorTimer = window.setInterval(() => {
    if (runtime.closing || runtime.peerConnection?.connectionState !== 'connected') return
    for (const [sender, quality] of runtime.senderQualities) {
      void monitorPublisherSenderQuality(runtime, sender, quality).catch((error) => {
        swarn('stream quality monitor failed for %s: %o', runtime.streamId, error)
      })
    }
  }, STREAM_VIDEO_QUALITY_MONITOR_INTERVAL_MS)
}

async function applyHighQualitySenderParameters(
  sender: RTCRtpSender,
  track: MediaStreamTrack,
  quality: StreamQualitySettings,
  streamId: string,
  serverVideoCapBps?: number,
  serverAudioCapBps?: number,
): Promise<number> {
  try {
    const parameters = sender.getParameters()
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}]

    let appliedMaxBitrate = 0
    if (track.kind === 'video') {
      const maxBitrate = applyServerBitrateCap(getStreamVideoBitrateCap(quality), serverVideoCapBps)
      appliedMaxBitrate = maxBitrate
      await setSenderVideoBitrate(sender, maxBitrate, quality.frameRate)
    } else if (track.kind === 'audio') {
      const maxBitrate = applyServerBitrateCap(STREAM_AUDIO_BITRATE_CAP_BPS, serverAudioCapBps)
      appliedMaxBitrate = maxBitrate
      for (const encoding of parameters.encodings) {
        encoding.maxBitrate = maxBitrate
      }
      await sender.setParameters(parameters)
    }

    slog(
      'sender quality parameters applied for stream %s kind=%s maxBitrate=%d',
      streamId,
      track.kind,
      appliedMaxBitrate,
    )
    return appliedMaxBitrate
  } catch (error) {
    swarn(
      'unable to apply sender quality parameters for stream %s kind=%s: %o',
      streamId,
      track.kind,
      error,
    )
    return 0
  }
}

function toIceServers(servers: GatewayIceServer[] | undefined): RTCIceServer[] {
  return (servers ?? [])
    .filter((server) => Array.isArray(server.urls) && server.urls.length > 0)
    .map((server) => ({
      urls: server.urls!,
      username: server.username,
      credential: server.credential,
    }))
}

function stopMediaStream(stream: MediaStream | null) {
  if (!stream) return
  const cleanup = capturedStreamCleanups.get(stream)
  if (cleanup) {
    capturedStreamCleanups.delete(stream)
    cleanup()
  }
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // noop
    }
  }
}

function clearHeartbeat(runtime: BaseRuntime) {
  if (runtime.heartbeatTimer !== null) {
    clearInterval(runtime.heartbeatTimer)
    runtime.heartbeatTimer = null
  }
}

function closeSocket(socket: WebSocket | null) {
  if (!socket) return
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close()
  }
}

async function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return

  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(cleanup, 2_000)

    function cleanup() {
      window.clearTimeout(timeout)
      pc.removeEventListener('icegatheringstatechange', handleStateChange)
      resolve()
    }

    function handleStateChange() {
      if (pc.iceGatheringState === 'complete') {
        cleanup()
      }
    }

    pc.addEventListener('icegatheringstatechange', handleStateChange)
  })
}

function currentUserId(): string {
  return String(useAuthStore.getState().user?.id ?? '')
}

function randomJitter(maxMs: number): number {
  return maxMs > 0 ? Math.floor(Math.random() * maxMs) : 0
}

function normalizeStreamQuality(quality: Partial<StreamQualitySettings> | null | undefined): StreamQualitySettings {
  const resolution = STREAM_RESOLUTION_OPTIONS.includes((quality?.resolution ?? '') as StreamResolution)
    ? quality!.resolution as StreamResolution
    : DEFAULT_STREAM_QUALITY.resolution
  const frameRate = STREAM_FRAME_RATE_OPTIONS.includes((quality?.frameRate ?? 0) as StreamFrameRate)
    ? quality!.frameRate as StreamFrameRate
    : DEFAULT_STREAM_QUALITY.frameRate
  return { resolution, frameRate }
}

function isNumericUserId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d+$/.test(value)
}

function supportsEncodedTransforms(): boolean {
  return supportsAnyEncodedTransforms()
}

function shouldUseScriptEncodedTransforms(): boolean {
  return !supportsDirectEncodedTransforms() && supportsScriptEncodedTransforms()
}

function createDaveState(): RuntimeDaveState {
  return {
    enabled: false,
    required: false,
    mode: 'passthrough',
    protocolVersion: 0,
    epoch: 0,
    lastTransitionReadySent: null,
    lastExecutedTransitionId: null,
    invalidCommitRequestedForTransition: null,
    decryptRecreateRequests: 0,
    decryptFailures: new Map(),
    session: null,
    pendingSession: null,
    weCommitted: false,
    awaitingWelcome: false,
    pendingTransitionId: null,
    negotiatedVideoCodec: Codec.UNKNOWN,
    transformedSenders: new Set(),
    pendingSenderTransforms: new Map(),
    transformedReceivers: new Set(),
    pendingReceiverTransforms: new Map(),
    pendingReceiverAudioUnblocks: new Map(),
    pendingTransformRetryTimer: null,
    transformWarnAt: {},
    scriptRuntime: null,
    sessionKeyPair: null,
    pendingSessionKeyPair: null,
  }
}

type WithEncodedStreams = {
  createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream }
}

type EncodedFrame = {
  data: ArrayBuffer
}

function warnDaveTransformLimited(runtime: BaseRuntime, key: string, message: string, ...args: unknown[]) {
  const now = Date.now()
  if ((runtime.dave.transformWarnAt[key] ?? 0) + DAVE_TRANSFORM_WARN_INTERVAL_MS > now) {
    return
  }
  runtime.dave.transformWarnAt[key] = now
  swarn(message, ...args)
}

function looksLikeDaveEncryptedFrame(data: ArrayBufferLike | Uint8Array): boolean {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  return bytes.length >= 2 && bytes[bytes.length - 2] === 0xfa && bytes[bytes.length - 1] === 0xfa
}

function shouldExpectDaveMediaPath(runtime: BaseRuntime): boolean {
  return runtime.dave.enabled &&
    (runtime.dave.required || runtime.dave.protocolVersion > 0 || runtime.dave.mode !== 'passthrough')
}

function currentDaveControlTarget(runtime: BaseRuntime): 'active' | 'pending' {
  return runtime.dave.pendingSession ? 'pending' : 'active'
}

function ensureRuntimeDaveScriptRuntime(runtime: BaseRuntime): DaveScriptTransformRuntime | null {
  if (!shouldUseScriptEncodedTransforms()) {
    return null
  }
  if (!runtime.dave.scriptRuntime) {
    runtime.dave.scriptRuntime = new DaveScriptTransformRuntime(
      runtime.role === 'publisher'
        ? `[Stream][publisher:${runtime.streamId}]`
        : `[Stream][viewer:${runtime.streamId}]`,
    )
  }
  return runtime.dave.scriptRuntime
}

function syncRuntimeDaveScriptState(runtime: BaseRuntime) {
  runtime.dave.scriptRuntime?.setState({
    enabled: runtime.dave.enabled,
    required: runtime.dave.required,
    mode: runtime.dave.mode,
    protocolVersion: runtime.dave.protocolVersion,
    negotiatedVideoCodec: runtime.dave.negotiatedVideoCodec,
  })
}

function createDaveSession(runtime: BaseRuntime, protocolVersion: number, keyPair: SigningKeyPair): DAVESession {
  const session = new DAVESession(protocolVersion, currentUserId(), runtime.streamId, keyPair)
  session.setPassthroughMode(true)
  return session
}

function resetDaveTransitionState(runtime: BaseRuntime) {
  runtime.dave.weCommitted = false
  runtime.dave.awaitingWelcome = false
}

function resetDaveRuntime(runtime: BaseRuntime) {
  if (runtime.dave.pendingTransformRetryTimer !== null) {
    window.clearTimeout(runtime.dave.pendingTransformRetryTimer)
    runtime.dave.pendingTransformRetryTimer = null
  }
  runtime.dave.pendingSession?.dispose()
  runtime.dave.pendingSession = null
  runtime.dave.session?.dispose()
  runtime.dave.session = null
  runtime.dave.scriptRuntime?.disposeSessions('all')
  runtime.dave.sessionKeyPair = null
  runtime.dave.pendingSessionKeyPair = null
  runtime.dave.enabled = false
  runtime.dave.required = false
  runtime.dave.mode = 'passthrough'
  runtime.dave.protocolVersion = 0
  runtime.dave.epoch = 0
  runtime.dave.lastTransitionReadySent = null
  runtime.dave.lastExecutedTransitionId = null
  runtime.dave.invalidCommitRequestedForTransition = null
  runtime.dave.decryptRecreateRequests = 0
  runtime.dave.decryptFailures.clear()
  runtime.dave.pendingTransitionId = null
  runtime.dave.negotiatedVideoCodec = Codec.UNKNOWN
  runtime.dave.transformedSenders.clear()
  runtime.dave.pendingSenderTransforms.clear()
  runtime.dave.pendingReceiverTransforms.clear()
  runtime.dave.transformedReceivers.clear()
  runtime.dave.pendingReceiverAudioUnblocks.clear()
  runtime.dave.transformWarnAt = {}
  runtime.dave.scriptRuntime?.dispose()
  runtime.dave.scriptRuntime = null
  resetDaveTransitionState(runtime)
}

function currentDaveMediaSession(runtime: BaseRuntime): DAVESession | null {
  return runtime.dave.session
}

function currentDaveControlSession(runtime: BaseRuntime): DAVESession | null {
  return runtime.dave.pendingSession ?? runtime.dave.session
}

function initializeDaveSession(runtime: BaseRuntime, protocolVersion = 1): DAVESession {
  runtime.dave.pendingSession?.dispose()
  runtime.dave.pendingSession = null
  runtime.dave.pendingSessionKeyPair = null
  runtime.dave.session?.dispose()
  runtime.dave.sessionKeyPair = generateP256Keypair()
  runtime.dave.session = createDaveSession(runtime, protocolVersion, runtime.dave.sessionKeyPair)
  runtime.dave.scriptRuntime?.createSession('active', protocolVersion, currentUserId(), runtime.streamId, runtime.dave.sessionKeyPair)
  syncRuntimeDaveScriptState(runtime)
  resetDaveTransitionState(runtime)
  return runtime.dave.session
}

function beginDaveUpgrade(runtime: BaseRuntime, protocolVersion = 1): DAVESession {
  resetDaveTransitionState(runtime)
  if (runtime.dave.protocolVersion > 0 && runtime.dave.session) {
    runtime.dave.pendingSession?.dispose()
    runtime.dave.pendingSessionKeyPair = generateP256Keypair()
    runtime.dave.pendingSession = createDaveSession(runtime, protocolVersion, runtime.dave.pendingSessionKeyPair)
    runtime.dave.scriptRuntime?.createSession('pending', protocolVersion, currentUserId(), runtime.streamId, runtime.dave.pendingSessionKeyPair)
    syncRuntimeDaveScriptState(runtime)
    return runtime.dave.pendingSession
  }

  runtime.dave.pendingSession?.dispose()
  runtime.dave.pendingSession = null
  runtime.dave.pendingSessionKeyPair = null
  runtime.dave.session?.dispose()
  runtime.dave.sessionKeyPair = generateP256Keypair()
  runtime.dave.session = createDaveSession(runtime, protocolVersion, runtime.dave.sessionKeyPair)
  runtime.dave.scriptRuntime?.createSession('active', protocolVersion, currentUserId(), runtime.streamId, runtime.dave.sessionKeyPair)
  syncRuntimeDaveScriptState(runtime)
  return runtime.dave.session
}

function mapCodecNameToDaveCodec(name?: string): Codec {
  switch ((name ?? '').toUpperCase()) {
    case 'OPUS':
      return Codec.OPUS
    case 'VP8':
      return Codec.VP8
    case 'VP9':
      return Codec.VP9
    case 'H264':
      return Codec.H264
    case 'H265':
      return Codec.H265
    case 'AV1':
      return Codec.AV1
    default:
      return Codec.UNKNOWN
  }
}

function updatePublishingState(
  connectionState: 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'error',
  error: string | null = null,
) {
  useStreamStore.getState().updatePublishing({ connectionState, error })
}

function updateWatchingState(
  streamId: string,
  connectionState: 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'error',
  error: string | null = null,
) {
  useStreamStore.getState().updateWatchedStream(streamId, { connectionState, error })
}

function httpStatus(error: unknown): number | null {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status
  return typeof status === 'number' ? status : null
}

function channelSyncKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`
}

function clearChannelStreamsSyncRetry(guildId: string, channelId: string) {
  const key = channelSyncKey(guildId, channelId)
  const timer = channelStreamSyncRetryTimers.get(key)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    channelStreamSyncRetryTimers.delete(key)
  }
}

function scheduleChannelStreamsSyncRetry(guildId: string, channelId: string, attempt: number) {
  if (typeof window === 'undefined') return

  const voice = useVoiceStore.getState()
  if (voice.channelId !== channelId || voice.guildId !== guildId || voice.connectionState === 'disconnected') {
    return
  }

  const key = channelSyncKey(guildId, channelId)
  if (channelStreamSyncRetryTimers.has(key)) return

  const delayMs = Math.min(8_000, 500 * 2 ** Math.max(0, attempt - 1))
  const timer = window.setTimeout(() => {
    channelStreamSyncRetryTimers.delete(key)
    void syncChannelStreams(guildId, channelId, attempt + 1)
  }, delayMs)
  channelStreamSyncRetryTimers.set(key, timer)
}

function attachPassthroughSenderTransform(
  runtime: BaseRuntime,
  sender: RTCRtpSender,
  mediaType: MediaType,
  codec: () => Codec,
): boolean {
  if (runtime.dave.transformedSenders.has(sender)) return true

  const streamSender = sender as RTCRtpSender & WithEncodedStreams
  if (typeof streamSender.createEncodedStreams !== 'function') {
    const scriptRuntime = ensureRuntimeDaveScriptRuntime(runtime)
    if (!scriptRuntime?.attachSender(sender, mediaType)) {
      return false
    }
    runtime.dave.transformedSenders.add(sender)
    runtime.dave.pendingSenderTransforms.delete(sender)
    return true
  }

  try {
    const { readable, writable } = streamSender.createEncodedStreams()
    readable
      .pipeThrough(
        new TransformStream({
          transform(frame: EncodedFrame, controller) {
            const activeSession = currentDaveMediaSession(runtime)
            if (shouldExpectDaveMediaPath(runtime)) {
              if (!activeSession?.ready) {
                warnDaveTransformLimited(runtime, 'sender-not-ready', 'DAVE: dropping outbound stream frame while session is not ready')
                return
              }
              try {
                const selectedCodec = codec()
                if (mediaType === MediaType.VIDEO && selectedCodec === Codec.UNKNOWN) {
                  controller.enqueue(frame)
                  return
                }
                const encrypted = activeSession.encrypt(mediaType, selectedCodec, Buffer.from(new Uint8Array(frame.data)))
                if (!encrypted) {
                  warnDaveTransformLimited(runtime, `sender-encrypt-${mediaType}-null`, 'DAVE: dropping outbound stream frame after recoverable encrypt skip')
                  return
                }
                const buffer = new ArrayBuffer(encrypted.byteLength)
                new Uint8Array(buffer).set(encrypted)
                frame.data = buffer
              } catch (error) {
                warnDaveTransformLimited(runtime, `sender-encrypt-${mediaType}`, 'DAVE: dropping outbound stream frame after encrypt error: %o', error)
                return
              }
            }
            controller.enqueue(frame)
          },
        }),
      )
      .pipeTo(writable)
      .catch(() => undefined)
    runtime.dave.transformedSenders.add(sender)
    runtime.dave.pendingSenderTransforms.delete(sender)
    return true
  } catch {
    return false
  }
}

function attachPassthroughReceiverTransform(
  runtime: BaseRuntime,
  receiver: RTCRtpReceiver,
  mediaType: MediaType,
  userId: string,
): boolean {
  if (runtime.dave.transformedReceivers.has(receiver)) return true

  const streamReceiver = receiver as RTCRtpReceiver & WithEncodedStreams
  if (typeof streamReceiver.createEncodedStreams !== 'function') {
    const scriptRuntime = ensureRuntimeDaveScriptRuntime(runtime)
    if (!scriptRuntime?.attachReceiver(receiver, mediaType, userId)) {
      return false
    }
    runtime.dave.transformedReceivers.add(receiver)
    runtime.dave.pendingReceiverTransforms.delete(receiver)
    runtime.dave.pendingReceiverAudioUnblocks.get(receiver)?.()
    runtime.dave.pendingReceiverAudioUnblocks.delete(receiver)
    return true
  }

  try {
    const { readable, writable } = streamReceiver.createEncodedStreams()
    readable
      .pipeThrough(
        new TransformStream({
          transform(frame: EncodedFrame, controller) {
            const activeSession = currentDaveMediaSession(runtime)
            const rawFrame = new Uint8Array(frame.data)
            const encryptedHint = looksLikeDaveEncryptedFrame(rawFrame)
            const shouldUseDave = Boolean(userId) && (shouldExpectDaveMediaPath(runtime) || encryptedHint)

            if (shouldUseDave) {
              if (!activeSession?.ready) {
                warnDaveTransformLimited(
                  runtime,
                  `receiver-not-ready-${userId}-${encryptedHint ? 'encrypted' : 'pending'}`,
                  encryptedHint
                    ? 'DAVE: dropping encrypted inbound stream frame for userId=%s while session is not ready'
                    : 'DAVE: dropping inbound stream frame for userId=%s while session is not ready',
                  userId,
                )
                return
              }

              try {
                const decrypted = activeSession.decrypt(userId, mediaType, Buffer.from(rawFrame))
                if (!decrypted) {
                  if (!encryptedHint && activeSession.canPassthrough(userId)) {
                    controller.enqueue(frame)
                    return
                  }
                  if (encryptedHint) {
                    trackDaveEncryptedDecryptFailure(runtime, userId, mediaType, 'decrypt returned no frame')
                  }
                  warnDaveTransformLimited(
                    runtime,
                    `receiver-decrypt-${userId}-${encryptedHint ? 'encrypted' : 'pending'}`,
                    encryptedHint
                      ? 'DAVE: dropping undecryptable encrypted inbound stream frame for userId=%s'
                      : 'DAVE: dropping inbound stream frame after recoverable decrypt skip for userId=%s',
                    userId,
                  )
                  return
                }
                const buffer = new ArrayBuffer(decrypted.byteLength)
                new Uint8Array(buffer).set(decrypted)
                frame.data = buffer
                runtime.dave.decryptRecreateRequests = 0
                resetDaveDecryptFailures(runtime, userId, mediaType)
              } catch (error) {
                if (!encryptedHint && activeSession.canPassthrough(userId)) {
                  controller.enqueue(frame)
                  return
                }
                if (encryptedHint) {
                  trackDaveEncryptedDecryptFailure(runtime, userId, mediaType, 'decrypt threw')
                }
                warnDaveTransformLimited(
                  runtime,
                  `receiver-decrypt-error-${userId}-${encryptedHint ? 'encrypted' : 'pending'}`,
                  encryptedHint
                    ? 'DAVE: dropping undecryptable encrypted inbound stream frame for userId=%s: %o'
                    : 'DAVE: dropping undecryptable inbound stream frame for userId=%s: %o',
                  userId,
                  error,
                )
                return
              }
            }

            controller.enqueue(frame)
          },
        }),
      )
      .pipeTo(writable)
      .catch(() => undefined)

    runtime.dave.transformedReceivers.add(receiver)
    runtime.dave.pendingReceiverTransforms.delete(receiver)
    runtime.dave.pendingReceiverAudioUnblocks.get(receiver)?.()
    runtime.dave.pendingReceiverAudioUnblocks.delete(receiver)
    return true
  } catch (error) {
    swarn('DAVE: attachPassthroughReceiverTransform failed for stream %s userId=%s: %o', runtime.streamId, userId, error)
    return false
  }
}

function retryPendingReceiverTransforms(runtime: BaseRuntime) {
  if (!runtime.dave.enabled || runtime.dave.pendingReceiverTransforms.size === 0) return
  for (const [receiver, { mediaType, userId }] of [...runtime.dave.pendingReceiverTransforms.entries()]) {
    if (attachPassthroughReceiverTransform(runtime, receiver, mediaType, userId)) {
      slog('DAVE: receiver transform attached on retry for stream %s userId=%s', runtime.streamId, userId)
    }
  }
}

function retryPendingSenderTransforms(runtime: BaseRuntime) {
  if (!runtime.dave.enabled || runtime.dave.pendingSenderTransforms.size === 0) return
  for (const [sender, { mediaType, codec }] of [...runtime.dave.pendingSenderTransforms.entries()]) {
    if (attachPassthroughSenderTransform(runtime, sender, mediaType, codec)) {
      slog(
        'DAVE: sender transform attached on retry for stream %s kind=%s',
        runtime.streamId,
        sender.track?.kind ?? 'unknown',
      )
    }
  }
}

function schedulePendingTransformRetry(runtime: BaseRuntime, delayMs = 150) {
  if (runtime.closing || runtime.dave.pendingTransformRetryTimer !== null) {
    return
  }

  runtime.dave.pendingTransformRetryTimer = window.setTimeout(() => {
    runtime.dave.pendingTransformRetryTimer = null

    if (runtime.closing) {
      return
    }

    retryPendingReceiverTransforms(runtime)
    retryPendingSenderTransforms(runtime)

    if (
      runtime.dave.pendingReceiverTransforms.size > 0 ||
      runtime.dave.pendingSenderTransforms.size > 0
    ) {
      schedulePendingTransformRetry(runtime, 250)
    }
  }, delayMs)
}

function daveVarint(value: number): Uint8Array {
  if (value < 64) return new Uint8Array([value])
  if (value < 16384) {
    const encoded = (0x40 << 8) | value
    return new Uint8Array([encoded >> 8, encoded & 0xff])
  }
  const encoded = (0x80000000 | value) >>> 0
  return new Uint8Array([encoded >>> 24, (encoded >>> 16) & 0xff, (encoded >>> 8) & 0xff, encoded & 0xff])
}

function daveOpaqueVec(value: Uint8Array): Uint8Array {
  const lengthBytes = daveVarint(value.length)
  const out = new Uint8Array(lengthBytes.length + value.length)
  out.set(lengthBytes)
  out.set(value, lengthBytes.length)
  return out
}

function encodeKeyPackage(payload: Uint8Array): Uint8Array {
  const opaque = daveOpaqueVec(payload)
  const out = new Uint8Array(1 + opaque.length)
  out[0] = DAVE_BIN_KEY_PACKAGE
  out.set(opaque, 1)
  return out
}

function encodeCommitWelcome(commit: Uint8Array, welcome?: Uint8Array): Uint8Array {
  const commitOpaque = daveOpaqueVec(commit)
  const welcomeOpaque = welcome && welcome.length > 0 ? daveOpaqueVec(welcome) : new Uint8Array(0)
  const out = new Uint8Array(1 + commitOpaque.length + welcomeOpaque.length)
  out[0] = DAVE_BIN_COMMIT_WELCOME
  out.set(commitOpaque, 1)
  if (welcomeOpaque.length > 0) {
    out.set(welcomeOpaque, 1 + commitOpaque.length)
  }
  return out
}

function daveReadVarint(data: Uint8Array, offset: number): { value: number; consumed: number } {
  if (data.length <= offset) throw new Error('DAVE varint truncated')
  const prefix = data[offset] >> 6
  if (prefix === 3) throw new Error('DAVE varint invalid prefix')
  const byteCount = 1 << prefix
  if (data.length - offset < byteCount) throw new Error('DAVE varint truncated')
  let value = data[offset] & 0x3f
  for (let index = 1; index < byteCount; index += 1) {
    value = (value << 8) | data[offset + index]
  }
  return { value, consumed: byteCount }
}

function daveReadOpaqueVec(data: Uint8Array, offset: number): { bytes: Uint8Array; consumed: number } {
  const { value, consumed } = daveReadVarint(data, offset)
  const start = offset + consumed
  if (start + value > data.length) throw new Error('DAVE opaque vec truncated')
  return { bytes: data.slice(start, start + value), consumed: consumed + value }
}

function sendDaveTransitionReady(runtime: BaseRuntime, transitionId: number) {
  if (!runtime.socket || runtime.socket.readyState !== WebSocket.OPEN) return
  if (runtime.dave.lastTransitionReadySent === transitionId) {
    slog(
      'DAVE: duplicate transition ready suppressed for stream %s transitionId=%d',
      runtime.streamId,
      transitionId,
    )
    return
  }
  runtime.dave.lastTransitionReadySent = transitionId
  runtime.dave.pendingTransitionId = transitionId
  sendGatewayPacket(runtime.socket, { op: GW_DAVE_TRANSITION_READY, d: { transition_id: transitionId } })
  slog('DAVE: transition ready for stream %s transitionId=%d', runtime.streamId, transitionId)
}

function normalizeDaveTransitionId(value: unknown): number | null {
  let transitionId = NaN
  if (typeof value === 'number') {
    transitionId = value
  } else if (typeof value === 'string') {
    transitionId = Number(value)
  }
  return Number.isInteger(transitionId) && transitionId >= 0 ? transitionId : null
}

function requestDaveEpochRecreate(runtime: BaseRuntime, transitionId: number, reason: string): boolean {
  if (!runtime.socket || runtime.socket.readyState !== WebSocket.OPEN) return false
  if (runtime.dave.invalidCommitRequestedForTransition === transitionId) return false
  if (runtime.dave.decryptRecreateRequests >= DAVE_DECRYPT_RECREATE_MAX_ATTEMPTS) {
    warnDaveTransformLimited(
      runtime,
      'dave-recreate-limit',
      'DAVE: not requesting stream epoch recreate for stream %s after %d attempts; reason=%s',
      runtime.streamId,
      runtime.dave.decryptRecreateRequests,
      reason,
    )
    return false
  }

  runtime.dave.decryptRecreateRequests += 1
  runtime.dave.invalidCommitRequestedForTransition = transitionId
  runtime.dave.decryptFailures.clear()
  swarn(
    'DAVE: requesting stream epoch recreate for stream %s transitionId=%d reason=%s',
    runtime.streamId,
    transitionId,
    reason,
  )
  sendGatewayPacket(runtime.socket, { op: GW_DAVE_INVALID_COMMIT, d: { transition_id: transitionId } })
  return true
}

function resetDaveDecryptFailures(runtime: BaseRuntime, userId?: string, mediaType?: MediaType) {
  if (userId && mediaType !== undefined) {
    runtime.dave.decryptFailures.delete(`${userId}:${mediaType}`)
    return
  }
  runtime.dave.decryptFailures.clear()
}

function trackDaveEncryptedDecryptFailure(
  runtime: BaseRuntime,
  userId: string,
  mediaType: MediaType,
  reason: string,
) {
  if (runtime.dave.protocolVersion <= 0 || runtime.dave.mode !== 'passthrough') return

  const transitionId = runtime.dave.lastExecutedTransitionId
  if (transitionId === null || runtime.dave.invalidCommitRequestedForTransition === transitionId) {
    return
  }

  const now = Date.now()
  const key = `${userId}:${mediaType}`
  const previous = runtime.dave.decryptFailures.get(key)
  const next = previous
    ? { count: previous.count + 1, firstAt: previous.firstAt }
    : { count: 1, firstAt: now }
  runtime.dave.decryptFailures.set(key, next)

  if (next.count < DAVE_DECRYPT_RECREATE_FAILURES && now - next.firstAt < DAVE_DECRYPT_RECREATE_AFTER_MS) {
    return
  }

  if (requestDaveEpochRecreate(runtime, transitionId, `${reason}; userId=${userId}; mediaType=${mediaType}`)) {
    beginDaveUpgrade(runtime, 1)
  }
}

function shouldBeCommitter(runtime: BaseRuntime, controlSession: DAVESession): boolean {
  const currentId = currentUserId()
  if (!currentId) return false

  const ids = getRecognizedStreamUserIds(runtime, controlSession)
  if (isNumericUserId(runtime.ownerUserId) && ids.includes(runtime.ownerUserId)) {
    if (currentId !== runtime.ownerUserId) {
      slog(
        'DAVE: deferring stream commit for stream %s to owner userId=%s currentUserId=%s recognized=%o',
        runtime.streamId,
        runtime.ownerUserId,
        currentId,
        ids,
      )
      return false
    }
    return true
  }

  try {
    const currentNumeric = BigInt(currentId)
    for (const userId of ids) {
      try {
        if (BigInt(userId) < currentNumeric) return false
      } catch {
        // ignore non-numeric ids
      }
    }
    return true
  } catch {
    return false
  }
}

function shouldJoinStreamViaWelcome(runtime: BaseRuntime, controlSession: DAVESession): boolean {
  const currentId = currentUserId()
  return runtime.role === 'viewer'
    && isNumericUserId(runtime.ownerUserId)
    && currentId !== runtime.ownerUserId
    && controlSession.status === SessionStatus.PENDING
}

function getRecognizedStreamUserIds(runtime: BaseRuntime, controlSession?: DAVESession): string[] {
  const ids = new Set<string>()
  const add = (value: string | null | undefined) => {
    if (isNumericUserId(value)) {
      ids.add(value)
    }
  }

  add(currentUserId())
  add(runtime.ownerUserId)

  for (const userId of Object.keys(useVoiceStore.getState().peers)) {
    add(userId)
  }

  for (const user of usePresenceStore.getState().voiceChannelUsers[runtime.channelId] ?? []) {
    add(user.userId)
  }

  if (controlSession) {
    for (const userId of controlSession.userIds) {
      add(userId)
    }
  }

  return [...ids]
}

function closePublisherTransport(runtime: PublisherRuntime, stopCapture: boolean) {
  runtime.closing = true
  clearHeartbeat(runtime)
  resetDaveRuntime(runtime)
  clearPublisherQualityMonitor(runtime)
  if (runtime.peerConnection) {
    runtime.peerConnection.ontrack = null
    runtime.peerConnection.onconnectionstatechange = null
    runtime.peerConnection.close()
    runtime.peerConnection = null
  }
  const socket = runtime.socket
  runtime.socket = null
  closeSocket(socket)
  if (stopCapture) {
    stopMediaStream(runtime.captureStream)
    if (runtime.sourceStream !== runtime.captureStream) {
      stopMediaStream(runtime.sourceStream)
    }
  }
}

function closeViewerTransport(runtime: ViewerRuntime, stopMedia: boolean) {
  runtime.closing = true
  clearHeartbeat(runtime)
  resetDaveRuntime(runtime)
  clearStreamDebugSamples(runtime.streamId)
  if (runtime.peerConnection) {
    runtime.peerConnection.ontrack = null
    runtime.peerConnection.onconnectionstatechange = null
    runtime.peerConnection.close()
    runtime.peerConnection = null
  }
  const socket = runtime.socket
  runtime.socket = null
  closeSocket(socket)
  if (stopMedia) {
    stopMediaStream(runtime.mediaStream)
  }
}

function peerConnectionLooksActive(pc: RTCPeerConnection | null): boolean {
  if (!pc) return false
  return pc.connectionState === 'new'
    || pc.connectionState === 'connecting'
    || pc.connectionState === 'connected'
}

function socketLooksActive(socket: WebSocket | null): boolean {
  if (!socket) return false
  return socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN
}

function publisherRuntimeLooksActive(runtime: PublisherRuntime | null): boolean {
  if (!runtime || runtime.closing) return false
  return runtime.captureStream.active
    && runtime.sourceStream.active
    && runtime.sourceStream.getVideoTracks().some((track) => track.readyState === 'live')
    && socketLooksActive(runtime.socket)
    && peerConnectionLooksActive(runtime.peerConnection)
}

function viewerRuntimeLooksActive(runtime: ViewerRuntime | null): boolean {
  if (!runtime || runtime.closing) return false
  return socketLooksActive(runtime.socket) && peerConnectionLooksActive(runtime.peerConnection)
}

function attachRemoteTrack(stream: MediaStream, track: MediaStreamTrack) {
  if (stream.getTracks().some((existing) => existing.id === track.id)) return
  stream.addTrack(track)
  track.addEventListener('ended', () => {
    stream.removeTrack(track)
  })
}

function syncRuntimeDaveProtocolFromSessionDescription(runtime: BaseRuntime, sessionProtocolVersion: 0 | 1 | undefined) {
  if (sessionProtocolVersion === undefined || sessionProtocolVersion === runtime.dave.protocolVersion) {
    return
  }

  if (sessionProtocolVersion === 1) {
    if (runtime.dave.mode === 'pending_upgrade') {
      slog('DAVE: deferring protocol version 1 for stream %s until execute transition', runtime.streamId)
      return
    }
    if (runtime.dave.protocolVersion === 0) {
      swarn('DAVE: ignoring session description protocol version 1 for stream %s outside transition flow', runtime.streamId)
    }
    return
  }

  if (runtime.dave.mode === 'pending_downgrade') {
    slog('DAVE: deferring protocol version 0 for stream %s until execute transition', runtime.streamId)
    return
  }

  if (runtime.dave.protocolVersion === 1) {
    swarn('DAVE: ignoring stale transport-only session description while encrypted stream %s is active', runtime.streamId)
  }
}

async function applyRemoteDescription(
  socket: WebSocket,
  pc: RTCPeerConnection,
  runtime: BaseRuntime,
  description: GatewaySessionDescription,
) {
  if (!description.sdp) return

  syncRuntimeDaveProtocolFromSessionDescription(runtime, description.dave_protocol_version)
  if (description.dave_epoch !== undefined) {
    runtime.dave.epoch = description.dave_epoch
  }
  if (description.video_codec) {
    runtime.dave.negotiatedVideoCodec = mapCodecNameToDaveCodec(description.video_codec)
  }
  syncRuntimeDaveScriptState(runtime)

  const type = description.type === 'offer' ? 'offer' : 'answer'
  if (type === 'answer') {
    if (pc.signalingState !== 'have-local-offer') {
      swarn(
        'DAVE: ignoring stream answer for %s in signalingState=%s',
        runtime.streamId,
        pc.signalingState,
      )
      return
    }

    await pc.setRemoteDescription({ type: 'answer', sdp: description.sdp })
    retryPendingReceiverTransforms(runtime)
    retryPendingSenderTransforms(runtime)
    schedulePendingTransformRetry(runtime, 0)
    return
  }

  if (pc.signalingState !== 'stable') {
    swarn(
      'DAVE: rolling back local description for stream %s before applying offer in signalingState=%s',
      runtime.streamId,
      pc.signalingState,
    )
    await pc.setLocalDescription({ type: 'rollback' })
  }

  await pc.setRemoteDescription({ type: 'offer', sdp: description.sdp })
  retryPendingReceiverTransforms(runtime)
  retryPendingSenderTransforms(runtime)
  schedulePendingTransformRetry(runtime, 0)

  const answer = await pc.createAnswer()
  retryPendingReceiverTransforms(runtime)
  retryPendingSenderTransforms(runtime)
  await pc.setLocalDescription(answer)
  retryPendingReceiverTransforms(runtime)
  retryPendingSenderTransforms(runtime)
  schedulePendingTransformRetry(runtime, 0)
  await waitForIceGatheringComplete(pc)
  sendGatewayPacket(socket, {
    op: GW_SELECT_PROTOCOL,
    d: {
      protocol: 'webrtc',
      type: 'answer',
      sdp: pc.localDescription?.sdp ?? '',
      rtc_connection_id: runtime.rtcConnectionId,
    },
  })
}

function configureRuntimeDAVE(runtime: BaseRuntime, ready: GatewayReady | undefined) {
  runtime.dave.enabled = ready?.dave_enabled ?? false
  runtime.dave.required = ready?.dave_required ?? false
  runtime.dave.mode = 'passthrough'
  runtime.dave.protocolVersion = 0
  runtime.dave.epoch = 0
  runtime.dave.lastTransitionReadySent = null
  runtime.dave.lastExecutedTransitionId = null
  runtime.dave.invalidCommitRequestedForTransition = null
  runtime.dave.decryptRecreateRequests = 0
  runtime.dave.decryptFailures.clear()
  runtime.dave.pendingTransitionId = null
  runtime.dave.negotiatedVideoCodec = Codec.UNKNOWN
  runtime.dave.transformedSenders.clear()
  runtime.dave.pendingSenderTransforms.clear()
  runtime.dave.pendingReceiverTransforms.clear()
  runtime.dave.transformedReceivers.clear()
  runtime.dave.pendingReceiverAudioUnblocks.clear()
  if (runtime.dave.pendingTransformRetryTimer !== null) {
    window.clearTimeout(runtime.dave.pendingTransformRetryTimer)
    runtime.dave.pendingTransformRetryTimer = null
  }
  runtime.dave.transformWarnAt = {}
  resetDaveTransitionState(runtime)

  if (runtime.dave.enabled && shouldUseScriptEncodedTransforms()) {
    ensureRuntimeDaveScriptRuntime(runtime)
  }

  if (runtime.dave.enabled) {
    initializeDaveSession(runtime, 1)
  }
  syncRuntimeDaveScriptState(runtime)
}

function createRuntimePeerConnection(runtime: BaseRuntime, ready: GatewayReady | undefined): RTCPeerConnection {
  const iceServers = toIceServers(ready?.ice_servers)
  const pc = new RTCPeerConnection({
    iceServers: iceServers.length > 0 ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }],
    ...(runtime.dave.enabled && supportsDirectEncodedTransforms() ? { encodedInsertableStreams: true } : {}),
  } as RTCConfiguration & { encodedInsertableStreams?: boolean })

  pc.oniceconnectionstatechange = () => {
    slog('WebRTC ice state for stream %s role=%s -> %s', runtime.streamId, runtime.role, pc.iceConnectionState)
  }

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState
    slog('WebRTC connection state for stream %s role=%s -> %s', runtime.streamId, runtime.role, state)
    if (state === 'connected') {
      retryPendingReceiverTransforms(runtime)
      retryPendingSenderTransforms(runtime)
      schedulePendingTransformRetry(runtime, 0)
      if (runtime.role === 'publisher') {
        updatePublishingState('connected', null)
      } else {
        updateWatchingState(runtime.streamId, 'connected', null)
      }
      return
    }

    if (runtime.closing) return

    if (state === 'failed' || state === 'closed') {
      if (runtime.role === 'publisher') {
        closePublisherTransport(runtime as PublisherRuntime, false)
        updatePublishingState('error', 'Stream connection lost')
      } else {
        closeViewerTransport(runtime as ViewerRuntime, true)
        useStreamStore.getState().updateWatchedStream(runtime.streamId, { mediaStream: null })
        updateWatchingState(runtime.streamId, 'error', 'Stream connection lost')
      }
    }
  }

  return pc
}

function extractStreamTrackUserId(candidate: string | null | undefined): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) return null
  const source = String(candidate)
  if (/^\d+$/.test(source)) return source
  if (source.startsWith('u:')) {
    const parsed = source.slice(2)
    return /^\d+$/.test(parsed) ? parsed : null
  }
  if (source.startsWith('user-')) {
    const parsed = source.slice(5)
    return /^\d+$/.test(parsed) ? parsed : null
  }
  const dash = source.indexOf('-')
  if (dash > 0) {
    const parsed = source.slice(0, dash)
    return /^\d+$/.test(parsed) ? parsed : null
  }
  return null
}

function resolveStreamTrackUserId(runtime: ViewerRuntime, event: RTCTrackEvent): string {
  const ownerUserId = isNumericUserId(runtime.ownerUserId) ? runtime.ownerUserId : ''
  const candidates = [
    ...event.streams.map((stream) => stream.id),
    event.track.id,
  ]

  for (const candidate of candidates) {
    const parsedUserId = extractStreamTrackUserId(candidate)
    if (!parsedUserId) continue
    if (!ownerUserId || parsedUserId === ownerUserId) {
      return parsedUserId
    }
  }

  if (ownerUserId) {
    return ownerUserId
  }

  for (const candidate of candidates) {
    const parsedUserId = extractStreamTrackUserId(candidate)
    if (parsedUserId) {
      return parsedUserId
    }
  }

  return ''
}

function handleViewerTrack(runtime: ViewerRuntime, event: RTCTrackEvent) {
  const userId = resolveStreamTrackUserId(runtime, event)
  let receiverTransformPending = false

  if (runtime.dave.enabled) {
    const mediaType = event.track.kind === 'video' ? MediaType.VIDEO : MediaType.AUDIO
    if (attachPassthroughReceiverTransform(runtime, event.receiver, mediaType, userId)) {
      slog('DAVE: receiver transform attached for stream %s userId=%s kind=%s', runtime.streamId, userId, event.track.kind)
    } else {
      runtime.dave.pendingReceiverTransforms.set(event.receiver, { mediaType, userId })
      receiverTransformPending = true
      swarn('DAVE: receiver transform unavailable, queued for retry for stream %s userId=%s kind=%s', runtime.streamId, userId, event.track.kind)
      schedulePendingTransformRetry(runtime)
    }
  }

  if (event.track.kind === 'audio' && receiverTransformPending && shouldExpectDaveMediaPath(runtime)) {
    event.track.enabled = false
    runtime.dave.pendingReceiverAudioUnblocks.set(event.receiver, () => {
      event.track.enabled = true
    })
  }

  attachRemoteTrack(runtime.mediaStream, event.track)
  useStreamStore.getState().updateWatchedStream(runtime.streamId, {
    mediaStream: runtime.mediaStream,
  })
}

function handleRuntimeBinaryMessage(runtime: BaseRuntime, data: ArrayBuffer) {
  const view = new Uint8Array(data)
  if (view.length < 3) return

  const opcode = view[2]
  const rest = view.slice(3)
  const socket = runtime.socket
  if (!socket || socket.readyState !== WebSocket.OPEN) return

  switch (opcode) {
    case DAVE_BIN_EXTERNAL_SENDER: {
      const controlSession = currentDaveControlSession(runtime)
      if (!controlSession) return

      try {
        controlSession.setExternalSender(Buffer.from(rest))
        runtime.dave.scriptRuntime?.setExternalSender(currentDaveControlTarget(runtime), rest)
        const keyPackage = controlSession.getSerializedKeyPackage()
        socket.send(encodeKeyPackage(new Uint8Array(keyPackage)).buffer)
      } catch (error) {
        swarn('DAVE: failed to handle external sender for stream %s: %o', runtime.streamId, error)
      }
      return
    }

    case DAVE_BIN_PROPOSALS: {
      const controlSession = currentDaveControlSession(runtime)
      if (!controlSession || rest.length === 0) return

      try {
        if (shouldJoinStreamViaWelcome(runtime, controlSession)) {
          runtime.dave.awaitingWelcome = true
          slog(
            'DAVE: waiting for owner welcome for stream %s ownerUserId=%s currentUserId=%s status=%d',
            runtime.streamId,
            runtime.ownerUserId,
            currentUserId(),
            controlSession.status,
          )
          return
        }

        const operation = rest[0] as ProposalsOperationType
        const payload = Buffer.from(rest.slice(1))
        const recognizedUserIds = getRecognizedStreamUserIds(runtime, controlSession)
        let result: ReturnType<DAVESession['processProposals']>
        let mirroredRecognizedUserIds: string[] | undefined = recognizedUserIds.length > 0 ? recognizedUserIds : undefined
        try {
          result = controlSession.processProposals(
            operation,
            payload,
            recognizedUserIds.length > 0 ? recognizedUserIds : undefined,
          )
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes('proposal contained unexpected user')
          ) {
            swarn(
              'DAVE: proposal user mismatch for stream %s, retrying without local participant filter (recognized=%o): %o',
              runtime.streamId,
              recognizedUserIds,
              error,
            )
            result = controlSession.processProposals(operation, payload, undefined)
            mirroredRecognizedUserIds = undefined
          } else {
            throw error
          }
        }
        runtime.dave.scriptRuntime?.processProposals(
          currentDaveControlTarget(runtime),
          operation,
          rest.slice(1),
          mirroredRecognizedUserIds,
        )
        if (result.commit && shouldBeCommitter(runtime, controlSession)) {
          const commit = new Uint8Array(result.commit)
          const welcome = result.welcome ? new Uint8Array(result.welcome) : undefined
          slog(
            'DAVE: elected committer for stream %s userId=%s recognized=%o',
            runtime.streamId,
            currentUserId(),
            recognizedUserIds,
          )
          socket.send(encodeCommitWelcome(commit, welcome).buffer)
          runtime.dave.weCommitted = true
        }
        runtime.dave.awaitingWelcome = Boolean(result.welcome) && !runtime.dave.weCommitted
      } catch (error) {
        swarn('DAVE: processProposals failed for stream %s: %o', runtime.streamId, error)
      }
      return
    }

    case DAVE_BIN_ANNOUNCE_COMMIT: {
      if (rest.length < 2) return
      const transitionId = (rest[0] << 8) | rest[1]
      const controlSession = currentDaveControlSession(runtime)
      if (!controlSession) return

      if (runtime.dave.weCommitted) {
        runtime.dave.weCommitted = false
        try {
          const { bytes } = daveReadOpaqueVec(rest, 2)
          controlSession.processCommit(Buffer.from(bytes))
          runtime.dave.scriptRuntime?.processCommit(currentDaveControlTarget(runtime), bytes)
        } catch (error) {
          swarn('DAVE: committer processCommit failed for stream %s: %o', runtime.streamId, error)
        }
        sendDaveTransitionReady(runtime, transitionId)
        return
      }

      if (
        runtime.dave.awaitingWelcome ||
        (runtime.dave.mode === 'pending_upgrade' && controlSession.status === SessionStatus.PENDING)
      ) {
        return
      }

      try {
        const { bytes } = daveReadOpaqueVec(rest, 2)
        controlSession.processCommit(Buffer.from(bytes))
        runtime.dave.scriptRuntime?.processCommit(currentDaveControlTarget(runtime), bytes)
        runtime.dave.awaitingWelcome = false
        sendDaveTransitionReady(runtime, transitionId)
      } catch (error) {
        swarn('DAVE: processCommit failed for stream %s: %o', runtime.streamId, error)
        requestDaveEpochRecreate(runtime, transitionId, 'processCommit failed')
        beginDaveUpgrade(runtime, 1)
      }
      return
    }

    case DAVE_BIN_WELCOME: {
      if (rest.length < 2) return
      const transitionId = (rest[0] << 8) | rest[1]
      const controlSession = currentDaveControlSession(runtime)
      if (!controlSession) return

      try {
        const { bytes } = daveReadOpaqueVec(rest, 2)
        controlSession.processWelcome(Buffer.from(bytes))
        runtime.dave.scriptRuntime?.processWelcome(currentDaveControlTarget(runtime), bytes)
        runtime.dave.awaitingWelcome = false
        slog(
          'DAVE: welcome accepted for stream %s transitionId=%d userId=%s',
          runtime.streamId,
          transitionId,
          currentUserId(),
        )
        sendDaveTransitionReady(runtime, transitionId)
      } catch (error) {
        swarn('DAVE: processWelcome failed for stream %s: %o', runtime.streamId, error)
        requestDaveEpochRecreate(runtime, transitionId, 'processWelcome failed')
        beginDaveUpgrade(runtime, 1)
      }
      return
    }
  }
}

function handleRuntimeDavePacket(runtime: BaseRuntime, op: number, payload: unknown) {
  switch (op) {
    case GW_DAVE_PREPARE_TRANSITION: {
      const detail = payload as { protocol_version?: 0 | 1; transition_id?: number | string } | undefined
      const transitionId = normalizeDaveTransitionId(detail?.transition_id)
      if (detail?.protocol_version === 0 && transitionId !== null) {
        runtime.dave.pendingTransitionId = transitionId
        runtime.dave.mode = 'pending_downgrade'
        currentDaveMediaSession(runtime)?.setPassthroughMode(true)
        runtime.dave.scriptRuntime?.setPassthrough('active', true)
        syncRuntimeDaveScriptState(runtime)
        sendDaveTransitionReady(runtime, transitionId)
      }
      return
    }

    case GW_DAVE_EXECUTE_TRANSITION: {
      const detail = payload as { transition_id?: number | string } | undefined
      const transitionId = normalizeDaveTransitionId(detail?.transition_id) ?? runtime.dave.pendingTransitionId
      retryPendingReceiverTransforms(runtime)
      retryPendingSenderTransforms(runtime)
      schedulePendingTransformRetry(runtime, 0)
      if (runtime.dave.mode === 'pending_downgrade') {
        runtime.dave.protocolVersion = 0
        runtime.dave.mode = 'passthrough'
        runtime.dave.pendingTransitionId = null
        runtime.dave.lastExecutedTransitionId = null
        runtime.dave.invalidCommitRequestedForTransition = null
        resetDaveDecryptFailures(runtime)
        runtime.dave.pendingSession?.dispose()
        runtime.dave.pendingSession = null
        runtime.dave.pendingSessionKeyPair = null
        currentDaveMediaSession(runtime)?.setPassthroughMode(true)
        runtime.dave.scriptRuntime?.disposeSessions('pending')
        runtime.dave.scriptRuntime?.setPassthrough('active', true)
      } else if (runtime.dave.mode === 'pending_upgrade') {
        const nextSession = runtime.dave.pendingSession ?? runtime.dave.session
        runtime.dave.protocolVersion = 1
        runtime.dave.mode = 'passthrough'
        runtime.dave.pendingTransitionId = null
        runtime.dave.lastExecutedTransitionId = transitionId
        runtime.dave.invalidCommitRequestedForTransition = null
        resetDaveDecryptFailures(runtime)
        if (nextSession && runtime.dave.pendingSession) {
          const previousSession = runtime.dave.session
          runtime.dave.session = runtime.dave.pendingSession
          runtime.dave.sessionKeyPair = runtime.dave.pendingSessionKeyPair
          runtime.dave.pendingSession = null
          runtime.dave.pendingSessionKeyPair = null
          if (previousSession && previousSession !== runtime.dave.session) {
            previousSession.dispose()
          }
          runtime.dave.scriptRuntime?.promotePendingSession()
        }
        nextSession?.setPassthroughMode(false, DAVE_LATE_PACKET_WINDOW_SECONDS)
        runtime.dave.scriptRuntime?.setPassthrough('active', false, DAVE_LATE_PACKET_WINDOW_SECONDS)
        resetDaveTransitionState(runtime)
      }
      syncRuntimeDaveScriptState(runtime)
      return
    }

    case GW_DAVE_PREPARE_EPOCH: {
      const detail = payload as { protocol_version?: 0 | 1; epoch?: number } | undefined
      if (detail?.epoch !== undefined) {
        runtime.dave.epoch = detail.epoch
      }
      if (detail?.protocol_version === 1) {
        runtime.dave.mode = 'pending_upgrade'
        runtime.dave.pendingTransitionId = null
        resetDaveDecryptFailures(runtime)
        beginDaveUpgrade(runtime, 1)
        syncRuntimeDaveScriptState(runtime)
      }
      return
    }
  }
}

async function connectPublisherRuntime(runtime: PublisherRuntime, url: string, token: string): Promise<void> {
  runtime.closing = false
  const signalUrl = buildSignalUrl(url)

  await new Promise<void>((resolve, reject) => {
    let settled = false

    const socket = new WebSocket(signalUrl)
    socket.binaryType = 'arraybuffer'
    runtime.socket = socket
    runtime.rtcConnectionId = crypto.randomUUID()
    const daveCapable = supportsEncodedTransforms()

    const fail = (message: string) => {
      if (settled) return
      settled = true
      swarn('publisher runtime failed for stream %s: %s', runtime.streamId, message)
      closePublisherTransport(runtime, false)
      reject(new Error(message))
    }

    socket.addEventListener('open', () => {
      slog('signaling open for stream %s role=publisher url=%s', runtime.streamId, signalUrl)
      sendGatewayPacket(socket, {
        op: GW_IDENTIFY,
        d: buildVoiceGatewayIdentifyData(runtime.streamId, token, daveCapable),
      })
    })

    socket.addEventListener('message', (event) => {
      void (async () => {
        if (event.data instanceof ArrayBuffer) {
          handleRuntimeBinaryMessage(runtime, event.data)
          return
        }

        const packet = parseGatewayMessage(event)
        if (!packet) return

        switch (packet.op) {
          case GW_HELLO: {
            const hello = packet.d as GatewayHello | undefined
            const interval = Math.max(3_000, Number(hello?.heartbeat_interval ?? 15_000) - 1_000)
            clearHeartbeat(runtime)
            runtime.heartbeatTimer = window.setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ op: GW_HEARTBEAT, d: { ts: Date.now() } }))
              }
            }, interval)
            return
          }

          case GW_READY: {
            if (runtime.peerConnection) return

            const ready = packet.d as GatewayReady | undefined
            configureRuntimeDAVE(runtime, ready)
            if (!ready?.can_publish_video && !ready?.can_publish_audio) {
              fail('Publishing is not allowed for this stream')
              return
            }
            if (
              !runtime.captureStream.active
              || !runtime.sourceStream.active
              || runtime.captureStream.getTracks().length === 0
              || !runtime.sourceStream.getVideoTracks().some((track) => track.readyState === 'live')
            ) {
              fail('Screen capture is no longer available')
              return
            }
            if (runtime.dave.required && !daveCapable) {
              fail('Stream encryption is required but unsupported by this browser')
              return
            }

            const pc = createRuntimePeerConnection(runtime, ready)
            runtime.peerConnection = pc
            const serverAudioCapBps = readyBitrateCapBps(ready?.max_audio_bitrate_kbps)
            const serverVideoCapBps = readyBitrateCapBps(ready?.max_video_bitrate_kbps)

            pc.onconnectionstatechange = () => {
              const state = pc.connectionState
              slog('WebRTC connection state for stream %s role=publisher -> %s', runtime.streamId, state)
              if (state === 'connected') {
                retryPendingReceiverTransforms(runtime)
                retryPendingSenderTransforms(runtime)
                schedulePendingTransformRetry(runtime, 0)
                ensurePublisherQualityMonitor(runtime)
                updatePublishingState('connected', null)
                if (!settled) {
                  settled = true
                  resolve()
                }
                return
              }

              if (runtime.closing) return

              if (state === 'failed' || state === 'closed') {
                closePublisherTransport(runtime, false)
                if (!settled) {
                  settled = true
                  reject(new Error('Stream connection failed'))
                  return
                }
                updatePublishingState('error', 'Stream connection lost')
              }
            }

            for (const track of runtime.captureStream.getTracks()) {
              setTrackContentHint(track, runtime.quality)
              const sender = pc.addTrack(track, runtime.captureStream)
              if (track.kind === 'video') {
                preferStreamSenderVideoCodec(pc, sender, runtime.streamId)
              }
              const appliedMaxBitrate = await applyHighQualitySenderParameters(
                sender,
                track,
                runtime.quality,
                runtime.streamId,
                serverVideoCapBps,
                serverAudioCapBps,
              )
              registerPublisherSenderQuality(runtime, sender, track, appliedMaxBitrate)
              if (runtime.dave.enabled) {
                const mediaType = track.kind === 'audio' ? MediaType.AUDIO : MediaType.VIDEO
                const codec = () => (mediaType === MediaType.AUDIO ? Codec.OPUS : runtime.dave.negotiatedVideoCodec)
                if (!attachPassthroughSenderTransform(
                  runtime,
                  sender,
                  mediaType,
                  codec,
                )) {
                  runtime.dave.pendingSenderTransforms.set(sender, { mediaType, codec })
                  swarn(
                    'DAVE: sender transform unavailable, queued for retry for stream %s kind=%s',
                    runtime.streamId,
                    track.kind,
                  )
                  schedulePendingTransformRetry(runtime)
                }
              }
            }

            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            retryPendingSenderTransforms(runtime)
            schedulePendingTransformRetry(runtime, 0)
            await waitForIceGatheringComplete(pc)
            sendGatewayPacket(socket, {
              op: GW_SELECT_PROTOCOL,
              d: {
                protocol: 'webrtc',
                type: 'offer',
                sdp: pc.localDescription?.sdp ?? '',
                rtc_connection_id: runtime.rtcConnectionId,
              },
            })
            return
          }

          case GW_SESSION_DESC: {
            if (!runtime.peerConnection) return
            await applyRemoteDescription(
              socket,
              runtime.peerConnection,
              runtime,
              packet.d as GatewaySessionDescription,
            )
            return
          }

          case GW_DAVE_PREPARE_TRANSITION:
          case GW_DAVE_EXECUTE_TRANSITION:
          case GW_DAVE_PREPARE_EPOCH:
            handleRuntimeDavePacket(runtime, packet.op, packet.d)
            return
        }
      })().catch((error) => {
        swarn(
          'Stream publisher runtime message handler failed for stream %s: %o',
          runtime.streamId,
          error,
        )
        fail(error instanceof Error ? error.message : 'Stream connection failed')
      })
    })

    socket.addEventListener('close', (event) => {
      slog(
        'signaling closed for stream %s role=publisher code=%d reason=%s wasClean=%s',
        runtime.streamId,
        event.code,
        event.reason || '(none)',
        event.wasClean,
      )
      clearHeartbeat(runtime)
      runtime.socket = null

      if (runtime.closing) return

      if (!settled) {
        settled = true
        reject(new Error('Stream signaling closed'))
        return
      }

      closePublisherTransport(runtime, false)
      updatePublishingState('error', 'Stream signaling closed')
    })

    socket.addEventListener('error', () => {
      swarn('signaling error for stream %s role=publisher', runtime.streamId)
      fail('Unable to open stream signaling')
    })
  })
}

async function connectViewerRuntime(runtime: ViewerRuntime, url: string, token: string): Promise<void> {
  runtime.closing = false
  const signalUrl = buildSignalUrl(url)

  await new Promise<void>((resolve, reject) => {
    let settled = false

    const socket = new WebSocket(signalUrl)
    socket.binaryType = 'arraybuffer'
    runtime.socket = socket
    runtime.rtcConnectionId = crypto.randomUUID()
    const daveCapable = supportsEncodedTransforms()

    const fail = (message: string) => {
      if (settled) return
      settled = true
      swarn('viewer runtime failed for stream %s: %s', runtime.streamId, message)
      closeViewerTransport(runtime, true)
      useStreamStore.getState().updateWatchedStream(runtime.streamId, {
        mediaStream: null,
      })
      reject(new Error(message))
    }

    socket.addEventListener('open', () => {
      slog('signaling open for stream %s role=viewer url=%s', runtime.streamId, signalUrl)
      sendGatewayPacket(socket, {
        op: GW_IDENTIFY,
        d: buildVoiceGatewayIdentifyData(runtime.streamId, token, daveCapable),
      })
    })

    socket.addEventListener('message', (event) => {
      void (async () => {
        if (event.data instanceof ArrayBuffer) {
          handleRuntimeBinaryMessage(runtime, event.data)
          return
        }

        const packet = parseGatewayMessage(event)
        if (!packet) return

        switch (packet.op) {
          case GW_HELLO: {
            const hello = packet.d as GatewayHello | undefined
            const interval = Math.max(3_000, Number(hello?.heartbeat_interval ?? 15_000) - 1_000)
            clearHeartbeat(runtime)
            runtime.heartbeatTimer = window.setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ op: GW_HEARTBEAT, d: { ts: Date.now() } }))
              }
            }, interval)
            return
          }

          case GW_READY: {
            if (runtime.peerConnection) return

            const ready = packet.d as GatewayReady | undefined
            configureRuntimeDAVE(runtime, ready)
            if (runtime.dave.required && !daveCapable) {
              fail('Stream encryption is required but unsupported by this browser')
              return
            }

            const pc = createRuntimePeerConnection(runtime, ready)
            runtime.peerConnection = pc

            pc.ontrack = (trackEvent) => {
              handleViewerTrack(runtime, trackEvent)
            }

            pc.onconnectionstatechange = () => {
              const state = pc.connectionState
              slog('WebRTC connection state for stream %s role=viewer -> %s', runtime.streamId, state)
              if (state === 'connected') {
                retryPendingReceiverTransforms(runtime)
                retryPendingSenderTransforms(runtime)
                schedulePendingTransformRetry(runtime, 0)
                updateWatchingState(runtime.streamId, 'connected', null)
                if (!settled) {
                  settled = true
                  resolve()
                }
                return
              }

              if (runtime.closing) return

              if (state === 'failed' || state === 'closed') {
                closeViewerTransport(runtime, true)
                useStreamStore.getState().updateWatchedStream(runtime.streamId, {
                  mediaStream: null,
                })
                if (!settled) {
                  settled = true
                  reject(new Error('Stream connection failed'))
                  return
                }
                updateWatchingState(runtime.streamId, 'error', 'Stream connection lost')
              }
            }

            const videoTransceiver = pc.addTransceiver('video', { direction: 'recvonly' })
            preferStreamReceiverVideoCodec(videoTransceiver, runtime.streamId)
            if (runtime.audioMode !== 'none') {
              pc.addTransceiver('audio', { direction: 'recvonly' })
            }

            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            await waitForIceGatheringComplete(pc)
            sendGatewayPacket(socket, {
              op: GW_SELECT_PROTOCOL,
              d: {
                protocol: 'webrtc',
                type: 'offer',
                sdp: pc.localDescription?.sdp ?? '',
                rtc_connection_id: runtime.rtcConnectionId,
              },
            })
            return
          }

          case GW_SESSION_DESC: {
            if (!runtime.peerConnection) return
            await applyRemoteDescription(
              socket,
              runtime.peerConnection,
              runtime,
              packet.d as GatewaySessionDescription,
            )
            return
          }

          case GW_DAVE_PREPARE_TRANSITION:
          case GW_DAVE_EXECUTE_TRANSITION:
          case GW_DAVE_PREPARE_EPOCH:
            handleRuntimeDavePacket(runtime, packet.op, packet.d)
            return
        }
      })().catch((error) => {
        swarn(
          'Stream viewer runtime message handler failed for stream %s: %o',
          runtime.streamId,
          error,
        )
        fail(error instanceof Error ? error.message : 'Unable to watch stream')
      })
    })

    socket.addEventListener('close', (event) => {
      slog(
        'signaling closed for stream %s role=viewer code=%d reason=%s wasClean=%s',
        runtime.streamId,
        event.code,
        event.reason || '(none)',
        event.wasClean,
      )
      clearHeartbeat(runtime)
      runtime.socket = null

      if (runtime.closing) return

      if (!settled) {
        settled = true
        reject(new Error('Stream signaling closed'))
        return
      }

      closeViewerTransport(runtime, true)
      useStreamStore.getState().updateWatchedStream(runtime.streamId, {
        mediaStream: null,
      })
      updateWatchingState(runtime.streamId, 'error', 'Stream signaling closed')
    })

    socket.addEventListener('error', () => {
      swarn('signaling error for stream %s role=viewer', runtime.streamId)
      fail('Unable to open stream signaling')
    })
  })
}

function buildDisplayMediaOptions(
  sourceType: StreamSourceType,
  audioMode: StreamAudioMode,
  quality: StreamQualitySettings,
): DisplayMediaStreamOptions {
  const { width, height } = getStreamResolutionDimensions(quality.resolution)
  const video: ExtendedDisplayVideoConstraints = {
    width: {
      ideal: width,
      max: width,
    },
    height: {
      ideal: height,
      max: height,
    },
    frameRate: {
      ideal: quality.frameRate,
      max: quality.frameRate,
    },
    displaySurface: sourceType === 'screen' ? 'monitor' : 'window',
  }

  const audio: boolean | ExtendedDisplayAudioConstraints = audioMode === 'none'
    ? false
    : {
        suppressLocalAudioPlayback: false,
      }

  const options: ExtendedDisplayMediaStreamOptions = {
    video,
    audio,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
  }

  if (sourceType === 'screen') {
    options.systemAudio = audioMode === 'desktop' ? 'include' : 'exclude'
    options.monitorTypeSurfaces = 'include'
  } else {
    options.systemAudio = 'exclude'
    options.windowAudio = audioMode === 'application' ? 'window' : 'exclude'
    options.preferCurrentTab = false
  }

  return options as DisplayMediaStreamOptions
}

function fitVideoFrameToQuality(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const widthInput = Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : maxWidth
  const heightInput = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : maxHeight
  const width = Math.max(2, Math.round(widthInput))
  const height = Math.max(2, Math.round(heightInput))
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  return {
    width: Math.max(2, Math.round(width * scale)),
    height: Math.max(2, Math.round(height * scale)),
  }
}

async function waitForDisplayVideoReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return

  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(cleanup, 1_000)

    function cleanup() {
      window.clearTimeout(timeout)
      video.removeEventListener('loadeddata', cleanup)
      video.removeEventListener('loadedmetadata', cleanup)
      resolve()
    }

    video.addEventListener('loadeddata', cleanup, { once: true })
    video.addEventListener('loadedmetadata', cleanup, { once: true })
  })
}

async function normalizeDisplayVideoCadence(
  sourceStream: MediaStream,
  quality: StreamQualitySettings,
): Promise<MediaStream> {
  const sourceVideoTrack = sourceStream.getVideoTracks()[0]
  if (!sourceVideoTrack || typeof document === 'undefined') return sourceStream

  const video = document.createElement('video')
  video.autoplay = true
  video.muted = true
  video.playsInline = true
  video.srcObject = new MediaStream([sourceVideoTrack])

  try {
    await video.play()
  } catch (error) {
    swarn('captureDisplayStream: unable to start cadence normalizer video: %o', error)
  }
  await waitForDisplayVideoReady(video)

  const { width: maxWidth, height: maxHeight } = getStreamResolutionDimensions(quality.resolution)
  const settings = sourceVideoTrack.getSettings()
  const sourceWidth = Number(settings.width ?? video.videoWidth ?? maxWidth)
  const sourceHeight = Number(settings.height ?? video.videoHeight ?? maxHeight)
  const frameSize = fitVideoFrameToQuality(sourceWidth, sourceHeight, maxWidth, maxHeight)
  const canvas = document.createElement('canvas')
  canvas.width = frameSize.width
  canvas.height = frameSize.height

  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx || typeof canvas.captureStream !== 'function') {
    video.pause()
    video.srcObject = null
    return sourceStream
  }
  const canvasContext = ctx

  let canvasStream = canvas.captureStream(0)
  let outputVideoTrack = canvasStream.getVideoTracks()[0] as ManualCanvasCaptureTrack | undefined
  if (outputVideoTrack && typeof outputVideoTrack.requestFrame !== 'function') {
    stopMediaStream(canvasStream)
    canvasStream = canvas.captureStream(quality.frameRate)
    outputVideoTrack = canvasStream.getVideoTracks()[0] as ManualCanvasCaptureTrack | undefined
  }
  if (!outputVideoTrack) {
    video.pause()
    video.srcObject = null
    return sourceStream
  }
  const normalizedVideoTrack = outputVideoTrack

  setTrackContentHint(normalizedVideoTrack, quality)

  let stopped = false
  let timer: number | null = null
  const frameIntervalMs = 1_000 / quality.frameRate
  let nextFrameAt = performance.now()
  const manualRequestFrame = typeof normalizedVideoTrack.requestFrame === 'function'

  function cleanup() {
    stopped = true
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
    sourceVideoTrack.removeEventListener('ended', handleSourceEnded)
    video.pause()
    video.srcObject = null
  }

  function stopOutputVideoTrack() {
    cleanup()
    try {
      normalizedVideoTrack.stop()
    } catch {
      // noop
    }
  }

  function handleSourceEnded() {
    stopOutputVideoTrack()
  }

  function drawFrame() {
    if (stopped || sourceVideoTrack.readyState === 'ended' || normalizedVideoTrack.readyState === 'ended') return

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      canvasContext.drawImage(video, 0, 0, canvas.width, canvas.height)
      if (manualRequestFrame) {
        normalizedVideoTrack.requestFrame?.()
      }
    }

    const now = performance.now()
    nextFrameAt += frameIntervalMs
    if (nextFrameAt <= now - frameIntervalMs) {
      nextFrameAt = now + frameIntervalMs
    }
    timer = window.setTimeout(drawFrame, Math.max(0, nextFrameAt - performance.now()))
  }

  sourceVideoTrack.addEventListener('ended', handleSourceEnded, { once: true })
  drawFrame()

  const normalizedStream = new MediaStream([
    normalizedVideoTrack,
    ...sourceStream.getAudioTracks(),
  ])
  capturedStreamCleanups.set(normalizedStream, () => {
    cleanup()
    stopMediaStream(sourceStream)
  })

  slog(
    'captureDisplayStream: normalized video cadence to %dx%d @ %dfps',
    canvas.width,
    canvas.height,
    quality.frameRate,
  )

  return normalizedStream
}

async function captureDisplayStream(
  sourceType: StreamSourceType,
  audioMode: StreamAudioMode,
  quality: StreamQualitySettings,
): Promise<CapturedDisplayStream> {
  const sourceStream = await navigator.mediaDevices.getDisplayMedia(
    buildDisplayMediaOptions(sourceType, audioMode, quality),
  )
  const videoTracks = sourceStream.getVideoTracks()
  const audioTracks = sourceStream.getAudioTracks()
  let effectiveAudioMode = audioMode

  slog(
    'captureDisplayStream: source=%s audioMode=%s captured %d video and %d audio track(s)',
    sourceType,
    audioMode,
    videoTracks.length,
    audioTracks.length,
  )

  if (videoTracks.length === 0) {
    stopMediaStream(sourceStream)
    throw new Error('The browser did not return a video track for this stream.')
  }

  const videoTrack = videoTracks[0]
  if (videoTrack) {
    setTrackContentHint(videoTrack, quality)
    const { width, height } = getStreamResolutionDimensions(quality.resolution)
    try {
      await videoTrack.applyConstraints({
        width: { ideal: width, max: width },
        height: { ideal: height, max: height },
        frameRate: { ideal: quality.frameRate, max: quality.frameRate },
      })
    } catch (error) {
      swarn(
        'captureDisplayStream: unable to tighten quality constraints for source=%s resolution=%s frameRate=%d: %o',
        sourceType,
        quality.resolution,
        quality.frameRate,
        error,
      )
    }
    const settings = videoTrack.getSettings()
    slog(
      'captureDisplayStream: requested %s @ %dfps, actual %sx%s @ %sfps',
      quality.resolution,
      quality.frameRate,
      settings.width ?? 'auto',
      settings.height ?? 'auto',
      settings.frameRate ?? 'auto',
    )
  }

  if (audioMode !== 'none' && audioTracks.length === 0) {
    effectiveAudioMode = 'none'
    swarn(
      'captureDisplayStream: source=%s requested %s audio, but the browser returned no audio track; continuing video-only',
      sourceType,
      audioMode,
    )
  }

  const stream = await normalizeDisplayVideoCadence(sourceStream, quality)

  return { stream, sourceStream, effectiveAudioMode }
}

function ensureStreamAccess(channelId: string) {
  if (useVoiceStore.getState().channelId !== channelId) {
    throw new Error('Join the voice channel first')
  }
}

function summaryForRuntime(runtime: ViewerRuntime): VoiceStreamSummary {
  return {
    id: runtime.streamId,
    ownerUserId: runtime.ownerUserId,
    channelId: runtime.channelId,
    sourceType: runtime.sourceType,
    audioMode: runtime.audioMode,
    startedAt: 0,
  }
}

async function reconnectPublishingStream(reason: 'manual' | 'rebind') {
  const runtime = publisherRuntime
  if (!runtime) return

  if (
    !runtime.sourceStream.active
    || !runtime.sourceStream.getVideoTracks().some((track) => track.readyState === 'live')
  ) {
    await stopScreenShare('capture_ended')
    return
  }

  updatePublishingState('reconnecting', null)
  closePublisherTransport(runtime, false)

  try {
    const response = await streamApi.startStream(
      runtime.guildId,
      runtime.channelId,
      runtime.sourceType,
      runtime.audioMode,
    )
    runtime.streamId = response.streamId || runtime.streamId
    runtime.ownerUserId = response.stream.ownerUserId || runtime.ownerUserId
    await connectPublisherRuntime(runtime, response.streamUrl, response.streamToken)
  } catch (error) {
    updatePublishingState(
      'error',
      reason === 'rebind' ? 'Rebind failed' : (error instanceof Error ? error.message : 'Reconnect failed'),
    )
  }
}

async function reconnectWatchingStream(streamId: string, reason: 'manual' | 'rebind') {
  const runtime = viewerRuntimes.get(streamId)
  if (!runtime) return

  closeViewerTransport(runtime, false)
  runtime.mediaStream = new MediaStream()
  useStreamStore.getState().updateWatchedStream(streamId, {
    mediaStream: runtime.mediaStream,
    connectionState: 'reconnecting',
    error: null,
  })

  try {
    const response = await streamApi.joinStream(runtime.guildId, runtime.channelId, runtime.streamId)
    await connectViewerRuntime(runtime, response.streamUrl, response.streamToken)
  } catch (error) {
    updateWatchingState(
      streamId,
      'error',
      reason === 'rebind' ? 'Rebind failed' : (error instanceof Error ? error.message : 'Reconnect failed'),
    )
  }
}

function ensureEventBindings() {
  if (eventBindingsInitialized || typeof window === 'undefined') return

  eventBindingsInitialized = true

  window.addEventListener('ws:member_stop_stream', (event) => {
    const detail = (event as CustomEvent<StreamStopDetail>).detail
    const streamId = detail?.stream_id != null ? String(detail.stream_id) : ''
    if (!streamId) return

    const activePublisher = publisherRuntime?.streamId === streamId ? publisherRuntime : null
    const activeViewer = viewerRuntimes.get(streamId) ?? null
    const publisherWasLive = publisherRuntimeLooksActive(activePublisher)
    const viewerWasLive = viewerRuntimeLooksActive(activeViewer)

    window.setTimeout(() => {
      const currentPublisher = publisherRuntime?.streamId === streamId ? publisherRuntime : null
      const currentViewer = viewerRuntimes.get(streamId) ?? null

      if (publisherWasLive && publisherRuntimeLooksActive(currentPublisher)) {
        swarn('ignoring stale stop event for active local stream %s', streamId)
      } else if (currentPublisher) {
        void stopScreenShare('remote_ended')
      }

      if (viewerWasLive && viewerRuntimeLooksActive(currentViewer)) {
        swarn('ignoring stale stop event for active watched stream %s', streamId)
      } else if (currentViewer) {
        stopWatchingStream(streamId, 'remote_ended')
      }
    }, publisherWasLive || viewerWasLive ? 1_000 : 0)
  })

  window.addEventListener('ws:member_stream_rebind', (event) => {
    const detail = (event as CustomEvent<StreamRebindDetail>).detail
    const streamIDs = (detail?.stream_ids ?? []).map((value) => String(value))
    if (streamIDs.length === 0) return

    const delay = randomJitter(Number(detail?.jitter_ms ?? 0))
    window.setTimeout(() => {
      if (publisherRuntime && streamIDs.includes(publisherRuntime.streamId)) {
        void reconnectPublishingStream('rebind')
      }
      for (const streamId of streamIDs) {
        if (viewerRuntimes.has(streamId)) {
          void reconnectWatchingStream(streamId, 'rebind')
        }
      }
    }, delay)
  })
}

export async function syncChannelStreams(guildId: string, channelId: string, retryAttempt = 0): Promise<void> {
  try {
    const streams = await streamApi.listStreams(guildId, channelId)
    clearChannelStreamsSyncRetry(guildId, channelId)
    useStreamStore.getState().setChannelStreams(channelId, streams)
  } catch (error) {
    if (httpStatus(error) === 403 && retryAttempt < 5) {
      scheduleChannelStreamsSyncRetry(guildId, channelId, retryAttempt + 1)
      return
    }
    useStreamStore.getState().clearChannelStreams(channelId)
  }
}

export async function startScreenShare(
  guildId: string,
  channelId: string,
  sourceType: StreamSourceType,
  audioMode: StreamAudioMode,
  quality: StreamQualitySettings = DEFAULT_STREAM_QUALITY,
): Promise<void> {
  ensureEventBindings()
  ensureStreamAccess(channelId)

  if (publisherRuntime) {
    await stopScreenShare()
  }

  const normalizedQuality = normalizeStreamQuality(quality)
  const { stream: captureStream, sourceStream, effectiveAudioMode } = await captureDisplayStream(sourceType, audioMode, normalizedQuality)
  const response = await streamApi.startStream(guildId, channelId, sourceType, effectiveAudioMode)
  if (!response.streamId || !response.streamUrl || !response.streamToken) {
    stopMediaStream(captureStream)
    throw new Error('Invalid stream response')
  }

  const runtime: PublisherRuntime = {
    role: 'publisher',
    guildId,
    channelId,
    streamId: response.streamId,
    ownerUserId: currentUserId() || response.stream.ownerUserId,
    sourceType,
    audioMode: effectiveAudioMode,
    quality: normalizedQuality,
    captureStream,
    sourceStream,
    senderQualities: new Map(),
    qualityMonitorTimer: null,
    socket: null,
    peerConnection: null,
    heartbeatTimer: null,
    rtcConnectionId: '',
    closing: false,
    dave: createDaveState(),
  }
  publisherRuntime = runtime

  const videoTracks = new Set([
    ...captureStream.getVideoTracks(),
    ...sourceStream.getVideoTracks(),
  ])
  for (const videoTrack of videoTracks) {
    videoTrack.addEventListener('ended', () => {
      if (publisherRuntime?.streamId === runtime.streamId) {
        void stopScreenShare('capture_ended')
      }
    }, { once: true })
  }
  const hasCapturedAudio = effectiveAudioMode !== 'none' && captureStream.getAudioTracks().length > 0
  for (const audioTrack of captureStream.getAudioTracks()) {
    audioTrack.enabled = hasCapturedAudio
    audioTrack.addEventListener('ended', () => {
      if (publisherRuntime?.streamId !== runtime.streamId) return
      const hasLiveAudio = runtime.captureStream
        .getAudioTracks()
        .some((track) => track.readyState === 'live')
      useStreamStore.getState().updatePublishing({
        hasAudio: hasLiveAudio,
        audioEnabled: hasLiveAudio && runtime.captureStream
          .getAudioTracks()
          .some((track) => track.readyState === 'live' && track.enabled),
      })
    }, { once: true })
  }

  useStreamStore.getState().setPublishing({
    streamId: runtime.streamId,
    channelId,
    ownerUserId: runtime.ownerUserId,
    sourceType,
    audioMode: effectiveAudioMode,
    resolution: normalizedQuality.resolution,
    frameRate: normalizedQuality.frameRate,
    previewStream: captureStream,
    hasAudio: hasCapturedAudio,
    audioEnabled: hasCapturedAudio,
    connectionState: 'connecting',
    error: null,
  })

  try {
    await connectPublisherRuntime(runtime, response.streamUrl, response.streamToken)
  } catch (error) {
    publisherRuntime = null
    closePublisherTransport(runtime, true)
    useStreamStore.getState().setPublishing(null)
    void streamApi.stopStream(guildId, channelId, response.streamId).catch(() => undefined)
    throw error
  }
}

export async function stopScreenShare(
  reason: 'user_stop' | 'remote_ended' | 'voice_leave' | 'capture_ended' = 'user_stop',
): Promise<void> {
  const runtime = publisherRuntime
  if (!runtime) return

  slog('stopping local stream %s reason=%s', runtime.streamId, reason)
  publisherRuntime = null
  closePublisherTransport(runtime, true)
  useStreamStore.getState().setPublishing(null)

  if (reason !== 'remote_ended') {
    try {
      await streamApi.stopStream(runtime.guildId, runtime.channelId, runtime.streamId)
    } catch {
      // noop
    }
  }
}

export function setPublishingStreamAudioEnabled(enabled: boolean): boolean {
  const runtime = publisherRuntime
  if (!runtime) return false

  const liveAudioTracks = runtime.captureStream
    .getAudioTracks()
    .filter((track) => track.readyState === 'live')
  const hasAudio = runtime.audioMode !== 'none' && liveAudioTracks.length > 0

  if (!hasAudio) {
    useStreamStore.getState().updatePublishing({
      hasAudio: false,
      audioEnabled: false,
    })
    return false
  }

  for (const track of liveAudioTracks) {
    track.enabled = enabled
  }

  useStreamStore.getState().updatePublishing({
    hasAudio: true,
    audioEnabled: enabled,
  })
  slog('publisher stream audio %s for stream %s', enabled ? 'enabled' : 'disabled', runtime.streamId)
  return true
}

export async function watchStream(
  guildId: string,
  channelId: string,
  stream: VoiceStreamSummary,
): Promise<void> {
  ensureEventBindings()
  ensureStreamAccess(channelId)

  const existing = viewerRuntimes.get(stream.id)
  if (existing) {
    if (useStreamStore.getState().watched[stream.id]?.connectionState === 'connected' && viewerRuntimeLooksActive(existing)) {
      return
    }
    await reconnectWatchingStream(stream.id, 'manual')
    return
  }

  const response = await streamApi.joinStream(guildId, channelId, stream.id)
  if (!response.streamId || !response.streamUrl || !response.streamToken) {
    throw new Error('Invalid stream response')
  }

  const runtime: ViewerRuntime = {
    role: 'viewer',
    guildId,
    channelId,
    streamId: response.streamId,
    ownerUserId: stream.ownerUserId,
    sourceType: stream.sourceType,
    audioMode: stream.audioMode,
    mediaStream: new MediaStream(),
    socket: null,
    peerConnection: null,
    heartbeatTimer: null,
    rtcConnectionId: '',
    closing: false,
    dave: createDaveState(),
  }
  viewerRuntimes.set(runtime.streamId, runtime)

  const existingWatched = useStreamStore.getState().watched[runtime.streamId]
  useStreamStore.getState().setWatchedStream({
    streamId: runtime.streamId,
    channelId,
    ownerUserId: runtime.ownerUserId,
    sourceType: runtime.sourceType,
    audioMode: runtime.audioMode,
    mediaStream: runtime.mediaStream,
    connectionState: 'connecting',
    volume: existingWatched?.volume ?? 100,
    muted: existingWatched?.muted ?? false,
    error: null,
  })

  try {
    await connectViewerRuntime(runtime, response.streamUrl, response.streamToken)
  } catch (error) {
    updateWatchingState(runtime.streamId, 'error', error instanceof Error ? error.message : 'Unable to watch stream')
    throw error
  }
}

export function stopWatchingStream(
  streamId: string,
  reason: 'viewer_close' | 'remote_ended' | 'voice_leave' = 'viewer_close',
) {
  const runtime = viewerRuntimes.get(streamId)
  if (runtime) {
    slog('stopping watched stream %s reason=%s', streamId, reason)
    viewerRuntimes.delete(streamId)
    closeViewerTransport(runtime, true)
  }
  useStreamStore.getState().removeWatchedStream(streamId)
}

export async function reconnectStream(streamId: string): Promise<void> {
  if (publisherRuntime?.streamId === streamId) {
    await reconnectPublishingStream('manual')
    return
  }
  if (viewerRuntimes.has(streamId)) {
    await reconnectWatchingStream(streamId, 'manual')
    return
  }

  const state = useStreamStore.getState()
  const watched = state.watched[streamId]
  const voice = useVoiceStore.getState()
  if (!watched || !voice.guildId || voice.channelId !== watched.channelId) {
    updateWatchingState(streamId, 'error', 'Stream is no longer available')
    return
  }

  const summary = state.channelStreams[watched.channelId]?.find((stream) => stream.id === streamId) ?? {
    id: watched.streamId,
    ownerUserId: watched.ownerUserId,
    channelId: watched.channelId,
    sourceType: watched.sourceType,
    audioMode: watched.audioMode,
    startedAt: 0,
  }
  await watchStream(voice.guildId, watched.channelId, summary)
}

export async function handleVoiceDisconnect(channelId: string): Promise<void> {
  const viewerIds = [...viewerRuntimes.values()]
    .filter((runtime) => runtime.channelId === channelId)
    .map((runtime) => runtime.streamId)

  if (publisherRuntime?.channelId === channelId) {
    await stopScreenShare('voice_leave')
  }

  for (const streamId of viewerIds) {
    stopWatchingStream(streamId, 'voice_leave')
  }

  useStreamStore.getState().clearChannelStreams(channelId)
}

export function getSupportedStreamAudioModes(sourceType: StreamSourceType): StreamAudioMode[] {
  return sourceType === 'screen'
    ? ['desktop', 'none']
    : ['application', 'none']
}

export function getStreamSummary(streamId: string): VoiceStreamSummary | null {
  if (publisherRuntime?.streamId === streamId) {
    return summaryForRuntime({
      ...publisherRuntime,
      role: 'viewer',
      mediaStream: publisherRuntime.captureStream,
    })
  }
  const runtime = viewerRuntimes.get(streamId)
  return runtime ? summaryForRuntime(runtime) : null
}
