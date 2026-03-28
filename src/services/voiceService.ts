/**
 * Voice Service — manages the SFU WebSocket connection and WebRTC peer connection.
 *
 * Flow (v=2 voice gateway):
 *   1. Call joinVoice() with SFU URL + token from the API join endpoint
 *   2. Builds local audio pipeline (getUserMedia → denoiser → gain → processed tracks)
 *   3. Opens a separate WebSocket to the SFU at /signal?v=2
 *   4. On open: sends Identify (op=0) with DAVE capability flags
 *   5. SFU sends Hello (op=8) → client starts heartbeat at the given interval
 *   6. SFU sends Ready (op=2) → client creates RTCPeerConnection with server ICE servers,
 *      adds pending audio tracks, creates SDP offer, waits for ICE gathering, sends
 *      SelectProtocol (op=1)
 *   7. SFU sends SessionDescription (op=4, type=answer) → setRemoteDescription
 *   8. Media established. Membership via Clients Connect (op=11) / Client Disconnect (op=13).
 *   9. Periodically sends BindingAlive (op=7, t=509) to the *main* WS gateway to keep the
 *      per-channel SFU route alive.
 *  10. leaveVoice() closes the SFU socket and tears everything down.
 *
 * DAVE (E2EE):
 *   - Detects RTCRtpSender/Receiver encoded-transform (insertable streams) support.
 *   - Declares capability via max_dave_protocol_version / supports_encoded_transforms.
 *   - Attaches passthrough encoded transforms immediately (ready for key-material swap).
 *   - Drives DAVE state machine: Prepare Epoch (24), Execute Transition (22), Prepare
 *     Transition (21), Transition Ready (23) via JSON opcodes 21-31.
 *   - Binary opcodes 25-30 carry MLS material; handled via @snazzah/davey (OpenMLS/Rust WASM).
 *   - Requires COOP+COEP headers for SharedArrayBuffer (WASM threading).
 */

import JSONBig from 'json-bigint'
import { Buffer } from 'buffer'
import { Codec, DAVESession, MediaType, ProposalsOperationType, SessionStatus } from '@snazzah/davey'
import { useAuthStore } from '@/stores/authStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { usePresenceStore } from '@/stores/presenceStore'
import { sendRaw, sendPresenceStatus, setPresenceVoiceChannel } from './wsService'
import {
  buildDenoiserNode, destroyDenoiserNode, effectiveDenoiserType, effectiveNoiseSuppression,
  type DenoiserNode,
} from './denoiserService'
import { buildVoiceGatewayIdentifyData, stringifyVoiceGatewayPacket } from './voiceGatewayProtocol'

// ── Serialization ─────────────────────────────────────────────────────────────
// Incoming: keep large int64 IDs as strings to avoid float64 precision loss
const _bigJsonParse = JSONBig({ storeAsString: true })

// ── v=2 Voice Gateway Opcodes ─────────────────────────────────────────────────

const GW_IDENTIFY          = 0   // Client → SFU: authenticate + DAVE capability
const GW_SELECT_PROTOCOL   = 1   // Client → SFU: SDP offer or answer
const GW_READY             = 2   // SFU → Client: ICE servers, codecs, DAVE policy
const GW_HEARTBEAT         = 3   // Client → SFU: keep-alive ping
const GW_SESSION_DESC      = 4   // SFU → Client: SDP answer or renegotiation offer
const GW_SPEAKING          = 5   // Both directions: speaking state
const GW_HEARTBEAT_ACK     = 6   // SFU → Client: reply to Heartbeat
const GW_HELLO             = 8   // SFU → Client: session_id + heartbeat_interval
const GW_CLIENTS_CONNECT   = 11  // SFU → Client: user_ids now in media session
const GW_CLIENT_DISCONNECT = 13  // SFU → Client: user_id that left media session
// DAVE JSON opcodes
const GW_DAVE_PREPARE_TRANSITION = 21  // SFU → Client: announce downgrade or switch
const GW_DAVE_EXECUTE_TRANSITION = 22  // SFU → Client: commit the pending transition
const GW_DAVE_TRANSITION_READY   = 23  // Client → SFU: receiver side is ready
const GW_DAVE_PREPARE_EPOCH      = 24  // SFU → Client: MLS group creation/recreation
const GW_DAVE_INVALID_COMMIT     = 31  // Client → SFU: invalid MLS material, recreate
// DAVE binary opcodes (first byte of ArrayBuffer message)
const DAVE_BIN_EXTERNAL_SENDER = 25
const DAVE_BIN_KEY_PACKAGE     = 26
const DAVE_BIN_PROPOSALS       = 27
const DAVE_BIN_COMMIT_WELCOME  = 28
const DAVE_BIN_ANNOUNCE_COMMIT = 29
const DAVE_BIN_WELCOME         = 30
// How often to send BindingAlive (t=509) to the main WS gateway (ms)
const BINDING_ALIVE_INTERVAL = 25_000

// ── Module-level state ────────────────────────────────────────────────────────

let sfuSocket: WebSocket | null = null
let peerConnection: RTCPeerConnection | null = null
let localStream: MediaStream | null = null
let localVideoStream: MediaStream | null = null
let localVideoSender: RTCRtpSender | null = null
let bindingAliveTimer: number | null = null
let sfuHeartbeatTimer: number | null = null
let currentChannelId: string | null = null

// v=2 gateway session state
let sfuSessionId: string | null = null
let sfuHeartbeatInterval = 15_000          // overridden by Hello (op=8)
let sfuRtcConnectionId = ''                // stable UUID for this PC instance
let sfuIceServers: RTCIceServer[] = []     // populated from Ready (op=2)
let sfuDaveEnabled = false
let sfuDaveRequired = false

// DAVE state machine
type DaveMode = 'passthrough' | 'pending_upgrade' | 'pending_downgrade'
let daveMode: DaveMode = 'passthrough'
let daveProtocolVersion: 0 | 1 = 0
let daveEpoch = 0
let daveSession: DAVESession | null = null
let davePendingSession: DAVESession | null = null
let daveWeCommitted = false
let daveAwaitingWelcome = false
let davePendingTransitionId: number | null = null
let negotiatedVideoCodec: Codec = Codec.UNKNOWN

const DAVE_LATE_PACKET_WINDOW_SECONDS = 10
const DAVE_TRANSFORM_WARN_INTERVAL_MS = 2_000
const daveTransformWarnAt: Record<string, number> = {}

// Receivers where createEncodedStreams() was unavailable at ontrack time — retried later.
const pendingReceiverTransforms: Map<RTCRtpReceiver, { mediaType: MediaType; userId: string }> = new Map()
// Receivers that have already had createEncodedStreams() called (spec: call only once).
const transformedReceivers: Set<RTCRtpReceiver> = new Set()

// Pending audio setup: built in joinVoice, consumed in handleSfuReady
// (PC creation is deferred until ice_servers are known from Ready)
let pendingAudioTracks: MediaStreamTrack[] = []
let pendingAudioStream: MediaStream | null = null

// Voice channel member event listeners cleanup function
let memberEventCleanup: (() => void) | null = null

// One canonical MediaStream per remote user — tracks are added/replaced in-place
// so the <video> srcObject reference stays stable across SFU renegotiations.
const remoteStreams: Map<string, MediaStream> = new Map()

// Shared AudioContext for all remote peers.
let audioCtx: AudioContext | null = null

// The active denoiser node inserted in the send pipeline (null when type='default').
let denoiserNode: DenoiserNode | null = null

// Ping tracking for RTT calculation
let lastPingTime: number = 0

interface AudioContextWithSinkId extends AudioContext {
  setSinkId(sinkId: string): Promise<void>
}

// Gain nodes keyed by userId — used for per-user volume and deafen toggling.
const audioGains: Record<string, GainNode> = {}

// Input gain node for local microphone
let localInputGain: GainNode | null = null

// The processed tracks actually sent to the PeerConnection.
let sentTracks: MediaStreamTrack[] = []

// ── VAD / PTT input monitor ────────────────────────────────────────────────────────
const VAD_ATTACK_MS  = 30
const VAD_HANGOVER_MS = 350
const PTT_RELEASE_MS = 200

let vadAnalyserNode: AnalyserNode | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let vadFloatData: any = null  // Float32Array — typed as any to avoid TS strict ArrayBuffer mismatch
let vadRafId: number | null = null
let vadLastTime = 0
let vadAttackElapsed = 0
let vadHangoverLeft  = 0
let pttCleanup: (() => void) | null = null
let pttReleaseTimer: ReturnType<typeof setTimeout> | null = null
let isTransmitting = false
let mutedBeforeDeafen = false

// ── DAVE Helpers ──────────────────────────────────────────────────────────────

/** Detect browser support for WebRTC encoded transforms (insertable streams). */
function supportsEncodedTransforms(): boolean {
  try {
    const anyWindow = window as typeof window & { RTCRtpScriptTransform?: unknown }
    const senderProto = RTCRtpSender.prototype as RTCRtpSender & { createEncodedStreams?: unknown }
    const receiverProto = RTCRtpReceiver.prototype as RTCRtpReceiver & { createEncodedStreams?: unknown }
    return Boolean(
      anyWindow.RTCRtpScriptTransform ||
      (typeof senderProto.createEncodedStreams === 'function' &&
       typeof receiverProto.createEncodedStreams === 'function')
    )
  } catch {
    return false
  }
}

type WithEncodedStreams = {
  createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream }
}

type EncodedFrame = {
  data: ArrayBuffer
}

function currentUserId(): string {
  return String(useAuthStore.getState().user?.id ?? '')
}

function resolveFallbackRemoteUserId(): string | null {
  const ownId = currentUserId()
  const peerCandidates = Object.keys(useVoiceStore.getState().peers).filter((id) => /^\d+$/.test(id) && id !== ownId)
  if (peerCandidates.length === 1) {
    return peerCandidates[0]
  }

  if (!currentChannelId) {
    return null
  }

  const presenceCandidates = (usePresenceStore.getState().voiceChannelUsers[currentChannelId] ?? [])
    .map((user) => user.userId)
    .filter((id) => /^\d+$/.test(id) && id !== ownId)
  const uniquePresenceCandidates = [...new Set(presenceCandidates)]
  if (uniquePresenceCandidates.length === 1) {
    return uniquePresenceCandidates[0]
  }

  return null
}

function isResolvedVoiceUserId(userId: string | null | undefined): userId is string {
  return Boolean(userId && /^\d+$/.test(userId))
}

function warnDaveTransformLimited(key: string, message: string, ...args: unknown[]) {
  const now = Date.now()
  if ((daveTransformWarnAt[key] ?? 0) + DAVE_TRANSFORM_WARN_INTERVAL_MS > now) {
    return
  }
  daveTransformWarnAt[key] = now
  vwarn(message, ...args)
}

function createDaveSession(protocolVersion = 1): DAVESession {
  const userId = currentUserId()
  const session = new DAVESession(protocolVersion, userId, currentChannelId ?? '')
  session.setPassthroughMode(true)
  return session
}

function resetDaveTransitionState() {
  daveWeCommitted = false
  daveAwaitingWelcome = false
}

function resetDaveSessions() {
  davePendingSession?.reset()
  davePendingSession = null
  daveSession?.reset()
  daveSession = null
  resetDaveTransitionState()
}

function currentDaveMediaSession(): DAVESession | null {
  return daveSession
}

