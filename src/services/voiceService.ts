/**
 * Voice Service — manages the SFU WebSocket connection and WebRTC peer connection.
 *
 * Flow:
 *   1. Call joinVoice() with SFU URL + token from the API join endpoint
 *   2. Opens a separate WebSocket to the SFU (not the main WS gateway)
 *   3. Sends RTCJoin (op=7, t=500) → SFU acks → SFU sends SDP offer (t=501)
 *   4. We answer with SDP answer (t=502), exchange ICE candidates (t=503)
 *   5. Periodically sends BindingAlive (op=7, t=509) to the *main* WS gateway
 *      so the server keeps the per-channel SFU route alive
 *   6. Periodically sends op=2 heartbeat to the *SFU* WebSocket itself so the
 *      SFU doesn't close the idle signaling connection (5 s interval per docs)
 *   7. leaveVoice() sends RTCLeave (op=7, t=504) and tears everything down
 */

import JSONBig from 'json-bigint'
import { useVoiceStore } from '@/stores/voiceStore'
import { usePresenceStore } from '@/stores/presenceStore'
import { sendRaw } from './wsService'
import {
  buildDenoiserNode, destroyDenoiserNode, effectiveDenoiserType, effectiveNoiseSuppression,
  type DenoiserNode,
} from './denoiserService'

// BigInt-aware serializer for SFU WS messages (channel IDs are int64 Snowflakes).
// Used for both outgoing (stringify) and incoming (parse) messages — large user IDs
// in speaking events would lose precision with plain JSON.parse.
const _bigJson = JSONBig({ useNativeBigInt: true, storeAsString: true })

// RTC event type constants (match SFUProtocol.md / SFUEventPayloads.md)
const T_JOIN      = 500   // Client→SFU: join; SFU→Client: join ack {ok:true}
const T_OFFER     = 501   // SFU→Client: SDP offer
const T_ANSWER    = 502   // Client→SFU: SDP answer
const T_CANDIDATE = 503   // Bidirectional: trickle ICE candidate
// const T_LEAVE     = 504   // Client→SFU: leave / close (Unused)
const T_MUTE_SELF = 505   // Client→SFU: toggle local microphone publish
const T_SPEAKING  = 514   // SFU→Client: speaking indicator

// How often to send BindingAlive (t=509) to the main WS gateway (ms)
const BINDING_ALIVE_INTERVAL = 25_000
// How often to ping the SFU WebSocket with op=2 (ms).
// Server-side heartbeat interval is 5 s per docs; we match it exactly.
const SFU_HEARTBEAT_INTERVAL = 5_000

let sfuSocket: WebSocket | null = null
let peerConnection: RTCPeerConnection | null = null
let localStream: MediaStream | null = null
let localVideoStream: MediaStream | null = null
let localVideoSender: RTCRtpSender | null = null
let bindingAliveTimer: number | null = null
let sfuHeartbeatTimer: number | null = null
let pendingCandidates: RTCIceCandidateInit[] = []
let currentChannelId: string | null = null

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
// We keep references so that setMuted() can toggle the correct tracks.
let sentTracks: MediaStreamTrack[] = []

// ── VAD / PTT input monitor ────────────────────────────────────────────────────
// Time voice must stay above threshold before gate opens (prevents brief pops)
const VAD_ATTACK_MS  = 30
// Time gate stays open after volume drops below threshold (prevents clipping)
const VAD_HANGOVER_MS = 350
// Short hold-release delay after PTT key-up (ms)
const PTT_RELEASE_MS = 200

let vadAnalyserNode: AnalyserNode | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let vadFloatData: any = null  // Float32Array — typed as any to avoid TS strict ArrayBuffer mismatch
let vadRafId: number | null = null
let vadLastTime = 0
let vadAttackElapsed = 0   // ms voice has been above threshold
let vadHangoverLeft  = 0   // ms gate stays open after voice drops below threshold
let pttCleanup: (() => void) | null = null
let pttReleaseTimer: ReturnType<typeof setTimeout> | null = null
// Whether VAD/PTT currently gates transmission (separate from user mute button)
let isTransmitting = false
// Mute state saved when deafen is applied, used to restore it on undeafen
let mutedBeforeDeafen = false