function currentDaveControlSession(): DAVESession | null {
  return davePendingSession ?? daveSession
}

function initializeDaveSession(protocolVersion = 1): DAVESession {
  davePendingSession?.reset()
  davePendingSession = null
  daveSession?.reset()
  daveSession = createDaveSession(protocolVersion)
  resetDaveTransitionState()
  return daveSession
}

function beginDaveUpgrade(protocolVersion = 1): DAVESession {
  resetDaveTransitionState()
  if (daveProtocolVersion > 0 && daveSession) {
    davePendingSession?.reset()
    davePendingSession = createDaveSession(protocolVersion)
    vlog('DAVE: pending session created for epoch transition')
    return davePendingSession
  }

  davePendingSession?.reset()
  davePendingSession = null
  daveSession?.reset()
  daveSession = createDaveSession(protocolVersion)
  vlog('DAVE: active session initialized for first encrypted epoch')
  return daveSession
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

/**
 * Attach an encoded transform to an RTP sender.
 * Uses the currently active DAVE media session only after the transition executes.
 */
function attachPassthroughSenderTransform(
  sender: RTCRtpSender,
  mediaType: MediaType,
  codec: () => Codec,
): boolean {
  const s = sender as RTCRtpSender & WithEncodedStreams
  if (typeof s.createEncodedStreams !== 'function') return false
  try {
    const { readable, writable } = s.createEncodedStreams()
    readable
      .pipeThrough(
        new TransformStream({
          transform(frame: EncodedFrame, controller) {
            const activeSession = currentDaveMediaSession()
            if (daveProtocolVersion > 0) {
              if (!activeSession?.ready) {
                warnDaveTransformLimited('sender-not-ready', 'DAVE: dropping outbound frame while session is not ready')
                return
              }
              try {
                const selectedCodec = codec()
                if (mediaType === MediaType.VIDEO && selectedCodec === Codec.UNKNOWN) {
                  controller.enqueue(frame)
                  return
                }
                const enc = activeSession.encrypt(mediaType, selectedCodec, Buffer.from(new Uint8Array(frame.data)))
                const buf = new ArrayBuffer(enc.byteLength)
                new Uint8Array(buf).set(enc)
                frame.data = buf
              } catch (err) {
                warnDaveTransformLimited(`sender-encrypt-${mediaType}`, 'DAVE: dropping outbound frame after encrypt error: %o', err)
                return
              }
            }
            controller.enqueue(frame)
          },
        }),
      )
      .pipeTo(writable)
      .catch(() => {})
    return true
  } catch {
    return false
  }
}

/**
 * Attach an encoded transform to an RTP receiver.
 * Uses the active DAVE media session so late rekeys do not break the currently playing audio.
 */
function attachPassthroughReceiverTransform(receiver: RTCRtpReceiver, mediaType: MediaType, userId = ''): boolean {
  if (transformedReceivers.has(receiver)) return true  // already set up — don't call createEncodedStreams twice
  const r = receiver as RTCRtpReceiver & WithEncodedStreams
  if (typeof r.createEncodedStreams !== 'function') return false
  try {
    const { readable, writable } = r.createEncodedStreams()
    readable
      .pipeThrough(
        new TransformStream({
          transform(frame: EncodedFrame, controller) {
            const activeSession = currentDaveMediaSession()
            if (userId && daveProtocolVersion > 0) {
              if (!activeSession?.ready) {
                warnDaveTransformLimited(`receiver-not-ready-${userId}`, 'DAVE: dropping inbound frame for userId=%s while session is not ready', userId)
                return
              }
              try {
                const dec = activeSession.decrypt(userId, mediaType, Buffer.from(new Uint8Array(frame.data)))
                const buf = new ArrayBuffer(dec.byteLength)
                new Uint8Array(buf).set(dec)
                frame.data = buf
                controller.enqueue(frame)
                return
              } catch (err) {
                if (activeSession.canPassthrough(userId)) {
                  controller.enqueue(frame)
                  return
                }
                warnDaveTransformLimited(`receiver-decrypt-${userId}-${mediaType}`, 'DAVE: dropping undecryptable inbound frame for userId=%s: %o', userId, err)
                return
              }
            }
            controller.enqueue(frame)
          },
        }),
      )
      .pipeTo(writable)
      .catch(() => {})
    transformedReceivers.add(receiver)
    return true
  } catch (err) {
    vwarn('DAVE: attachPassthroughReceiverTransform failed for userId=%s: %o', userId, err)
    return false
  }
}

/**
 * Retry attaching DAVE receiver transforms that failed at ontrack time because
 * createEncodedStreams() was not yet available (browser initialises it after
 * setRemoteDescription resolves, not during it).
 */
function retryPendingReceiverTransforms() {
  if (!sfuDaveEnabled || pendingReceiverTransforms.size === 0) return
  for (const [receiver, { mediaType, userId }] of Array.from(pendingReceiverTransforms.entries())) {
    if (attachPassthroughReceiverTransform(receiver, mediaType, userId)) {
      pendingReceiverTransforms.delete(receiver)
      vlog('DAVE: receiver transform attached on retry (userId=%s)', userId)
    }
  }
}

// ── DAVE wire encoding ────────────────────────────────────────────────────────
// Matches internal/voice/dave/wire/codec.go in the Go backend.
// Opaque vectors use a QUIC-style 2-bit prefix varint for the length field.

/** Encode a length as a QUIC-style varint (1/2/4 bytes depending on magnitude). */
function daveVarint(n: number): Uint8Array {
  if (n < 64) {
    return new Uint8Array([n])
  } else if (n < 16384) {
    const v = (0x40 << 8) | n  // 0b01 prefix
    return new Uint8Array([v >> 8, v & 0xff])
  } else {
    const v = (0x80000000 | n) >>> 0  // 0b10 prefix
    return new Uint8Array([v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff])
  }
}

/** Encode bytes as a length-prefixed opaque vector. */
function daveOpaqueVec(value: Uint8Array): Uint8Array {
  const lenBytes = daveVarint(value.length)
  const out = new Uint8Array(lenBytes.length + value.length)
  out.set(lenBytes)
  out.set(value, lenBytes.length)
  return out
}

/**
 * Encode a KeyPackage binary message (opcode 26).
 * Wire: [0x1a][varint:payloadLen][...payload]
 * The server rejects empty payloads.
 */
function encodeKeyPackage(payload: Uint8Array): Uint8Array {
  const opaque = daveOpaqueVec(payload)
  const out = new Uint8Array(1 + opaque.length)
  out[0] = DAVE_BIN_KEY_PACKAGE
  out.set(opaque, 1)
  return out
}

/**
 * Encode a CommitWelcome binary message (opcode 28).
 * Wire: [0x1c][varint:commitLen][...commit][varint:welcomeLen][...welcome]
 * Welcome is optional; commit must be non-empty.
 */
function encodeCommitWelcome(commit: Uint8Array, welcome?: Uint8Array): Uint8Array {
  const commitOpaque = daveOpaqueVec(commit)
  const welcomeOpaque = welcome && welcome.length > 0 ? daveOpaqueVec(welcome) : new Uint8Array(0)
  const out = new Uint8Array(1 + commitOpaque.length + welcomeOpaque.length)
  out[0] = DAVE_BIN_COMMIT_WELCOME
  out.set(commitOpaque, 1)
  if (welcomeOpaque.length > 0) out.set(welcomeOpaque, 1 + commitOpaque.length)
  return out
}

// ── GoChat binary wire decoder ─────────────────────────────────────────────────
// Server→client binary messages: [seq:u16][opcode:u8][payload...]
// Payload fields use the same QUIC-style varint as the encoding helpers above.

function daveReadVarint(data: Uint8Array, offset: number): { value: number; consumed: number } {
  if (data.length <= offset) throw new Error('DAVE varint truncated')
  const prefix = data[offset] >> 6
  if (prefix === 3) throw new Error('DAVE varint invalid prefix')
  const byteCount = 1 << prefix
  if (data.length - offset < byteCount) throw new Error('DAVE varint truncated')
  let value = data[offset] & 0x3f
  for (let i = 1; i < byteCount; i++) value = (value << 8) | data[offset + i]
  return { value, consumed: byteCount }
}

function daveReadOpaqueVec(data: Uint8Array, offset: number): { bytes: Uint8Array; consumed: number } {
  const { value: len, consumed: varintLen } = daveReadVarint(data, offset)
  const start = offset + varintLen
  if (start + len > data.length) throw new Error('DAVE opaque vec truncated')
  return { bytes: data.slice(start, start + len), consumed: varintLen + len }
}

/** Send DAVE Transition Ready (op=23) to the SFU. */
function sendDaveTransitionReady(transitionId: number) {
  sfuSend({ op: GW_DAVE_TRANSITION_READY, d: { transition_id: transitionId } })
  vlog('DAVE → Transition Ready (op=23, transition_id=%d)', transitionId)
}

/**
 * Committer election: the DAVE-capable participant with the lowest numeric user_id
 * is elected to send Commit Welcome (binary 28).
 */
function shouldBeCommitter(): boolean {
  const myUser = useAuthStore.getState().user
  if (!myUser?.id) return false
  try {
    const myNumericId = BigInt(String(myUser.id))
    const peers = useVoiceStore.getState().peers
    for (const peerId of Object.keys(peers)) {
      try {
        if (BigInt(peerId) < myNumericId) return false
      } catch { /* non-numeric peer id, skip */ }
    }
    return true
  } catch {
    return false
  }
}

// ── Debug logging ─────────────────────────────────────────────────────────────

const TAG = '%c[Voice]'
const S   = 'color:#7c3aed;font-weight:bold'   // purple — general
const SE  = 'color:#059669;font-weight:bold'   // green  — events
const SW  = 'color:#d97706;font-weight:bold'   // amber  — warnings
const SR  = 'color:#dc2626;font-weight:bold'   // red    — errors

function vlog(msg: string, ...args: unknown[])  { console.log(TAG + ' ' + msg, S,  ...args) }
function vevt(msg: string, ...args: unknown[])  { console.log(TAG + ' ' + msg, SE, ...args) }
function vwarn(msg: string, ...args: unknown[]) { console.warn(TAG + ' ' + msg, SW, ...args) }
function verr(msg: string, ...args: unknown[])  { console.error(TAG + ' ' + msg, SR, ...args) }

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the dBFS gate threshold. voiceActivityThreshold is stored directly
 * as dBFS (-100 to 0), so this is an identity kept for call-site clarity.
 */
export function thresholdToDb(threshold: number): number {
  return threshold
}

/**
 * Enable or disable the sent tracks, honouring the user's manual mute state.
 * Also updates the localSpeaking store flag for UI indicators.
 */
function setTransmitting(active: boolean) {
  if (isTransmitting === active) return
  isTransmitting = active
  const muted = useVoiceStore.getState().localMuted
  const shouldEnable = active && !muted
  for (const track of sentTracks) {
    track.enabled = shouldEnable
  }
  useVoiceStore.getState().setLocalSpeaking(shouldEnable)
  // v=2: speaking state uses op=5
  sfuSend({ op: GW_SPEAKING, d: { speaking: shouldEnable ? 1 : 0 } })
  vlog('setTransmitting: active=%s muted=%s → track.enabled=%s', active, muted, shouldEnable)
}

/**
 * Start voice activity detection on the local audio input.
 *
 * Gate logic:
 *   - Attack  (VAD_ATTACK_MS): voice must be above threshold for this long before gate opens.
 *   - Hangover (VAD_HANGOVER_MS): gate stays open this long after volume drops below threshold.
 */
function startVAD() {
  stopVAD()
  if (!localInputGain || !audioCtx) {
    vwarn('startVAD: no input gain or audio context — skipping')
    return
  }

  vadAnalyserNode = audioCtx.createAnalyser()
  vadAnalyserNode.fftSize = 2048
  vadFloatData   = new Float32Array(vadAnalyserNode.fftSize)
  localInputGain.connect(vadAnalyserNode)

  vadLastTime      = 0
  vadAttackElapsed = 0
  vadHangoverLeft  = 0

  setTransmitting(false)

  const loop = (now: number) => {
    if (!vadAnalyserNode || !vadFloatData) return

    const dt = vadLastTime > 0 ? now - vadLastTime : 0
    vadLastTime = now

    vadAnalyserNode.getFloatTimeDomainData(vadFloatData)
    let sum = 0
    for (let i = 0; i < vadFloatData.length; i++) {
      sum += vadFloatData[i] * vadFloatData[i]
    }
    const rms = Math.sqrt(sum / vadFloatData.length)
    const db  = Math.max(20 * Math.log10(Math.max(rms, 1e-8)), -100)
    const thresholdDb = thresholdToDb(useVoiceStore.getState().settings.voiceActivityThreshold)
    const above = db >= thresholdDb

    if (above) {
      vadAttackElapsed += dt
      vadHangoverLeft   = VAD_HANGOVER_MS
      if (!isTransmitting && vadAttackElapsed >= VAD_ATTACK_MS) {
        setTransmitting(true)
      }
    } else {
      vadAttackElapsed = 0
      if (isTransmitting) {
        vadHangoverLeft -= dt
        if (vadHangoverLeft <= 0) {
          setTransmitting(false)
          vadHangoverLeft = 0
        }
      }
    }

    vadRafId = requestAnimationFrame(loop)
  }
  vadRafId = requestAnimationFrame(loop)
  vlog('startVAD: started, thresholdDb=%.1f dBFS', thresholdToDb(useVoiceStore.getState().settings.voiceActivityThreshold))
}

function stopVAD() {
  if (vadRafId !== null) {
    cancelAnimationFrame(vadRafId)
    vadRafId = null
  }
  if (vadAnalyserNode) {
    try { vadAnalyserNode.disconnect() } catch { /* already disconnected */ }
    vadAnalyserNode = null
  }
  vadFloatData     = null
  vadLastTime      = 0
  vadAttackElapsed = 0
  vadHangoverLeft  = 0
  vlog('stopVAD: stopped')
}

/** Start push-to-talk listeners for the configured key. */
function startPTT() {
  stopPTT()
  const pttKey = useVoiceStore.getState().settings.pushToTalkKey
  if (!pttKey) {
    vwarn('startPTT: no PTT key configured')
    return
  }

  setTransmitting(false)

  const onKeydown = (e: KeyboardEvent) => {
    if (e.code !== pttKey || e.repeat) return
    if (pttReleaseTimer !== null) {
      clearTimeout(pttReleaseTimer)
      pttReleaseTimer = null
    }
    setTransmitting(true)
  }

  const onKeyup = (e: KeyboardEvent) => {
    if (e.code !== pttKey) return
    if (pttReleaseTimer !== null) clearTimeout(pttReleaseTimer)
    pttReleaseTimer = setTimeout(() => {
      pttReleaseTimer = null
      setTransmitting(false)
    }, PTT_RELEASE_MS)
  }

  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keyup', onKeyup)

  pttCleanup = () => {
    window.removeEventListener('keydown', onKeydown)
    window.removeEventListener('keyup', onKeyup)
    if (pttReleaseTimer !== null) {
      clearTimeout(pttReleaseTimer)
      pttReleaseTimer = null
    }
  }
  vlog('startPTT: listening for key=%s', pttKey)
}

function stopPTT() {
  if (pttCleanup) {
    pttCleanup()
    pttCleanup = null
  }
}

/**
 * Start the appropriate input monitor (VAD or PTT) based on current settings.
 * Exported so applyVoiceSettings can restart it after mode/threshold changes.
 */
export function startInputMonitor() {
  stopVAD()
  stopPTT()
  if (!peerConnection || sentTracks.length === 0) {
    vlog('startInputMonitor: not in voice channel, skipping')
    return
  }
  const { inputMode } = useVoiceStore.getState().settings
  if (inputMode === 'voice_activity') {
    startVAD()
  } else {
    startPTT()
  }
}

function stopInputMonitor() {
  stopVAD()
  stopPTT()
  isTransmitting = false
}

// ── AudioContext helpers ───────────────────────────────────────────────────────

/**
 * Get or create the shared AudioContext.
 * If the context is suspended (autoplay policy), actively resumes it.
 */
function getAudioContext(): AudioContext {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext()
    vlog('AudioContext created, state=%s, sampleRate=%d', audioCtx.state, audioCtx.sampleRate)
  }
  return audioCtx
}

/**
 * Ensures the AudioContext is in the 'running' state.
 * Browsers may create it in 'suspended' due to autoplay policy.
 */
async function ensureAudioContextRunning(): Promise<void> {
  const ctx = getAudioContext()
  if (ctx.state === 'running') return

  vwarn('AudioContext is %s — attempting to resume', ctx.state)
  try {
    await ctx.resume()
    vlog('AudioContext resumed successfully, state=%s', ctx.state)
  } catch {
    vwarn('AudioContext resume() failed — will retry on user gesture')
  }

  if ((ctx.state as string) !== 'running') {
    const resume = () => {
      audioCtx?.resume().then(() => {
        vlog('AudioContext resumed via user gesture, state=%s', audioCtx?.state)
        if (audioCtx?.state === 'running') {
          document.removeEventListener('click', resume)
          document.removeEventListener('keydown', resume)
        }
      })
    }
    document.addEventListener('click', resume)
    document.addEventListener('keydown', resume)
  }
}

/**
 * Wait for RTCPeerConnection ICE gathering to complete.
 * In v=2, candidates are embedded in the SDP rather than trickled.
 *
 * Uses idle-based detection: resolves after a short quiet period following
 * the last candidate rather than waiting for a fixed timeout.
 *   - 200 ms quiet after receiving a srflx/relay candidate (STUN done — good enough)
 *   - 400 ms quiet after host-only candidates (STUN still in flight)
 *   - Resolves immediately on null candidate (browser signals complete)
 *   - Hard cap of maxTimeoutMs as absolute fallback
 */
function waitForIceGatheringComplete(pc: RTCPeerConnection, maxTimeoutMs = 3000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let hasReflexive = false

    const finish = (reason: string) => {
      if (done) return
      done = true
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
      clearTimeout(maxTimer)
      pc.removeEventListener('icegatheringstatechange', stateHandler)
      pc.removeEventListener('icecandidate', candidateHandler)
      if (reason !== 'complete') {
        vwarn('waitForIceGatheringComplete: done via %s, sending SDP', reason)
      }
      resolve()
    }

    const maxTimer = setTimeout(() => finish(`max-timeout-${maxTimeoutMs}ms`), maxTimeoutMs)

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      // Once we have a reflexive/relay candidate, 200 ms quiet is enough.
      // Host-only: allow 400 ms for STUN to respond before giving up.
      idleTimer = setTimeout(() => finish(hasReflexive ? 'idle-200ms' : 'idle-400ms'),
        hasReflexive ? 200 : 400)
    }

    const candidateHandler = (ev: RTCPeerConnectionIceEvent) => {
      if (ev.candidate === null) { finish('null-candidate'); return }
      const t = ev.candidate.type
      if (t === 'srflx' || t === 'relay') hasReflexive = true
      resetIdle()
    }

    const stateHandler = () => {
      if (pc.iceGatheringState === 'complete') finish('complete')
    }

    pc.addEventListener('icecandidate', candidateHandler)
    pc.addEventListener('icegatheringstatechange', stateHandler)
    // Start the idle timer immediately — if no candidates arrive at all bail after 1 s.
    resetIdle()
  })
}

// ── SFU send ──────────────────────────────────────────────────────────────────

interface SfuPacket {
  op?: number
  t?: number
  d?: unknown
  [key: string]: unknown
}

function sfuSend(data: SfuPacket) {
  if (sfuSocket?.readyState === WebSocket.OPEN) {
    const str = stringifyVoiceGatewayPacket(data)
    console.debug(TAG + ' → SFU', S, data)
    sfuSocket.send(str)
  } else {
    vwarn('sfuSend: socket not open (readyState=%s)', sfuSocket?.readyState)
  }
}

// ── v=2 SFU message handlers ──────────────────────────────────────────────────

/** Handle Hello (op=8): store session_id and start the heartbeat loop. */
function handleSfuHello(d: { v?: number; heartbeat_interval: number; session_id: string }) {
  sfuSessionId = d.session_id
  sfuHeartbeatInterval = d.heartbeat_interval ?? 15_000
  vevt('Hello: v=%s session_id=%s heartbeat_interval=%d', d.v, d.session_id, sfuHeartbeatInterval)

  // Clear any previous heartbeat then start the v=2 heartbeat (op=3)
  if (sfuHeartbeatTimer !== null) {
    clearInterval(sfuHeartbeatTimer)
    sfuHeartbeatTimer = null
  }
  sfuHeartbeatTimer = window.setInterval(() => {
    if (sfuSocket?.readyState === WebSocket.OPEN) {
      lastPingTime = Date.now()
      sfuSend({ op: GW_HEARTBEAT, d: { t: lastPingTime, seq_ack: 0 } })
    }
  }, sfuHeartbeatInterval)
  vlog('heartbeat started every %d ms (op=%d)', sfuHeartbeatInterval, GW_HEARTBEAT)
}

/**
 * Handle Ready (op=2): create RTCPeerConnection with server ICE servers, add pending
 * audio tracks, create the initial SDP offer, wait for ICE gathering, send SelectProtocol.
 */