/**
 * Returns the dBFS gate threshold. voiceActivityThreshold is now stored
 * directly as dBFS (-100 to 0), so this is an identity function kept for
 * call-site clarity.
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
  // Notify SFU so other participants get the speaking indicator
  sfuSend({ event: 'speaking', data: shouldEnable ? '1' : '0' })
  vlog('setTransmitting: active=%s muted=%s → track.enabled=%s', active, muted, shouldEnable)
}

/**
 * Start voice activity detection on the local audio input.
 *
 * Uses dBFS (linear in dB) throughout.  getFloatTimeDomainData gives higher precision than byte data,
 * which matters for detecting quiet sounds near the threshold.
 *
 * Gate logic mirrors the demo:
 *   - Attack  (VAD_ATTACK_MS):   voice must be above threshold for this long
 *             before the gate opens — prevents pops/clicks from triggering.
 *   - Hangover (VAD_HANGOVER_MS): gate stays open this long after volume drops
 *             below threshold — prevents word endings from being clipped.
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

  // Start silent — VAD enables tracks when voice is detected
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

  // Start silent — key hold enables tracks
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
 * Get or create the shared AudioContext.
 * If the context is suspended (autoplay policy), actively resumes it.
 * Returns the context — callers should await ensureAudioContextRunning()
 * if they need it to be in 'running' state before piping audio.
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
 * Browsers may create it in 'suspended' due to autoplay policy;
 * this attempts immediate resume and falls back to user-gesture listeners.
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

  // Re-check state after resume — TS narrows away 'running' but runtime can be any state
  if ((ctx.state as string) !== 'running') {
    // Fallback: resume on next user interaction
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

interface SfuPayload {
  op: number
  t?: number
  d?: unknown
}

function sfuSend(data: unknown) {
  if (sfuSocket?.readyState === WebSocket.OPEN) {
    const str = _bigJson.stringify(data)
    console.debug(TAG + ' → SFU', S, data)
    sfuSocket.send(str)
  } else {
    vwarn('sfuSend: socket not open (readyState=%s)', sfuSocket?.readyState)
  }
}

async function handleOffer(sdp: string) {
  if (!peerConnection) { vwarn('handleOffer: no peerConnection'); return }
  
  vlog('handleOffer: setting remote description (offer, %d chars), signalingState=%s', sdp.length, peerConnection.signalingState)

  // If we're not in 'stable' state, we may need to rollback first (glare handling).
  // With SFU-as-offerer this shouldn't normally happen, but be defensive.
  if (peerConnection.signalingState !== 'stable') {
    vwarn('handleOffer: signalingState is %s (not stable), rolling back local description', peerConnection.signalingState)
    await peerConnection.setLocalDescription({ type: 'rollback' })
  }

  await peerConnection.setRemoteDescription({ type: 'offer', sdp })
  vlog('handleOffer: remote description set, signalingState=%s, connectionState=%s', peerConnection.signalingState, peerConnection.connectionState)

  // Drain any ICE candidates that arrived before the remote description was set
  if (pendingCandidates.length > 0) {
    vlog('handleOffer: draining %d pending ICE candidates', pendingCandidates.length)
    for (const candidate of pendingCandidates) {
      await peerConnection.addIceCandidate(candidate)
    }
    pendingCandidates = []
  }

  const answer = await peerConnection.createAnswer()
  vlog('handleOffer: answer created (%d chars)', answer.sdp?.length ?? 0)
  
  await peerConnection.setLocalDescription(answer)
  vlog('handleOffer: local description set, signalingState=%s, connectionState=%s', peerConnection.signalingState, peerConnection.connectionState)
  
  // Check if already connected after setting local description
  if (peerConnection.connectionState === 'connected') {
    vlog('handleOffer: already connected after answer, updating state')
    useVoiceStore.getState().setConnectionState('connected')
  }
  
  sfuSend({ op: 7, t: T_ANSWER, d: { sdp: answer.sdp } })
  vlog('handleOffer: answer sent')
}

function onSfuMessage(event: MessageEvent) {
  let payload: SfuPayload
  try {
    payload = _bigJson.parse(event.data as string) as SfuPayload
  } catch {
    verr('onSfuMessage: JSON parse failed, raw=%s', event.data)
    return
  }

  const { op, t, d } = payload
  console.debug(TAG + ' ← SFU op=%d t=%s', S, op, t ?? '—', d)

  // op=2: heartbeat pong from SFU — calculate RTT
  if (op === 2) {
    const now = Date.now()
    // Only calculate if we have a valid lastPingTime
    if (lastPingTime > 0) {
      const rtt = now - lastPingTime
      // Sanity check: RTT should be between 0 and 10 seconds
      if (rtt >= 0 && rtt <= 10000) {
        useVoiceStore.getState().setPing(rtt)
      }
    }
    return
  }

  // op=7 is SFU signaling
  if (op === 7) {
    switch (t) {
      case T_JOIN: {
        const ok = (d as Record<string, unknown> | undefined)?.ok
        vevt('JOIN ACK received, ok=%s, d=%o', ok, d)
        break
      }
      case T_OFFER: {
        const { sdp } = d as { sdp: string }
        vevt('OFFER received (%d chars)', sdp.length)
        useVoiceStore.getState().setConnectionState('routing')
        void handleOffer(sdp)
        break
      }
      case T_ANSWER: {
        // Renegotiation: SFU responded to an offer we sent (currently unused,
        // but handle it defensively).  Only valid if we're in 'have-local-offer'.
        if (peerConnection?.signalingState === 'have-local-offer') {
          const { sdp } = d as { sdp: string }
          vevt('ANSWER received (renegotiation, %d chars)', sdp.length)
          void peerConnection.setRemoteDescription({ type: 'answer', sdp })
        } else {
          // The SFU sometimes sends a new offer disguised as t=502 for renegotiation.
          // Treat it as an offer if our state is 'stable'.
          if (peerConnection?.signalingState === 'stable') {
            const { sdp } = d as { sdp: string }
            vwarn('T_ANSWER received in stable state — treating as new OFFER')
            void handleOffer(sdp)
          } else {
            vwarn('T_ANSWER received but signalingState=%s — ignoring', peerConnection?.signalingState)
          }
        }
        break
      }
      case T_CANDIDATE: {
        const c = d as {
          candidate: string
          sdpMid?: string
          sdpMLineIndex?: number
        }
        const init: RTCIceCandidateInit = {
          candidate: c.candidate,
          sdpMid: c.sdpMid,
          sdpMLineIndex: c.sdpMLineIndex,
        }
        if (peerConnection?.remoteDescription) {
          vevt('ICE candidate ← SFU (added): %s', c.candidate.slice(0, 80))
          void peerConnection.addIceCandidate(init)
        } else {
          vwarn('ICE candidate ← SFU (queued, no remoteDesc yet): %s', c.candidate.slice(0, 80))
          pendingCandidates.push(init)
        }
        break
      }
      case T_SPEAKING: {
        const { user_id, speaking } = d as { user_id: number | string; speaking: number | boolean }
        vevt('SPEAKING user_id=%s speaking=%s', user_id, speaking)
        // Handle both boolean (ConnectionProtocol) and integer (SFUProtocol)
        const isSpeaking = speaking === true || speaking === 1
        useVoiceStore.getState().setPeerSpeaking(String(user_id), isSpeaking)
        break
      }
      default:
        vwarn('unhandled SFU event t=%d, d=%o', t, d)
        break
    }
    return
  }

  // op=8: user joined voice channel (from gateway)
  if (op === 8) {
    const { user_id } = d as { user_id: string }
    vlog('GATEWAY: user joined voice channel: %s', user_id)
    useVoiceStore.getState().addPeer(user_id)
    return
  }

  // op=9: user left voice channel (from gateway)
  if (op === 9) {
    const { user_id } = d as { user_id: string }
    vlog('GATEWAY: user left voice channel: %s', user_id)
    useVoiceStore.getState().removePeer(user_id)
    if (audioGains[user_id]) {
      audioGains[user_id].disconnect()
      delete audioGains[user_id]
    }
    const leavingStream = remoteStreams.get(user_id)
    if (leavingStream) {
      leavingStream.getTracks().forEach(t => { try { t.stop() } catch { /* ok */ } })
      remoteStreams.delete(user_id)
    }
    return
  }

  vwarn('unexpected op=%d', op)
}