async function handleSfuReady(d: {
  ice_servers?: RTCIceServer[]
  dave_enabled?: boolean
  dave_required?: boolean
  can_publish_audio?: boolean
  can_publish_video?: boolean
}) {
  // Guard: if the socket closed while we were awaiting, abort
  if (!sfuSocket || sfuSocket.readyState !== WebSocket.OPEN) {
    vwarn('handleSfuReady: socket no longer open, aborting')
    return
  }

  sfuIceServers = d.ice_servers?.length ? d.ice_servers : [{ urls: 'stun:stun.l.google.com:19302' }]
  sfuDaveEnabled = d.dave_enabled ?? false
  sfuDaveRequired = d.dave_required ?? false
  vevt('Ready: ice_servers=%d dave_enabled=%s dave_required=%s', sfuIceServers.length, sfuDaveEnabled, sfuDaveRequired)
  useVoiceStore.getState().setDaveEnabled(sfuDaveEnabled)
  useVoiceStore.getState().setDaveState(0, false, 0)

  // Initialize (or reinitialize) the davey DAVE session for this channel
  if (sfuDaveEnabled) {
    initializeDaveSession(1)
    negotiatedVideoCodec = Codec.UNKNOWN
    davePendingTransitionId = null
    vlog('DAVE: DAVESession initialized (userId=%s channelId=%s)', currentUserId(), currentChannelId)
  }

  // If DAVE is required but browser cannot do encoded transforms, bail out gracefully
  if (sfuDaveRequired && !supportsEncodedTransforms()) {
    verr('handleSfuReady: DAVE is required but browser does not support encoded transforms')
    sfuSocket.close(4017, 'DAVE required but unsupported')
    return
  }

  // Create peer connection now that we have the server ICE servers
  if (peerConnection) {
    vwarn('handleSfuReady: stale peerConnection exists — closing')
    peerConnection.close()
    peerConnection = null
  }
  peerConnection = createPeerConnection()

  // Add pending audio tracks (built in joinVoice before socket connected)
  sentTracks = []
  if (pendingAudioTracks.length > 0 && pendingAudioStream) {
    for (const track of pendingAudioTracks) {
      peerConnection.addTrack(track, pendingAudioStream)
      sentTracks.push(track)
    }
    vlog('handleSfuReady: added %d pending audio track(s)', pendingAudioTracks.length)

    // Attach DAVE passthrough transforms to all audio senders immediately
    if (sfuDaveEnabled) {
      for (const sender of peerConnection.getSenders()) {
        if (attachPassthroughSenderTransform(sender, MediaType.AUDIO, () => Codec.OPUS)) {
          vlog('DAVE: passthrough sender transform attached (kind=%s)', sender.track?.kind)
        }
      }
    }

    // Respect muted state on the sent tracks
    if (useVoiceStore.getState().localMuted) {
      for (const track of sentTracks) {
        track.enabled = false
      }
      vlog('handleSfuReady: sent tracks disabled (muted state)')
    }
  } else {
    vwarn('handleSfuReady: no pending audio tracks — adding recvonly transceiver')
    peerConnection.addTransceiver('audio', { direction: 'recvonly' })
  }

  // Generate a stable RTC connection ID for this PC lifecycle
  sfuRtcConnectionId = crypto.randomUUID()

  // Create and send the client-driven initial offer
  useVoiceStore.getState().setConnectionState('routing')
  vlog('handleSfuReady: creating local SDP offer (rtc_connection_id=%s)', sfuRtcConnectionId)
  try {
    const offer = await peerConnection.createOffer()
    await peerConnection.setLocalDescription(offer)
    vlog('handleSfuReady: waiting for ICE gathering...')
    await waitForIceGatheringComplete(peerConnection)
    vlog('handleSfuReady: sending SelectProtocol (op=%d)', GW_SELECT_PROTOCOL)
    sfuSend({
      op: GW_SELECT_PROTOCOL,
      d: {
        protocol: 'webrtc',
        type: 'offer',
        sdp: peerConnection.localDescription?.sdp,
        rtc_connection_id: sfuRtcConnectionId,
      },
    })
  } catch (err) {
    verr('handleSfuReady: failed to create/send offer: %o', err)
    return
  }

  // Input monitor can start now that PC + sent tracks are available
  startInputMonitor()
}

/**
 * Handle SessionDescription (op=4): the initial answer from the SFU, or a
 * server-driven renegotiation offer (topology change, new participant, etc.).
 */
async function handleSfuSessionDesc(d: {
  type: 'answer' | 'offer'
  sdp: string
  rtc_connection_id?: string
  dave_protocol_version?: 0 | 1
  dave_epoch?: number
}) {
  if (!peerConnection) { vwarn('handleSfuSessionDesc: no peerConnection'); return }
  vevt('SessionDescription type=%s dave_protocol_version=%s dave_epoch=%s', d.type, d.dave_protocol_version, d.dave_epoch)

  // Sync DAVE state from session description
  if (d.dave_protocol_version !== undefined && d.dave_protocol_version !== daveProtocolVersion) {
    if (d.dave_protocol_version === 1 && daveMode === 'pending_upgrade') {
      vlog('DAVE: deferring protocol version 1 from session description until ExecuteTransition')
    } else {
      daveProtocolVersion = d.dave_protocol_version
      useVoiceStore.getState().setDaveState(daveProtocolVersion, daveMode !== 'passthrough')
      vlog('DAVE: protocol version updated to %d', daveProtocolVersion)
    }
  }
  if (d.dave_epoch !== undefined) {
    daveEpoch = d.dave_epoch
  }
  if (d.audio_codec) {
    vlog('DAVE: negotiated audio codec=%s', d.audio_codec)
  }
  if (d.video_codec) {
    negotiatedVideoCodec = mapCodecNameToDaveCodec(d.video_codec)
    vlog('DAVE: negotiated video codec=%s -> %d', d.video_codec, negotiatedVideoCodec)
  }

  if (d.type === 'answer') {
    // Initial bootstrap response or client-initiated renegotiation answer
    if (peerConnection.signalingState === 'have-local-offer') {
      await peerConnection.setRemoteDescription({ type: 'answer', sdp: d.sdp })
      // createEncodedStreams() becomes available after setRemoteDescription resolves —
      // retry any transforms that were unavailable during ontrack.
      retryPendingReceiverTransforms()
      vlog('handleSfuSessionDesc: remote answer applied, pcState=%s', peerConnection.connectionState)
    } else {
      vwarn('handleSfuSessionDesc: answer arrived in signalingState=%s — ignoring', peerConnection.signalingState)
    }
    return
  }

  // type === 'offer': server-driven renegotiation
  if (peerConnection.signalingState !== 'stable') {
    vwarn('handleSfuSessionDesc: offer in signalingState=%s — rolling back local', peerConnection.signalingState)
    await peerConnection.setLocalDescription({ type: 'rollback' })
  }
  await peerConnection.setRemoteDescription({ type: 'offer', sdp: d.sdp })
  retryPendingReceiverTransforms()
  const answer = await peerConnection.createAnswer()
  // MDN: createEncodedStreams() must be called BEFORE setLocalDescription.
  retryPendingReceiverTransforms()
  await peerConnection.setLocalDescription(answer)
  // Also retry after setLocalDescription — some browsers allow it post-set.
  retryPendingReceiverTransforms()
  await waitForIceGatheringComplete(peerConnection)

  sfuSend({
    op: GW_SELECT_PROTOCOL,
    d: {
      protocol: 'webrtc',
      type: 'answer',
      sdp: peerConnection.localDescription?.sdp,
      rtc_connection_id: d.rtc_connection_id ?? sfuRtcConnectionId,
    },
  })
  vlog('handleSfuSessionDesc: answer sent for server-driven renegotiation')
}

/**
 * Handle binary DAVE messages from the SFU.
 *
 * All server→client binary messages use the GoChat wire format:
 *   [seq:u16][opcode:u8][payload...]
 * The opcode is always at byte index 2, NOT byte 0.
 */
function handleSfuBinaryMessage(data: ArrayBuffer) {
  const view = new Uint8Array(data)
  if (view.length < 3) {
    vwarn('DAVE ← binary message too short (%d bytes)', view.length)
    return
  }
  const seq = (view[0] << 8) | view[1]
  const opcode = view[2]
  const rest = view.slice(3)

  vlog('DAVE ← binary op=%d seq=%d (%d payload bytes)', opcode, seq, rest.length)

  switch (opcode) {
    case DAVE_BIN_EXTERNAL_SENDER: {
      // SFU sends the ExternalSender for this DAVE epoch.
      // Transcode from GoChat varint format → MLS TLS format, then set on davey session.
      vevt('DAVE: ExternalSender (%d bytes)', rest.length)

      const controlSession = currentDaveControlSession()
      if (!controlSession) {
        vwarn('DAVE: no session yet for ExternalSender')
        break
      }

      try {
        // GoChat uses the same varint encoding as MLS TLS (RFC 9420 §2.1) — pass through directly
        controlSession.setExternalSender(Buffer.from(rest))
        vlog('DAVE: ExternalSender set on session (%d bytes)', rest.length)
      } catch (err) {
        vwarn('DAVE: setExternalSender failed: %o', err)
        break
      }

      try {
        const kp = controlSession.getSerializedKeyPackage()
        sfuSocket!.send(encodeKeyPackage(new Uint8Array(kp)).buffer)
        vlog('DAVE → KeyPackage (%d MLS bytes, davey)', kp.length)
      } catch (err) {
        verr('DAVE: getSerializedKeyPackage failed: %o', err)
      }
      break
    }

    case DAVE_BIN_PROPOSALS: {
      vevt('DAVE: Proposals (%d bytes)', rest.length)

      const controlSession = currentDaveControlSession()
      if (!controlSession) {
        vwarn('DAVE: no session yet for Proposals — ignoring')
        break
      }

      try {
        const opType = rest[0] as ProposalsOperationType
        const proposalsPayload = Buffer.from(rest.slice(1))
        const ownId = currentUserId()
        const recognizedUserIds = [
          ...(ownId ? [ownId] : []),
          ...Object.keys(useVoiceStore.getState().peers).filter(id => /^\d+$/.test(id)),
        ]
        const result = controlSession.processProposals(opType, proposalsPayload, recognizedUserIds)
        vlog('DAVE: processProposals %d bytes → commit=%s welcome=%s',
          proposalsPayload.length, !!result.commit, !!result.welcome)

        if (result.commit && shouldBeCommitter()) {
          const commit = new Uint8Array(result.commit)
          const welcome = result.welcome ? new Uint8Array(result.welcome) : undefined
          sfuSocket!.send(encodeCommitWelcome(commit, welcome).buffer)
          daveWeCommitted = true
          vlog('DAVE → CommitWelcome (%d+%d bytes, davey)', commit.length, welcome?.length ?? 0)
        }

        daveAwaitingWelcome = Boolean(result.welcome) && !daveWeCommitted
        if (daveAwaitingWelcome) {
          vlog('DAVE: awaiting Welcome after proposals')
        }
      } catch (err) {
        vwarn('DAVE: processProposals failed: %o', err)
      }
      break
    }

    case DAVE_BIN_ANNOUNCE_COMMIT: {
      // Non-committers receive the Commit via AnnounceCommitTransition
      if (rest.length < 2) { vwarn('DAVE: AnnounceCommit too short'); break }
      const transitionId = (rest[0] << 8) | rest[1]
      vevt('DAVE: AnnounceCommitTransition transitionId=%d', transitionId)

      const controlSession = currentDaveControlSession()
      if (!controlSession) { vwarn('DAVE: no session for processCommit'); break }

      // Committer path: processProposals only generates the commit bytes — it does NOT apply
      // them to the session. The committer must also call processCommit so the session
      // advances to ACTIVE and ready becomes true (same as the non-committer path below).
      if (daveWeCommitted) {
        daveWeCommitted = false
        try {
          const { bytes: commitBytes } = daveReadOpaqueVec(rest, 2)
          controlSession.processCommit(Buffer.from(commitBytes))
          vlog('DAVE: committer processCommit ok (transitionId=%d)', transitionId)
        } catch (err) {
          vwarn('DAVE: committer processCommit failed: %o', err)
          // Don't abort — still send TransitionReady so the epoch can proceed.
        }
        sendDaveTransitionReady(transitionId)
        break
      }

      if (daveAwaitingWelcome || (daveMode === 'pending_upgrade' && controlSession.status === SessionStatus.PENDING)) {
        vlog('DAVE: session is pending welcome — skipping commit processing (transitionId=%d)', transitionId)
        break
      }

      try {
        const { bytes: commitBytes } = daveReadOpaqueVec(rest, 2)
        controlSession.processCommit(Buffer.from(commitBytes))
        daveAwaitingWelcome = false
        vlog('DAVE: processCommit ok (transitionId=%d)', transitionId)
        sendDaveTransitionReady(transitionId)
      } catch (err) {
        vwarn('DAVE: processCommit failed: %o', err)
        sfuSend({ op: GW_DAVE_INVALID_COMMIT, d: { transition_id: transitionId } })
        beginDaveUpgrade(1)
      }
      break
    }

    case DAVE_BIN_WELCOME: {
      // New members join the group via a Welcome message
      if (rest.length < 2) { vwarn('DAVE: Welcome too short'); break }
      const transitionId = (rest[0] << 8) | rest[1]
      vevt('DAVE: Welcome transitionId=%d', transitionId)

      const controlSession = currentDaveControlSession()
      if (!controlSession) { vwarn('DAVE: no session for processWelcome'); break }

      try {
        const { bytes: welcomeBytes } = daveReadOpaqueVec(rest, 2)
        controlSession.processWelcome(Buffer.from(welcomeBytes))
        daveAwaitingWelcome = false
        vlog('DAVE: processWelcome ok (transitionId=%d)', transitionId)
        sendDaveTransitionReady(transitionId)
      } catch (err) {
        vwarn('DAVE: processWelcome failed: %o', err)
        sfuSend({ op: GW_DAVE_INVALID_COMMIT, d: { transition_id: transitionId } })
        beginDaveUpgrade(1)
      }
      break
    }

    default:
      vwarn('DAVE: unknown binary opcode %d', opcode)
  }
}