function createPeerConnection(): RTCPeerConnection {
  vlog('createPeerConnection: creating RTCPeerConnection')
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  })

  pc.oniceconnectionstatechange = () => {
    vevt('ICE connection state → %s', pc.iceConnectionState)
    // Also set connected state via ICE connection as backup
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
    } else if (state === 'connecting') {
      vlog('WebRTC CONNECTING — establishing connection')
    } else if (state === 'failed') {
      verr('PC connection FAILED')
    }
  }

  // Check if already connected (race condition)
  if (pc.connectionState === 'connected') {
    vlog('WebRTC ALREADY CONNECTED — setting voice state')
    useVoiceStore.getState().setConnectionState('connected')
  }

  pc.onsignalingstatechange = () => {
    vevt('signaling state → %s', pc.signalingState)
  }

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      vevt('ICE candidate → SFU: %s', ev.candidate.candidate.slice(0, 80))
      sfuSend({
        op: 7,
        t: T_CANDIDATE,
        d: {
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
        },
      })
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
      if (dash > 0 && /^\d+$/.test(id.slice(0, dash))) {
        userId = id.slice(0, dash)
        break
      }
      if (/^\d+$/.test(id)) {
        userId = id
        break
      }
    }

    if (!userId) {
      vwarn('ontrack: could NOT resolve userId from any ID candidate')
      vwarn('ontrack: candidates were %o', idCandidates)
      userId = 'unknown-' + (ev.track.id || Math.random().toString(36).slice(2, 9))
    }

    vlog('ontrack: resolved userId=%s kind=%s, adding to voiceStore', userId, ev.track.kind)
    useVoiceStore.getState().addPeer(userId)

    // ── Video track ────────────────────────────────────────────────────────
    if (ev.track.kind === 'video') {
      // Get or create the canonical per-user stream so the <video> srcObject
      // reference stays stable across SFU-initiated renegotiations, avoiding
      // re-init flicker. New video tracks (camera on after renegotiation) are
      // added into the same stream rather than replacing the stored reference.
      let userStream = remoteStreams.get(userId)
      if (!userStream) {
        userStream = new MediaStream()
        remoteStreams.set(userId, userStream)
        vlog('ontrack: created per-user stream for userId=%s', userId)
      }

      // Replace any stale video track from a previous negotiation round.
      for (const t of userStream.getVideoTracks()) {
        userStream.removeTrack(t)
      }
      userStream.addTrack(ev.track)
      vlog('ontrack: video track added for userId=%s (muted=%s)', userId, ev.track.muted)

      // Store immediately — don't wait for unmute. The VideoFeed component
      // handles a briefly-inactive (muted) track gracefully.
      useVoiceStore.getState().setPeerVideoStream(userId, userStream)

      // Capture for closures — userStream ref is stable but the variable
      // may be reassigned if ontrack fires again before these fire.
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

    // If ev.streams[0] is missing, wrap the raw track in a fresh MediaStream
    const stream = ev.streams[0] ?? new MediaStream([ev.track])
    if (!ev.streams[0]) {
      vwarn('ontrack: ev.streams[0] was undefined — created fallback MediaStream from track')
    }

    // Workaround for Chrome/Edge: ensure the stream is actually playing by attaching it to a hidden audio element.
    // Some browsers won't pump audio through Web Audio API nodes without an <audio> element playing.
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
    // Apply master output level * per-user volume * deafen state
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

    // Ensure the receiver track is enabled
    const receiver = pc.getReceivers().find(r => r.track.id === ev.track.id)
    if (receiver && !receiver.track.enabled) {
      receiver.track.enabled = true
    }

    // MONITORING: Check if track stays unmuted
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

    // Cleanup hidden audio elements
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
  // Stop processed tracks (they're separate from localStream tracks)
  for (const track of sentTracks) {
    try { track.stop() } catch { /* already stopped */ }
  }
  sentTracks = []

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

  pendingCandidates = []
  currentChannelId = null

  // Clean up voice channel member event listeners
  if (memberEventCleanup) {
    memberEventCleanup()
    memberEventCleanup = null
  }

  // Clear voice channel users from presence store for this channel
  if (currentChannelId) {
    usePresenceStore.getState().clearVoiceChannel(currentChannelId)
  }

  if (sendPresenceClear) {
    sendRaw({ op: 3, d: { status: 'online', voice_channel_id: 0 } })
  }
  useVoiceStore.getState().reset()
  vlog('cleanup: done')
}