// ── Main SFU message dispatcher ───────────────────────────────────────────────

function onSfuMessage(event: MessageEvent) {
  // Binary messages carry DAVE MLS material
  if (event.data instanceof ArrayBuffer) {
    handleSfuBinaryMessage(event.data)
    return
  }

  let payload: { op: number; d?: unknown; t?: number }
  try {
    payload = _bigJsonParse.parse(event.data as string) as { op: number; d?: unknown; t?: number }
  } catch {
    verr('onSfuMessage: JSON parse failed, raw=%s', event.data)
    return
  }

  const { op, d } = payload
  console.debug(TAG + ' ← SFU op=%d', S, op, d)

  switch (op) {
    case GW_HELLO:
      handleSfuHello(d as { v?: number; heartbeat_interval: number; session_id: string })
      break

    case GW_READY:
      void handleSfuReady(d as {
        ice_servers?: RTCIceServer[]
        dave_enabled?: boolean
        dave_required?: boolean
        can_publish_audio?: boolean
        can_publish_video?: boolean
      })
      break

    case GW_SESSION_DESC:
      void handleSfuSessionDesc(d as {
        type: 'answer' | 'offer'
        sdp: string
        rtc_connection_id?: string
        dave_protocol_version?: 0 | 1
        dave_epoch?: number
      })
      break

    case GW_SPEAKING: {
      const sd = d as { user_id?: number | string; speaking: number | boolean }
      if (sd.user_id !== undefined) {
        const isSpeaking = sd.speaking === true || sd.speaking === 1
        vevt('SPEAKING user_id=%s speaking=%s', sd.user_id, isSpeaking)
        useVoiceStore.getState().setPeerSpeaking(String(sd.user_id), isSpeaking)
      }
      break
    }

    case GW_HEARTBEAT_ACK: {
      const now = Date.now()
      if (lastPingTime > 0) {
        const rtt = now - lastPingTime
        if (rtt >= 0 && rtt <= 10000) {
          useVoiceStore.getState().setPing(rtt)
        }
      }
      break
    }

    case GW_CLIENTS_CONNECT: {
      const cd = d as { user_ids?: (number | string)[] }
      const userIds = cd.user_ids ?? []
      vevt('Clients Connect: %d user(s): %o', userIds.length, userIds)
      const ownId = currentUserId()
      for (const uid of userIds) {
        const userId = String(uid)
        if (userId === ownId) continue
        useVoiceStore.getState().addPeer(userId)
      }
      break
    }

    case GW_CLIENT_DISCONNECT: {
      const dd = d as { user_id: number | string }
      const userId = String(dd.user_id)
      if (userId === currentUserId()) {
        vevt('Client Disconnect: ignoring self user_id=%s', userId)
        break
      }
      vevt('Client Disconnect: user_id=%s', userId)
      useVoiceStore.getState().removePeer(userId)
      if (audioGains[userId]) {
        audioGains[userId].disconnect()
        delete audioGains[userId]
      }
      const leavingStream = remoteStreams.get(userId)
      if (leavingStream) {
        leavingStream.getTracks().forEach(t => { try { t.stop() } catch { /* ok */ } })
        remoteStreams.delete(userId)
      }
      break
    }

    // ── DAVE JSON state machine ───────────────────────────────────────────────

    case GW_DAVE_PREPARE_TRANSITION: {
      const td = d as { protocol_version: 0 | 1; transition_id?: number }
      vevt('DAVE Prepare Transition: protocol_version=%d transition_id=%s', td.protocol_version, td.transition_id)
      if (td.protocol_version === 0 && td.transition_id !== undefined) {
        davePendingTransitionId = td.transition_id
        daveMode = 'pending_downgrade'
        currentDaveMediaSession()?.setPassthroughMode(true)
        useVoiceStore.getState().setDaveState(daveProtocolVersion, true, daveEpoch)
        sendDaveTransitionReady(td.transition_id)
      }
      break
    }

    case GW_DAVE_EXECUTE_TRANSITION: {
      const ed = d as { transition_id?: number }
      vevt('DAVE Execute Transition (current mode=%s transition_id=%s)', daveMode, ed.transition_id)
      // Ensure all receiver transforms are in place before encryption is activated.
      retryPendingReceiverTransforms()
      if (daveMode === 'pending_downgrade') {
        daveProtocolVersion = 0
        daveMode = 'passthrough'
        davePendingTransitionId = null
        davePendingSession?.reset()
        davePendingSession = null
        currentDaveMediaSession()?.setPassthroughMode(true)
        useVoiceStore.getState().setDavePrivacyCode(null)
        vlog('DAVE: downgrade complete — transport-only mode')
      } else if (daveMode === 'pending_upgrade') {
        const nextSession = davePendingSession ?? daveSession
        daveProtocolVersion = 1
        daveMode = 'passthrough'
        davePendingTransitionId = null
        if (nextSession && davePendingSession) {
          const previousSession = daveSession
          daveSession = davePendingSession
          davePendingSession = null
          if (previousSession && previousSession !== daveSession) {
            previousSession.reset()
          }
        }
        nextSession?.setPassthroughMode(false, DAVE_LATE_PACKET_WINDOW_SECONDS)
        resetDaveTransitionState()
        vlog('DAVE: upgrade transition executed — encryption enabled')
        useVoiceStore.getState().setDavePrivacyCode(nextSession?.voicePrivacyCode ?? null)
      }
      useVoiceStore.getState().setDaveState(daveProtocolVersion, false, daveEpoch)
      break
    }

    case GW_DAVE_PREPARE_EPOCH: {
      const ed = d as { protocol_version: 0 | 1; epoch?: number }
      vevt('DAVE Prepare Epoch: protocol_version=%d epoch=%s', ed.protocol_version, ed.epoch)
      if (ed.epoch !== undefined) daveEpoch = ed.epoch
      if (ed.protocol_version === 1) {
        daveMode = 'pending_upgrade'
        davePendingTransitionId = null
        beginDaveUpgrade(1)
        useVoiceStore.getState().setDaveState(daveProtocolVersion, true, daveEpoch)
        vlog('DAVE: epoch %d upgrade starting (waiting for binary 25)', daveEpoch)
      }
      break
    }

    default:
      vwarn('onSfuMessage: unhandled op=%d', op)
  }
}

// ── RTCPeerConnection ─────────────────────────────────────────────────────────

function createPeerConnection(): RTCPeerConnection {
  const iceServers = sfuIceServers.length
    ? sfuIceServers
    : [{ urls: 'stun:stun.l.google.com:19302' }]
  vlog('createPeerConnection: %d ICE server(s), encodedInsertableStreams=%s', iceServers.length, sfuDaveEnabled)
  const pc = new RTCPeerConnection({
    iceServers,
    ...(sfuDaveEnabled ? { encodedInsertableStreams: true } : {}),
  } as RTCConfiguration & { encodedInsertableStreams?: boolean })

  pc.oniceconnectionstatechange = () => {
    vevt('ICE connection state → %s', pc.iceConnectionState)
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      if (useVoiceStore.getState().connectionState !== 'connected') {
        vlog('ICE CONNECTED/COMPLETED — setting voice state to connected')
        useVoiceStore.getState().setConnectionState('connected')
      }
    }
    if (pc.iceConnectionState === 'failed') {
      verr('ICE FAILED — no media path could be established')
    }
  }

  pc.onicegatheringstatechange = () => {
    vevt('ICE gathering state → %s', pc.iceGatheringState)
  }

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState
    vevt('PC connection state → %s', state)
    if (state === 'connected') {
      vlog('WebRTC CONNECTED — media should be flowing')
      useVoiceStore.getState().setConnectionState('connected')
      // createEncodedStreams() becomes available once the DTLS/ICE connection is up.
      // Retry any transforms that were unavailable at ontrack time.
      retryPendingReceiverTransforms()
    } else if (state === 'connecting') {
      vlog('WebRTC CONNECTING — establishing connection')
    } else if (state === 'failed') {
      verr('PC connection FAILED')
    }
  }

  if (pc.connectionState === 'connected') {
    vlog('WebRTC ALREADY CONNECTED — setting voice state')
    useVoiceStore.getState().setConnectionState('connected')
  }

  pc.onsignalingstatechange = () => {
    vevt('signaling state → %s', pc.signalingState)
  }

  // NOTE: In v=2 we do NOT trickle ICE candidates to the SFU. The full
  // candidate set is embedded in the SDP after waiting for gathering to complete.
  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      vevt('ICE candidate gathered (embedded in SDP): %s', ev.candidate.candidate.slice(0, 80))
      // Do NOT send to SFU — included in SDP via waitForIceGatheringComplete
    } else {
      vlog('ICE gathering complete (null candidate)')
    }
  }

  pc.ontrack = (ev) => {
    // Resolve the remote user ID from the stream or track ID.
    let userId: string | null = null

    const idCandidates: string[] = [
      ...ev.streams.map((s) => s.id),
      ev.track.id,
    ]

    for (const id of idCandidates) {
      if (!id) continue
      if (id.startsWith('u:')) {
        userId = id.slice(2)
        break
      }
      if (id.startsWith('user-')) {
        userId = id.slice(5)
        break
      }
      const dash = id.indexOf('-')
      if (dash > 0 && /^\d{17,}$/.test(id.slice(0, dash))) {
        userId = id.slice(0, dash)
        break
      }
      if (/^\d+$/.test(id)) {
        userId = id
        break
      }
    }

    if (!userId) {
      const fallbackUserId = resolveFallbackRemoteUserId()
      if (fallbackUserId) {
        vlog('ontrack: falling back to sole known remote userId=%s', fallbackUserId)
        userId = fallbackUserId
      } else {
        vwarn('ontrack: could NOT resolve userId from any ID candidate')
        vwarn('ontrack: candidates were %o', idCandidates)
        userId = 'unknown-' + (ev.track.id || Math.random().toString(36).slice(2, 9))
      }
    }

    if (!isResolvedVoiceUserId(userId)) {
      vwarn('ontrack: unresolved userId=%s kind=%s — ignoring placeholder track', userId, ev.track.kind)
      return
    }

    // The SFU echoes our own track back in the SDP offer — skip it.
    if (userId === currentUserId()) {
      vlog('ontrack: skipping self-track (userId=%s kind=%s)', userId, ev.track.kind)
      return
    }

    vlog('ontrack: resolved userId=%s kind=%s, adding to voiceStore', userId, ev.track.kind)
    useVoiceStore.getState().addPeer(userId)

    // Attach DAVE receiver transform immediately when DAVE is enabled.
    // createEncodedStreams() is sometimes unavailable when ontrack fires during
    // setRemoteDescription — queue for retry so we can attach before encryption starts.
    if (sfuDaveEnabled) {
      const mediaType = ev.track.kind === 'video' ? MediaType.VIDEO : MediaType.AUDIO
      if (attachPassthroughReceiverTransform(ev.receiver, mediaType, userId)) {
        pendingReceiverTransforms.delete(ev.receiver)
        vlog('DAVE: receiver transform attached (userId=%s kind=%s)', userId, ev.track.kind)
      } else {
        pendingReceiverTransforms.set(ev.receiver, { mediaType, userId })
        vwarn('DAVE: receiver transform unavailable, queued for retry (userId=%s kind=%s)', userId, ev.track.kind)
      }
    }

    // ── Video track ────────────────────────────────────────────────────────
    if (ev.track.kind === 'video') {
      let userStream = remoteStreams.get(userId)
      if (!userStream) {
        userStream = new MediaStream()
        remoteStreams.set(userId, userStream)
        vlog('ontrack: created per-user stream for userId=%s', userId)
      }

      for (const t of userStream.getVideoTracks()) {
        userStream.removeTrack(t)
      }
      userStream.addTrack(ev.track)
      vlog('ontrack: video track added for userId=%s (muted=%s)', userId, ev.track.muted)

      useVoiceStore.getState().setPeerVideoStream(userId, userStream)

      const capturedStream = userStream
      ev.track.addEventListener('unmute', () => {
        vlog('remote video track UNMUTED for userId=%s', userId)
        useVoiceStore.getState().setPeerVideoStream(userId!, capturedStream)
      })
      ev.track.addEventListener('mute', () => {
        vwarn('remote video track MUTED for userId=%s — clearing stream', userId)
        useVoiceStore.getState().setPeerVideoStream(userId!, null)
      })
      ev.track.addEventListener('ended', () => {
        vwarn('remote video track ENDED for userId=%s', userId)
        capturedStream.removeTrack(ev.track)
        useVoiceStore.getState().setPeerVideoStream(userId!, null)
      })
      return
    }

    // ── Audio track ────────────────────────────────────────────────────────
    if (ev.track.kind !== 'audio') return

    const ctx = getAudioContext()

    const stream = ev.streams[0] ?? new MediaStream([ev.track])
    if (!ev.streams[0]) {
      vwarn('ontrack: ev.streams[0] was undefined — created fallback MediaStream from track')
    }

    for (const priorEl of document.querySelectorAll(`audio[data-voice-peer="${userId}"]`)) {
      const priorAudio = priorEl as HTMLAudioElement
      priorAudio.pause()
      priorAudio.srcObject = null
      priorAudio.remove()
    }

    // Workaround for Chrome/Edge: ensure the stream is pumped by attaching to a hidden audio element.
    const audio = document.createElement('audio')
    audio.srcObject = stream
    audio.muted = false
    audio.volume = 0.0001
    audio.autoplay = true
    audio.setAttribute('playsinline', 'true')
    audio.style.display = 'none'
    audio.setAttribute('data-voice-peer', userId)
    document.body.appendChild(audio)

    const playAudio = () => {
      audio.play().catch(e => {
        vwarn('ontrack: failed to play hidden audio for userId=%s: %o', userId, e)
        const retry = () => {
          audio.play().catch(() => {})
          document.removeEventListener('click', retry)
        }
        document.addEventListener('click', retry)
      })
    }
    playAudio()

    const settings = useVoiceStore.getState().settings
    const peerVolume = useVoiceStore.getState().peers[userId]?.volume ?? 100
    const source = ctx.createMediaStreamSource(stream)
    const gain = ctx.createGain()
    const effectiveGain = (settings.audioOutputLevel / 100) * (peerVolume / 100)
    gain.gain.value = useVoiceStore.getState().localDeafened ? 0 : effectiveGain

    source.connect(gain)
    gain.connect(ctx.destination)

    if (settings.audioOutputDevice && 'setSinkId' in ctx) {
      void (ctx as unknown as AudioContextWithSinkId).setSinkId(settings.audioOutputDevice).catch((e: unknown) => verr('ontrack: setSinkId failed: %o', e))
    }

    if (audioGains[userId]) {
      audioGains[userId].disconnect()
    }
    audioGains[userId] = gain

    const receiver = pc.getReceivers().find(r => r.track.id === ev.track.id)
    if (receiver && !receiver.track.enabled) {
      receiver.track.enabled = true
    }

    const checkTrack = () => {
      if (ev.track.muted) {
        audio.play().catch(() => {})
      }
      if (!ev.track.enabled) {
        ev.track.enabled = true
      }
    }
    setTimeout(checkTrack, 1000)
    setTimeout(checkTrack, 5000)

    ev.track.onmute = () => {
      vwarn('remote track MUTED for userId=%s (id=%s)', userId, ev.track.id)
      audio.play().catch(() => {})
    }
    ev.track.onunmute = () => {
      vevt('remote track UNMUTED for userId=%s (id=%s)', userId, ev.track.id)
      audio.play().catch(() => {})
      if (ctx.state !== 'running') {
        void ctx.resume().catch(e => verr('ontrack: failed to resume context on unmute: %o', e))
      }
    }
    ev.track.onended = () => vwarn('remote track ENDED for userId=%s (id=%s)', userId, ev.track.id)
  }

  return pc
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

function cleanupDenoiserNode() {
  destroyDenoiserNode(denoiserNode)
  denoiserNode = null
}

function cleanup(sendPresenceClear = true) {
  vlog('cleanup: tearing down voice connection')
  stopInputMonitor()

  if (peerConnection) {
    vlog('cleanup: closing RTCPeerConnection (state=%s)', peerConnection.connectionState)
    peerConnection.ontrack = null
    peerConnection.onicecandidate = null
    peerConnection.oniceconnectionstatechange = null
    peerConnection.onconnectionstatechange = null
    peerConnection.onsignalingstatechange = null

    document.querySelectorAll('audio[data-voice-peer]').forEach(el => el.remove())

    peerConnection.close()
    peerConnection = null
  }
  if (localStream) {
    vlog('cleanup: stopping %d local audio tracks', localStream.getTracks().length)
    for (const track of localStream.getTracks()) {
      track.stop()
    }
    localStream = null
  }
  if (localVideoStream) {
    vlog('cleanup: stopping %d local video tracks', localVideoStream.getTracks().length)
    for (const track of localVideoStream.getTracks()) {
      track.stop()
    }
    localVideoStream = null
  }
  localVideoSender = null

  for (const track of sentTracks) {
    try { track.stop() } catch { /* already stopped */ }
  }
  sentTracks = []

  // Clear pending audio setup
  pendingAudioTracks = []
  pendingAudioStream = null

  if (localInputGain) {
    localInputGain.disconnect()
    localInputGain = null
  }

  cleanupDenoiserNode()

  const gainCount = Object.keys(audioGains).length
  vlog('cleanup: disconnecting %d remote audio gain nodes', gainCount)
  for (const gain of Object.values(audioGains)) {
    try { gain.disconnect() } catch { /* already disconnected */ }
  }
  for (const key of Object.keys(audioGains)) {
    delete audioGains[key]
  }

  vlog('cleanup: clearing %d per-user remote streams', remoteStreams.size)
  for (const stream of remoteStreams.values()) {
    stream.getTracks().forEach(t => { try { t.stop() } catch { /* ok */ } })
  }
  remoteStreams.clear()

  if (audioCtx) {
    vlog('cleanup: closing AudioContext (state=%s)', audioCtx.state)
    void audioCtx.close().catch(() => {})
    audioCtx = null
  }

  if (bindingAliveTimer !== null) {
    clearInterval(bindingAliveTimer)
    bindingAliveTimer = null
    vlog('cleanup: binding-alive timer stopped')
  }
  if (sfuHeartbeatTimer !== null) {
    clearInterval(sfuHeartbeatTimer)
    sfuHeartbeatTimer = null
    vlog('cleanup: SFU heartbeat timer stopped')
  }

  // Reset v=2 gateway state
  sfuSessionId = null
  sfuRtcConnectionId = ''
  sfuIceServers = []
  sfuDaveEnabled = false
  sfuDaveRequired = false

  // Reset DAVE state
  daveMode = 'passthrough'
  daveProtocolVersion = 0
  daveEpoch = 0
  resetDaveSessions()
  davePendingTransitionId = null
  negotiatedVideoCodec = Codec.UNKNOWN
  pendingReceiverTransforms.clear()
  transformedReceivers.clear()

  // Save before nulling so we can clear the presence store for this channel
  const savedChannelId = currentChannelId
  currentChannelId = null

  if (memberEventCleanup) {
    memberEventCleanup()
    memberEventCleanup = null
  }

  // Clear voice channel users from the local presence store
  if (savedChannelId) {
    usePresenceStore.getState().clearVoiceChannel(savedChannelId)
  }

  if (sendPresenceClear) {
    setPresenceVoiceChannel(null)
    // Send explicit voice_channel_id: 0 — some backends use patch semantics and
    // won't clear the voice channel if the field is simply omitted.
    sendRaw({
      op: 3,
      d: {
        status: 'online',
        platform: 'web',
        voice_channel_id: 0n,
      },
    })
  }
  useVoiceStore.getState().reset()
  vlog('cleanup: done')
}

// ── Join / Leave ──────────────────────────────────────────────────────────────