export async function joinVoice(
  guildId: string,
  channelId: string,
  channelName: string,
  sfuUrl: string,
  sfuToken: string,
): Promise<void> {
  vlog('joinVoice: guildId=%s channelId=%s channelName=%s', guildId, channelId, channelName)
  vlog('joinVoice: sfuUrl=%s', sfuUrl)
  vlog('joinVoice: sfuToken length=%d', sfuToken.length)

  // Tear down any existing voice connection first
  if (sfuSocket || peerConnection) {
    vlog('joinVoice: tearing down previous connection before joining')
    leaveVoice()
  }

  currentChannelId = channelId

  // Set connecting state
  useVoiceStore.getState().setConnectionState('connecting')

  // Warm up the AudioContext now, while inside the user-gesture scope, and
  // ensure it's running so the audio pipeline produces real audio (not silence).
  vlog('joinVoice: warming up AudioContext')
  await ensureAudioContextRunning()

  // Request microphone access
  vlog('joinVoice: requesting getUserMedia(audio)')
  const settings = useVoiceStore.getState().settings
  // When using a custom denoiser, disable browser-native noise suppression to avoid double processing.
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

    // Retry with default device if the specific device failed (e.g. unplugged)
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
    vlog('joinVoice: got %d audio track(s): %o', tracks.length,
      tracks.map(t => ({ id: t.id, label: t.label, enabled: t.enabled, readyState: t.readyState })))
  }

  // Create WebRTC peer connection
  vlog('joinVoice: creating peer connection')
  peerConnection = createPeerConnection()

  // Add local audio tracks through a gain pipeline, or add a recvonly transceiver
  // if no microphone is available.
  sentTracks = []
  if (localStream) {
    const ctx = getAudioContext()

    // Ensure the context is running — if it's suspended, the MediaStreamDestination
    // output will produce silence and the SFU will receive nothing.
    if (ctx.state !== 'running') {
      vwarn('joinVoice: AudioContext state is %s before building send pipeline — attempting resume', ctx.state)
      await ctx.resume().catch(() => {})
    }

    const source = ctx.createMediaStreamSource(localStream)
    localInputGain = ctx.createGain()
    localInputGain.gain.value = settings.audioInputLevel / 100

    // Insert denoiser between source and input gain (if not using browser default).
    cleanupDenoiserNode()
    const denoiserType = effectiveDenoiserType(settings.denoiserType ?? 'default', settings.noiseSuppression)
    vlog('joinVoice: denoiserType=%s (raw=%s noiseSuppression=%s)', denoiserType, settings.denoiserType, settings.noiseSuppression)
    denoiserNode = await buildDenoiserNode(denoiserType, ctx, source)
    const preGainNode: AudioNode = denoiserNode ?? source
    preGainNode.connect(localInputGain)

    // Route through a MediaStreamDestination so gain is applied to the sent audio.
    const destination = ctx.createMediaStreamDestination()
    localInputGain.connect(destination)
    const processedStream = destination.stream
    const processedTracks = processedStream.getAudioTracks()

    vlog('joinVoice: processed stream has %d audio track(s)', processedTracks.length)

    for (const track of processedTracks) {
      peerConnection.addTrack(track, processedStream)
      sentTracks.push(track)
      vlog('joinVoice: added processed audio track id=%s label=%s (gain=%.2f)',
        track.id, track.label, localInputGain.gain.value)
    }

    // Apply muted state to the SENT tracks (not raw mic tracks)
    if (useVoiceStore.getState().localMuted) {
      for (const track of sentTracks) {
        track.enabled = false
      }
      vlog('joinVoice: sent tracks disabled (muted state)')
    }
  } else {
    // No microphone — add a recvonly transceiver so the SFU's offer can include
    // audio m-lines for remote peers and we can receive their audio.
    vwarn('joinVoice: no local stream — adding recvonly audio transceiver')
    peerConnection.addTransceiver('audio', { direction: 'recvonly' })
  }

  // Connect to the SFU
  vlog('joinVoice: opening SFU WebSocket → %s', sfuUrl)
  sfuSocket = new WebSocket(sfuUrl)
  sfuSocket.addEventListener('message', onSfuMessage)

  sfuSocket.addEventListener('open', () => {
    vlog('joinVoice: SFU WebSocket OPEN')

    // RTCJoin
    const joinMsg = { op: 7, t: T_JOIN, d: { channel: channelId, token: sfuToken } }
    vlog('joinVoice: sending RTCJoin (t=%d)', T_JOIN)
    sfuSend(joinMsg)

    // Send initial ping immediately for fast RTT measurement
    vlog('joinVoice: sending initial ping')
    lastPingTime = Date.now()
    const initialPing = JSON.stringify({ op: 2, d: { ts: lastPingTime } })
    sfuSocket?.send(initialPing)

    // Start SFU heartbeat
    vlog('joinVoice: starting SFU heartbeat every %d ms', SFU_HEARTBEAT_INTERVAL)
    sfuHeartbeatTimer = window.setInterval(() => {
      if (sfuSocket?.readyState === WebSocket.OPEN) {
        lastPingTime = Date.now()
        const ping = JSON.stringify({ op: 2, d: { ts: lastPingTime } })
        sfuSocket.send(ping)
      }
    }, SFU_HEARTBEAT_INTERVAL)
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
  useVoiceStore.getState().setVoiceChannel(guildId, channelId, channelName)
  sendRaw({ op: 3, d: { status: 'online', voice_channel_id: BigInt(channelId) } })

  // Listen for other users joining/leaving this voice channel via main gateway events
  const handleMemberJoinVoice = (e: Event) => {
    const detail = (e as CustomEvent).detail as { user_id?: string | number }
    if (detail?.user_id !== undefined) {
      const userId = String(detail.user_id)
      vlog('ws:member_join_voice received for user=%s', userId)
      useVoiceStore.getState().addPeer(userId)
    }
  }

  const handleMemberLeaveVoice = (e: Event) => {
    const detail = (e as CustomEvent).detail as { user_id?: string | number }
    if (detail?.user_id !== undefined) {
      const userId = String(detail.user_id)
      vlog('ws:member_leave_voice received for user=%s', userId)
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
  }

  window.addEventListener('ws:member_join_voice', handleMemberJoinVoice)
  window.addEventListener('ws:member_leave_voice', handleMemberLeaveVoice)

  // Store cleanup function for event listeners
  memberEventCleanup = () => {
    window.removeEventListener('ws:member_join_voice', handleMemberJoinVoice)
    window.removeEventListener('ws:member_leave_voice', handleMemberLeaveVoice)
    vlog('voiceService: voice channel member event listeners removed')
  }

  // Start VAD or PTT based on current settings.
  // VAD starts in "silent" state and enables tracks when voice is detected.
  // PTT starts in "silent" state and enables tracks when key is held.
  startInputMonitor()

  vlog('joinVoice: setup complete, waiting for SFU offer...')
}

export function leaveVoice() {
  vlog('leaveVoice: disconnecting')
  if (sfuSocket) {
    // ConnectionProtocol.md implies just closing the socket
    // sfuSend({ op: 7, t: T_LEAVE, d: {} })
    sfuSocket.close()
    sfuSocket = null
  }
  cleanup()
}

export function setMuted(muted: boolean) {
  vlog('setMuted: %s', muted)

  // Respect the VAD/PTT transmit gate: only enable tracks if VAD/PTT says active.
  // When muting: always disable. When unmuting: restore to current transmit state.
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
  sfuSend({ op: 7, t: T_MUTE_SELF, d: { muted } })

  // Send presence update with new mute state
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
    // Remember whether the mic was already muted, then ensure it is muted
    mutedBeforeDeafen = useVoiceStore.getState().localMuted
    if (!mutedBeforeDeafen) setMuted(true)
  } else {
    // Restore the mute state that was in effect before deafening
    if (!mutedBeforeDeafen) setMuted(false)
  }
  const settings = useVoiceStore.getState().settings
  const baseGain = settings.audioOutputLevel / 100
  // Mute / unmute all remote gain nodes, applying per-user volume
  for (const [uid, gain] of Object.entries(audioGains)) {
    const peerVolume = useVoiceStore.getState().peers[uid]?.volume ?? 100
    const effectiveGain = baseGain * (peerVolume / 100)
    gain.gain.value = deafened ? 0 : effectiveGain
    vlog('setDeafened: gain for userId=%s → %.2f', uid, gain.gain.value)
  }
  // Apply sinkId to AudioContext if supported
  if (audioCtx && (audioCtx as unknown as AudioContextWithSinkId).setSinkId) {
    if (!deafened && settings.audioOutputDevice) {
      void (audioCtx as unknown as AudioContextWithSinkId).setSinkId(settings.audioOutputDevice).catch(() => {})
    }
  }
  // Also disable receiver tracks to save decode work
  if (peerConnection) {
    for (const receiver of peerConnection.getReceivers()) {
      if (receiver.track.kind === 'audio') {
        receiver.track.enabled = !deafened
      }
    }
  }
  useVoiceStore.getState().setLocalDeafened(deafened)

  // Send presence update with new deafen state
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

/**
 * Requests camera access and starts sending video to the peer connection.
 *
 * First enable: addTrack() + ask SFU to renegotiate (establishes the video m-line).
 * Subsequent enables: replaceTrack() on the existing sender — no renegotiation
 * needed because the transceiver is already in the negotiated SDP.
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
    // Re-enable: replace the null/inactive track — no renegotiation required
    // because the video transceiver is already present in the negotiated SDP.
    vlog('enableCamera: re-enabling — replaceTrack() on existing sender')
    await localVideoSender.replaceTrack(videoTrack)
  } else {
    // First enable: add the track (creates a new transceiver) and ask SFU to re-offer
    vlog('enableCamera: first enable — addTrack() + requesting SFU renegotiation')
    localVideoSender = peerConnection.addTrack(videoTrack, localVideoStream)
    sfuSend({ event: 'negotiate' })
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
 * and no SFU renegotiation, avoiding the "no inbound track" bug that occurs
 * when addTrack() tries to add a second video transceiver after removeTrack().
 */
export async function disableCamera(): Promise<void> {
  if (!localVideoSender) {
    vwarn('disableCamera: no video sender')
    return
  }

  vlog('disableCamera: soft-disabling via replaceTrack(null) — preserving transceiver')
  // Await replaceTrack(null) so the sender is truly silent before we stop
  // the physical tracks. Stopping tracks first can cause a brief error state.
  await localVideoSender.replaceTrack(null).catch((e) =>
    vwarn('disableCamera: replaceTrack(null) failed — %o', e),
  )
  // localVideoSender intentionally kept (non-null) for the next enable cycle

  // Stop physical camera tracks (turns off the camera indicator light)
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

export function setPeerVolume(userId: string, volume: number) {
  vlog('setPeerVolume: userId=%s volume=%d', userId, volume)
  // Clamp volume to 0-200 range
  const clampedVolume = Math.max(0, Math.min(200, volume))
  
  // Update the store
  useVoiceStore.getState().setPeerVolume(userId, clampedVolume)
  
  // Apply to the gain node if it exists
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

/**
 * Re-acquires the microphone with current audio processing settings.
 * Used when echoCancellation or noiseSuppression settings change.
 */
async function reacquireMicrophone(): Promise<void> {
  if (!peerConnection) return

  const settings = useVoiceStore.getState().settings

  vlog('reacquireMicrophone: re-acquiring with echoCancellation=%s noiseSuppression=%s',
    settings.echoCancellation, settings.noiseSuppression)

  // Stop VAD/PTT so they don't reference stale analyser/gain nodes
  stopInputMonitor()

  // Stop and remove existing sent tracks from peer connection
  for (const track of sentTracks) {
    try { track.stop() } catch { /* already stopped */ }
    const sender = peerConnection.getSenders().find(s => s.track === track)
    if (sender) {
      peerConnection.removeTrack(sender)
    }
  }
  sentTracks = []

  // Stop local stream tracks
  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop()
    }
    localStream = null
  }

  // Disconnect local input gain
  if (localInputGain) {
    localInputGain.disconnect()
    localInputGain = null
  }

  // Request new microphone access with updated settings
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
      peerConnection.addTrack(track, processedStream)
      sentTracks.push(track)
    }

    vlog('reacquireMicrophone: success, added %d processed track(s)', processedTracks.length)
    startInputMonitor()
  } catch (err) {
    verr('reacquireMicrophone: failed - %s', (err as Error).message)
    // Try with default device as fallback
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
        peerConnection.addTrack(track, processedStream)
        sentTracks.push(track)
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
 * If audio processing settings (echoCancellation/noiseSuppression) changed while
 * connected, re-acquires the microphone with new constraints.
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

  // Re-acquire microphone if connected - new audio processing settings require fresh getUserMedia.
  // reacquireMicrophone() restarts the input monitor after re-acquiring.
  if (peerConnection && localStream) {
    void reacquireMicrophone()
  } else {
    // Restart the input monitor to pick up mode/threshold/key changes
    startInputMonitor()
  }
}

/**
 * Returns a snapshot of the current voice connection state for debugging.
 */
export function getVoiceDebugInfo() {
  const store = useVoiceStore.getState()
  return {
    timestamp: new Date().toISOString(),
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
          kind: t.kind,
          label: t.label,
          enabled: t.enabled,
          readyState: t.readyState,
          muted: t.muted
        }))
      } : null,
      sentTracks: sentTracks.map(t => ({
        id: t.id,
        label: t.label,
        enabled: t.enabled,
        readyState: t.readyState,
        muted: t.muted,
      })),
      gain: localInputGain?.gain.value ?? null,
    },
    remote: {
      peerCount: Object.keys(store.peers).length,
      peers: Object.keys(store.peers).map(uid => ({
        userId: uid,
        speaking: store.peers[uid].speaking,
        gain: audioGains[uid]?.gain.value ?? null,
        tracks: peerConnection?.getReceivers()
          .filter(r => r.track.kind === 'audio')
          .map(r => ({
            id: r.track.id,
            enabled: r.track.enabled,
            readyState: r.track.readyState,
            muted: r.track.muted
          }))
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