export async function joinVoice(
  guildId: string,
  channelId: string,
  channelName: string,
  sfuUrl: string,
  sfuToken: string,
  guildName?: string,
  voiceRegion?: string,
): Promise<void> {
  vlog('joinVoice: guildId=%s channelId=%s channelName=%s', guildId, channelId, channelName)
  vlog('joinVoice: sfuUrl=%s', sfuUrl)

  // Tear down any existing voice connection first
  if (sfuSocket || peerConnection) {
    vlog('joinVoice: tearing down previous connection before joining')
    leaveVoice()
  }

  currentChannelId = channelId

  // Reset DAVE state for new session
  daveMode = 'passthrough'
  daveProtocolVersion = 0
  daveEpoch = 0
  resetDaveSessions()
  davePendingTransitionId = null
  negotiatedVideoCodec = Codec.UNKNOWN
  sfuSessionId = null
  sfuRtcConnectionId = ''

  const voiceStore = useVoiceStore.getState()
  voiceStore.setDaveEnabled(false)
  voiceStore.setDaveState(0, false, 0)
  voiceStore.setConnectionState('connecting')

  // Warm up AudioContext while inside the user-gesture scope
  vlog('joinVoice: warming up AudioContext')
  await ensureAudioContextRunning()

  // Request microphone access
  vlog('joinVoice: requesting getUserMedia(audio)')
  const settings = useVoiceStore.getState().settings
  const useNativeSuppression = effectiveNoiseSuppression(settings.denoiserType ?? 'default', settings.noiseSuppression)
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: settings.audioInputDevice ? { exact: settings.audioInputDevice } : undefined,
        autoGainControl: settings.autoGainControl,
        echoCancellation: settings.echoCancellation,
        noiseSuppression: useNativeSuppression,
      },
      video: false
    })
  } catch (err) {
    const error = err as Error
    vwarn('joinVoice: getUserMedia failed (%s)', error.message)

    if (settings.audioInputDevice && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')) {
      vwarn('joinVoice: retrying with default audio device...')
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: settings.autoGainControl,
            echoCancellation: settings.echoCancellation,
            noiseSuppression: useNativeSuppression,
          },
          video: false
        })
        vlog('joinVoice: retry successful with default device')
      } catch (retryErr) {
        vwarn('joinVoice: retry failed (%s) — joining in receive-only mode', (retryErr as Error).message)
        localStream = null
      }
    } else {
      vwarn('joinVoice: joining in receive-only mode')
      localStream = null
    }
  }

  if (localStream) {
    const tracks = localStream.getAudioTracks()
    vlog('joinVoice: got %d audio track(s)', tracks.length)
  }

  // ── Build audio pipeline (PC creation is deferred to handleSfuReady) ────────
  //
  // We build the gain/denoiser graph now and store the processed tracks.
  // handleSfuReady creates the RTCPeerConnection with server ICE servers and then
  // calls peerConnection.addTrack() for these pending tracks.
  pendingAudioTracks = []
  pendingAudioStream = null

  if (localStream) {
    const ctx = getAudioContext()

    if (ctx.state !== 'running') {
      vwarn('joinVoice: AudioContext state is %s before pipeline build — attempting resume', ctx.state)
      await ctx.resume().catch(() => {})
    }

    const source = ctx.createMediaStreamSource(localStream)
    localInputGain = ctx.createGain()
    localInputGain.gain.value = settings.audioInputLevel / 100

    cleanupDenoiserNode()
    const denoiserType = effectiveDenoiserType(settings.denoiserType ?? 'default', settings.noiseSuppression)
    vlog('joinVoice: denoiserType=%s', denoiserType)
    denoiserNode = await buildDenoiserNode(denoiserType, ctx, source)
    const preGainNode: AudioNode = denoiserNode ?? source
    preGainNode.connect(localInputGain)

    const destination = ctx.createMediaStreamDestination()
    localInputGain.connect(destination)
    pendingAudioStream = destination.stream
    pendingAudioTracks = pendingAudioStream.getAudioTracks()

    vlog('joinVoice: audio pipeline built, %d processed track(s) pending PC creation', pendingAudioTracks.length)
  }

  // ── Connect to SFU via v=2 voice gateway ─────────────────────────────────────
  const signalUrl = new URL(sfuUrl)
  signalUrl.searchParams.set('v', '2')
  vlog('joinVoice: opening SFU WebSocket → %s', signalUrl.toString())

  sfuSocket = new WebSocket(signalUrl.toString())
  sfuSocket.binaryType = 'arraybuffer'   // required for DAVE binary messages
  sfuSocket.addEventListener('message', onSfuMessage)

  sfuSocket.addEventListener('open', () => {
    vlog('joinVoice: SFU WebSocket OPEN — sending Identify (op=%d)', GW_IDENTIFY)
    const daveCapable = supportsEncodedTransforms()
    vlog('joinVoice: DAVE capable (encoded transforms)=%s', daveCapable)
    sfuSend({
      op: GW_IDENTIFY,
      d: buildVoiceGatewayIdentifyData(channelId, sfuToken, daveCapable),
    })
  })

  sfuSocket.addEventListener('close', (ev) => {
    vwarn('joinVoice: SFU WebSocket CLOSED code=%d reason=%s wasClean=%s',
      ev.code, ev.reason || '(none)', ev.wasClean)
    if (currentChannelId === channelId) {
      vlog('joinVoice: cleaning up after unexpected close')
      cleanup()
    }
  })

  sfuSocket.addEventListener('error', (ev) => {
    verr('joinVoice: SFU WebSocket ERROR', ev)
  })

  // Periodically refresh the SFU route binding via the main WS gateway
  bindingAliveTimer = window.setInterval(() => {
    sendRaw({ op: 7, t: 509, d: { channel: BigInt(channelId) } })
    vlog('binding-alive sent for channelId=%s', channelId)
  }, BINDING_ALIVE_INTERVAL)

  // Update voice store and presence
  useVoiceStore.getState().setVoiceChannel(guildId, channelId, channelName, guildName, sfuUrl, voiceRegion)
  setPresenceVoiceChannel(channelId)
  sendPresenceStatus('online')

  // Listen for other users joining/leaving this voice channel via main gateway events
  const handleMemberJoinVoice = (e: Event) => {
    const detail = (e as CustomEvent).detail as { user_id?: string | number; channel_id?: string | number }
    if (detail?.user_id === undefined || detail?.channel_id === undefined) return

    const userId = String(detail.user_id)
    const channelId = String(detail.channel_id)
    if (channelId !== currentChannelId) {
      vlog('ws:member_join_voice ignored for user=%s channel=%s (current=%s)', userId, channelId, currentChannelId)
      return
    }
    if (userId === currentUserId()) {
      vlog('ws:member_join_voice ignored for self user=%s', userId)
      return
    }

    vlog('ws:member_join_voice received for user=%s channel=%s', userId, channelId)
    useVoiceStore.getState().addPeer(userId)
  }

  const handleMemberLeaveVoice = (e: Event) => {
    const detail = (e as CustomEvent).detail as { user_id?: string | number; channel_id?: string | number }
    if (detail?.user_id === undefined || detail?.channel_id === undefined) return

    const userId = String(detail.user_id)
    const channelId = String(detail.channel_id)
    if (channelId !== currentChannelId) {
      vlog('ws:member_leave_voice ignored for user=%s channel=%s (current=%s)', userId, channelId, currentChannelId)
      return
    }
    if (userId === currentUserId()) {
      vlog('ws:member_leave_voice ignored for self user=%s', userId)
      return
    }

    vlog('ws:member_leave_voice received for user=%s channel=%s', userId, channelId)
    useVoiceStore.getState().removePeer(userId)
    if (audioGains[userId]) {
      audioGains[userId].disconnect()
      delete audioGains[userId]
    }
    const leavingStream = remoteStreams.get(userId)
    if (leavingStream) {
      leavingStream.getTracks().forEach(t => { try { t.stop() } catch { /* ok */ } })
      remoteStreams.delete(userId)
    }
  }

  window.addEventListener('ws:member_join_voice', handleMemberJoinVoice)
  window.addEventListener('ws:member_leave_voice', handleMemberLeaveVoice)

  memberEventCleanup = () => {
    window.removeEventListener('ws:member_join_voice', handleMemberJoinVoice)
    window.removeEventListener('ws:member_leave_voice', handleMemberLeaveVoice)
    vlog('voiceService: voice channel member event listeners removed')
  }

  vlog('joinVoice: setup complete, waiting for Hello + Ready from SFU...')
}

export function leaveVoice() {
  vlog('leaveVoice: disconnecting')
  if (sfuSocket) {
    sfuSocket.close()
    sfuSocket = null
  }
  cleanup()
}

// ── Mute / Deafen ─────────────────────────────────────────────────────────────

export function setMuted(muted: boolean) {
  vlog('setMuted: %s', muted)

  const shouldEnable = !muted && isTransmitting
  if (sentTracks.length > 0) {
    for (const track of sentTracks) {
      track.enabled = shouldEnable
      vlog('setMuted: sent track id=%s enabled=%s', track.id, shouldEnable)
    }
  } else if (localStream) {
    vwarn('setMuted: no sentTracks — falling back to localStream tracks')
    for (const track of localStream.getAudioTracks()) {
      track.enabled = shouldEnable
    }
  }

  useVoiceStore.getState().setLocalMuted(muted)
  useVoiceStore.getState().setLocalSpeaking(shouldEnable)

  const store = useVoiceStore.getState()
  if (store.channelId) {
    sendRaw({
      op: 3,
      d: {
        status: 'online',
        platform: 'web',
        voice_channel_id: BigInt(store.channelId),
        mute: muted,
        deafen: store.localDeafened,
      },
    })
    vlog('setMuted: sent presence update with mute=%s', muted)
  }
}

export function setDeafened(deafened: boolean) {
  vlog('setDeafened: %s', deafened)
  if (deafened) {
    mutedBeforeDeafen = useVoiceStore.getState().localMuted
    if (!mutedBeforeDeafen) setMuted(true)
  } else {
    if (!mutedBeforeDeafen) setMuted(false)
  }
  const settings = useVoiceStore.getState().settings
  const baseGain = settings.audioOutputLevel / 100
  for (const [uid, gain] of Object.entries(audioGains)) {
    const peerVolume = useVoiceStore.getState().peers[uid]?.volume ?? 100
    const effectiveGain = baseGain * (peerVolume / 100)
    gain.gain.value = deafened ? 0 : effectiveGain
    vlog('setDeafened: gain for userId=%s → %.2f', uid, gain.gain.value)
  }
  if (audioCtx && (audioCtx as unknown as AudioContextWithSinkId).setSinkId) {
    if (!deafened && settings.audioOutputDevice) {
      void (audioCtx as unknown as AudioContextWithSinkId).setSinkId(settings.audioOutputDevice).catch(() => {})
    }
  }
  if (peerConnection) {
    for (const receiver of peerConnection.getReceivers()) {
      if (receiver.track.kind === 'audio') {
        receiver.track.enabled = !deafened
      }
    }
  }
  useVoiceStore.getState().setLocalDeafened(deafened)

  const store = useVoiceStore.getState()
  if (store.channelId) {
    sendRaw({
      op: 3,
      d: {
        status: 'online',
        platform: 'web',
        voice_channel_id: BigInt(store.channelId),
        mute: store.localMuted,
        deafen: deafened,
      },
    })
    vlog('setDeafened: sent presence update with deafen=%s', deafened)
  }
}

// ── Camera ────────────────────────────────────────────────────────────────────

/**
 * Requests camera access and starts sending video to the peer connection.
 *
 * First enable: addTrack() + client-initiated renegotiation via SelectProtocol (op=1).
 * Subsequent enables: replaceTrack() on the existing sender — no renegotiation needed.
 */
export async function enableCamera(): Promise<void> {
  if (!peerConnection) {
    vwarn('enableCamera: no active peer connection')
    return
  }

  vlog('enableCamera: requesting getUserMedia(video)')
  const videoInputDevice = useVoiceStore.getState().settings.videoInputDevice
  const videoConstraint: MediaTrackConstraints | boolean = videoInputDevice
    ? { deviceId: { exact: videoInputDevice } }
    : true
  try {
    localVideoStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false })
  } catch (err) {
    vwarn('enableCamera: getUserMedia failed — %s', (err as Error).message)
    return
  }

  const videoTrack = localVideoStream.getVideoTracks()[0]
  if (!videoTrack) {
    vwarn('enableCamera: no video track in stream')
    localVideoStream.getTracks().forEach(t => t.stop())
    localVideoStream = null
    return
  }

  if (localVideoSender) {
    // Re-enable: replaceTrack — no renegotiation needed (transceiver already in SDP)
    vlog('enableCamera: re-enabling — replaceTrack() on existing sender')
    await localVideoSender.replaceTrack(videoTrack)
  } else {
    // First enable: addTrack + client-initiated v=2 renegotiation
    vlog('enableCamera: first enable — addTrack() + v=2 client offer renegotiation')
    localVideoSender = peerConnection.addTrack(videoTrack, localVideoStream)

    // Attach DAVE passthrough transform to the new video sender
    if (sfuDaveEnabled) {
      attachPassthroughSenderTransform(localVideoSender, MediaType.VIDEO, () => negotiatedVideoCodec)
      vlog('DAVE: passthrough sender transform attached to video sender')
    }

    // In v=2 the client drives renegotiation (not `{ event: 'negotiate' }`)
    try {
      const offer = await peerConnection.createOffer()
      await peerConnection.setLocalDescription(offer)
      await waitForIceGatheringComplete(peerConnection)
      sfuSend({
        op: GW_SELECT_PROTOCOL,
        d: {
          protocol: 'webrtc',
          type: 'offer',
          sdp: peerConnection.localDescription?.sdp,
          rtc_connection_id: sfuRtcConnectionId,
        },
      })
      vlog('enableCamera: renegotiation offer sent')
    } catch (err) {
      verr('enableCamera: renegotiation failed: %o', err)
    }
  }

  useVoiceStore.getState().setLocalCameraEnabled(true)
  useVoiceStore.getState().setLocalVideoStream(localVideoStream)
  vlog('enableCamera: camera enabled')
}

/**
 * Stops the local camera.
 *
 * Uses replaceTrack(null) instead of removeTrack() so the video transceiver
 * stays in the negotiated SDP. This lets re-enable work with just replaceTrack()
 * and no SFU renegotiation.
 */
export async function disableCamera(): Promise<void> {
  if (!localVideoSender) {
    vwarn('disableCamera: no video sender')
    return
  }

  vlog('disableCamera: soft-disabling via replaceTrack(null) — preserving transceiver')
  await localVideoSender.replaceTrack(null).catch((e) =>
    vwarn('disableCamera: replaceTrack(null) failed — %o', e),
  )

  if (localVideoStream) {
    for (const track of localVideoStream.getTracks()) {
      track.stop()
    }
    localVideoStream = null
  }

  useVoiceStore.getState().setLocalCameraEnabled(false)
  useVoiceStore.getState().setLocalVideoStream(null)
  vlog('disableCamera: camera disabled')
}

// ── Per-peer volume ───────────────────────────────────────────────────────────

export function setPeerVolume(userId: string, volume: number) {
  vlog('setPeerVolume: userId=%s volume=%d', userId, volume)
  const clampedVolume = Math.max(0, Math.min(200, volume))

  useVoiceStore.getState().setPeerVolume(userId, clampedVolume)

  const gain = audioGains[userId]
  if (gain) {
    const settings = useVoiceStore.getState().settings
    const localDeafened = useVoiceStore.getState().localDeafened
    const baseGain = settings.audioOutputLevel / 100
    const effectiveGain = localDeafened ? 0 : baseGain * (clampedVolume / 100)
    gain.gain.value = effectiveGain
    vlog('setPeerVolume: applied gain=%.2f for userId=%s', effectiveGain, userId)
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────

/**
 * Re-acquires the microphone with current audio processing settings.
 * Used when echoCancellation, noiseSuppression, or device settings change.
 */
async function reacquireMicrophone(): Promise<void> {
  if (!peerConnection) return

  const settings = useVoiceStore.getState().settings

  vlog('reacquireMicrophone: re-acquiring with echoCancellation=%s noiseSuppression=%s',
    settings.echoCancellation, settings.noiseSuppression)

  stopInputMonitor()

  for (const track of sentTracks) {
    try { track.stop() } catch { /* already stopped */ }
    const sender = peerConnection.getSenders().find(s => s.track === track)
    if (sender) {
      peerConnection.removeTrack(sender)
    }
  }
  sentTracks = []

  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop()
    }
    localStream = null
  }

  if (localInputGain) {
    localInputGain.disconnect()
    localInputGain = null
  }

  const useNativeSuppression = effectiveNoiseSuppression(settings.denoiserType ?? 'default', settings.noiseSuppression)
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: settings.audioInputDevice ? { exact: settings.audioInputDevice } : undefined,
        autoGainControl: settings.autoGainControl,
        echoCancellation: settings.echoCancellation,
        noiseSuppression: useNativeSuppression,
      },
      video: false
    })

    const ctx = getAudioContext()
    const source = ctx.createMediaStreamSource(localStream)
    localInputGain = ctx.createGain()
    localInputGain.gain.value = settings.audioInputLevel / 100
    cleanupDenoiserNode()
    const denoiserType = effectiveDenoiserType(settings.denoiserType ?? 'default', settings.noiseSuppression)
    denoiserNode = await buildDenoiserNode(denoiserType, ctx, source)
    const preGainNode: AudioNode = denoiserNode ?? source
    preGainNode.connect(localInputGain)

    const destination = ctx.createMediaStreamDestination()
    localInputGain.connect(destination)
    const processedStream = destination.stream
    const processedTracks = processedStream.getAudioTracks()

    for (const track of processedTracks) {
      const sender = peerConnection.addTrack(track, processedStream)
      sentTracks.push(track)
      // Attach DAVE passthrough transform to the new sender
      if (sfuDaveEnabled) {
        attachPassthroughSenderTransform(sender, MediaType.AUDIO, () => Codec.OPUS)
      }
    }

    // Trigger v=2 client renegotiation after adding new tracks
    if (processedTracks.length > 0) {
      try {
        const offer = await peerConnection.createOffer()
        await peerConnection.setLocalDescription(offer)
        await waitForIceGatheringComplete(peerConnection)
        sfuSend({
          op: GW_SELECT_PROTOCOL,
          d: {
            protocol: 'webrtc',
            type: 'offer',
            sdp: peerConnection.localDescription?.sdp,
            rtc_connection_id: sfuRtcConnectionId,
          },
        })
        vlog('reacquireMicrophone: renegotiation offer sent after track swap')
      } catch (offerErr) {
        vwarn('reacquireMicrophone: renegotiation failed: %o', offerErr)
      }
    }

    vlog('reacquireMicrophone: success, added %d processed track(s)', processedTracks.length)
    startInputMonitor()
  } catch (err) {
    verr('reacquireMicrophone: failed - %s', (err as Error).message)
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: settings.autoGainControl,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: useNativeSuppression,
        },
        video: false
      })

      const ctx = getAudioContext()
      const source = ctx.createMediaStreamSource(localStream)
      localInputGain = ctx.createGain()
      localInputGain.gain.value = settings.audioInputLevel / 100
      cleanupDenoiserNode()
      const denoiserType2 = effectiveDenoiserType(settings.denoiserType ?? 'default', settings.noiseSuppression)
      denoiserNode = await buildDenoiserNode(denoiserType2, ctx, source)
      const preGainNode2: AudioNode = denoiserNode ?? source
      preGainNode2.connect(localInputGain)

      const destination = ctx.createMediaStreamDestination()
      localInputGain.connect(destination)
      const processedStream = destination.stream
      const processedTracks = processedStream.getAudioTracks()

      for (const track of processedTracks) {
        const sender = peerConnection.addTrack(track, processedStream)
        sentTracks.push(track)
        if (sfuDaveEnabled) {
          attachPassthroughSenderTransform(sender, MediaType.AUDIO, () => Codec.OPUS)
        }
      }

      vlog('reacquireMicrophone: fallback success, added %d processed track(s)', processedTracks.length)
      startInputMonitor()
    } catch (fallbackErr) {
      verr('reacquireMicrophone: fallback also failed - %s', (fallbackErr as Error).message)
    }
  }
}

/**
 * Updates the output gain of all currently connected peers and the local input gain.
 * If audio processing settings changed while connected, re-acquires the microphone.
 */
export function applyVoiceSettings() {
  const store = useVoiceStore.getState()
  const settings = store.settings
  vlog('applyVoiceSettings: output=%d input=%d', settings.audioOutputLevel, settings.audioInputLevel)

  const outputGain = store.localDeafened ? 0 : settings.audioOutputLevel / 100
  for (const gain of Object.values(audioGains)) {
    gain.gain.value = outputGain
  }

  if (localInputGain) {
    localInputGain.gain.value = settings.audioInputLevel / 100
  }

  if (audioCtx && 'setSinkId' in audioCtx && settings.audioOutputDevice) {
    void (audioCtx as unknown as AudioContextWithSinkId).setSinkId(settings.audioOutputDevice).catch(() => {})
  }

  if (peerConnection && localStream) {
    void reacquireMicrophone()
  } else {
    startInputMonitor()
  }
}

// ── Debug ─────────────────────────────────────────────────────────────────────

export function getVoiceDebugInfo() {
  const store = useVoiceStore.getState()
  return {
    timestamp: new Date().toISOString(),
    signaling: {
      version: 2,
      sessionId: sfuSessionId,
      rtcConnectionId: sfuRtcConnectionId,
      heartbeatInterval: sfuHeartbeatInterval,
    },
    dave: {
      enabled: sfuDaveEnabled,
      required: sfuDaveRequired,
      protocolVersion: daveProtocolVersion,
      epoch: daveEpoch,
      mode: daveMode,
      activeStatus: daveSession?.status ?? null,
      pendingStatus: davePendingSession?.status ?? null,
      browserSupport: supportsEncodedTransforms(),
    },
    connection: {
      channelId: currentChannelId,
      signalingState: peerConnection?.signalingState ?? 'closed',
      iceConnectionState: peerConnection?.iceConnectionState ?? 'closed',
      iceGatheringState: peerConnection?.iceGatheringState ?? 'closed',
      pcConnectionState: peerConnection?.connectionState ?? 'closed',
      sfuSocketState: sfuSocket ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][sfuSocket.readyState] : 'null',
    },
    local: {
      muted: store.localMuted,
      deafened: store.localDeafened,
      stream: localStream ? {
        id: localStream.id,
        tracks: localStream.getTracks().map(t => ({
          kind: t.kind, label: t.label, enabled: t.enabled,
          readyState: t.readyState, muted: t.muted
        }))
      } : null,
      sentTracks: sentTracks.map(t => ({
        id: t.id, label: t.label, enabled: t.enabled,
        readyState: t.readyState, muted: t.muted,
      })),
      gain: localInputGain?.gain.value ?? null,
    },
    remote: {
      peerCount: Object.keys(store.peers).length,
      peers: Object.keys(store.peers).map(uid => ({
        userId: uid,
        speaking: store.peers[uid].speaking,
        gain: audioGains[uid]?.gain.value ?? null,
      }))
    },
    settings: store.settings,
    audioContext: audioCtx ? {
      state: audioCtx.state,
      sampleRate: audioCtx.sampleRate,
      baseLatency: audioCtx.baseLatency,
      outputLatency: audioCtx.outputLatency,
    } : null,
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { __getVoiceDebug: typeof getVoiceDebugInfo }).__getVoiceDebug = getVoiceDebugInfo
}
