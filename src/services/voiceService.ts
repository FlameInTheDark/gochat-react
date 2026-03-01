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
import { sendRaw } from './wsService'

// BigInt-aware serializer for SFU WS messages (channel IDs are int64 Snowflakes).
// Used for both outgoing (stringify) and incoming (parse) messages — large user IDs
// in speaking events would lose precision with plain JSON.parse.
const _bigJson = JSONBig({ useNativeBigInt: true, storeAsString: true })

// RTC event type constants (match SFUProtocol.md / SFUEventPayloads.md)
const T_JOIN      = 500   // Client→SFU: join; SFU→Client: join ack {ok:true}
const T_OFFER     = 501   // SFU→Client: SDP offer
const T_ANSWER    = 502   // Client→SFU: SDP answer
const T_CANDIDATE = 503   // Bidirectional: trickle ICE candidate
const T_LEAVE     = 504   // Client→SFU: leave / close
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
let bindingAliveTimer: number | null = null
let sfuHeartbeatTimer: number | null = null
let pendingCandidates: RTCIceCandidateInit[] = []
let currentChannelId: string | null = null

// Shared AudioContext for all remote peers.
let audioCtx: AudioContext | null = null

// Gain nodes keyed by userId — used for per-user volume and deafen toggling.
const audioGains: Record<string, GainNode> = {}

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

function getAudioContext(): AudioContext {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext()
    vlog('AudioContext created, state=%s, sampleRate=%d', audioCtx.state, audioCtx.sampleRate)
  }
  if (audioCtx.state === 'suspended') {
    vwarn('AudioContext is suspended — resuming')
    void audioCtx.resume().then(() => vlog('AudioContext resumed, state=%s', audioCtx?.state))
  }
  return audioCtx
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
  vlog('handleOffer: setting remote description (offer, %d chars)', sdp.length)
  await peerConnection.setRemoteDescription({ type: 'offer', sdp })
  vlog('handleOffer: remote description set, signalingState=%s', peerConnection.signalingState)

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
  vlog('handleOffer: local description set, signalingState=%s', peerConnection.signalingState)
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

  // op=2: heartbeat pong from SFU — no action needed
  if (op === 2) { vevt('pong received'); return }

  if (op !== 7) { vwarn('unexpected op=%d', op); return }

  switch (t) {
    case T_JOIN: {
      // Join ack {ok:true}
      const ok = (d as Record<string, unknown> | undefined)?.ok
      vevt('JOIN ACK received, ok=%s, d=%o', ok, d)
      break
    }

    case T_OFFER: {
      const { sdp } = d as { sdp: string }
      vevt('OFFER received (%d chars)', sdp.length)
      void handleOffer(sdp)
      break
    }

    case T_ANSWER: {
      // Server-initiated answer (edge case during renegotiation)
      const { sdp } = d as { sdp: string }
      vevt('ANSWER received (renegotiation, %d chars)', sdp.length)
      void peerConnection?.setRemoteDescription({ type: 'answer', sdp })
      break
    }

    case T_CANDIDATE: {
      // Accept both camelCase (SFUEventPayloads.md) and snake_case
      // (ConnectionProtocol.md) field names — the two docs disagree on casing.
      const c = d as {
        candidate: string
        sdpMid?: string
        sdp_mid?: string
        sdpMLineIndex?: number
        sdp_mline_index?: number
      }
      const init: RTCIceCandidateInit = {
        candidate: c.candidate,
        sdpMid: c.sdpMid ?? c.sdp_mid,
        sdpMLineIndex: c.sdpMLineIndex ?? c.sdp_mline_index,
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
      const { user_id, speaking } = d as { user_id: number | string; speaking: number }
      vevt('SPEAKING user_id=%s speaking=%d', user_id, speaking)
      useVoiceStore.getState().setPeerSpeaking(String(user_id), speaking === 1)
      break
    }

    default:
      vwarn('unhandled SFU event t=%d, d=%o', t, d)
      break
  }
}

function createPeerConnection(): RTCPeerConnection {
  vlog('createPeerConnection: creating RTCPeerConnection')
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  })

  pc.oniceconnectionstatechange = () => {
    vevt('ICE connection state → %s', pc.iceConnectionState)
    if (pc.iceConnectionState === 'failed') {
      verr('ICE FAILED — no media path could be established')
    }
  }

  pc.onicegatheringstatechange = () => {
    vevt('ICE gathering state → %s', pc.iceGatheringState)
  }

  pc.onconnectionstatechange = () => {
    vevt('PC connection state → %s', pc.connectionState)
    if (pc.connectionState === 'connected') {
      vlog('WebRTC CONNECTED — media should be flowing')
    }
    if (pc.connectionState === 'failed') {
      verr('PC connection FAILED')
    }
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
    vevt('ontrack: kind=%s, track.id=%s, track.label=%s, streams.length=%d',
      ev.track.kind, ev.track.id, ev.track.label, ev.streams.length)

    ev.streams.forEach((s, i) => {
      vlog('  stream[%d]: id=%s, tracks=%d', i, s.id, s.getTracks().length)
    })

    if (ev.track.kind !== 'audio') {
      vlog('ontrack: skipping non-audio track')
      return
    }

    // Resolve the remote user ID from the stream or track ID.
    let userId: string | null = null

    const idCandidates: string[] = [
      ...ev.streams.map((s) => s.id),
      ev.track.id,
    ]
    vlog('ontrack: ID candidates to parse userId from: %o', idCandidates)

    for (const id of idCandidates) {
      if (!id) continue
      if (id.startsWith('u:')) {
        userId = id.slice(2)
        vlog('ontrack: matched u: prefix → userId=%s', userId)
        break
      }
      if (id.startsWith('user-')) {
        userId = id.slice(5)
        vlog('ontrack: matched user- prefix → userId=%s', userId)
        break
      }
      const dash = id.indexOf('-')
      if (dash > 0 && /^\d+$/.test(id.slice(0, dash))) {
        userId = id.slice(0, dash)
        vlog('ontrack: matched numeric prefix → userId=%s', userId)
        break
      }
    }

    if (!userId) {
      vwarn('ontrack: could NOT resolve userId from any ID candidate — audio will NOT play')
      vwarn('ontrack: candidates were %o', idCandidates)
      return
    }

    vlog('ontrack: resolved userId=%s, adding to voiceStore', userId)
    useVoiceStore.getState().addPeer(userId)

    const ctx = getAudioContext()
    vlog('ontrack: AudioContext state=%s', ctx.state)

    // If ev.streams[0] is missing, wrap the raw track in a fresh MediaStream
    const stream = ev.streams[0] ?? new MediaStream([ev.track])
    if (!ev.streams[0]) {
      vwarn('ontrack: ev.streams[0] was undefined — created fallback MediaStream from track')
    }

    vlog('ontrack: creating AudioContext graph for userId=%s', userId)
    const source = ctx.createMediaStreamSource(stream)
    const gain = ctx.createGain()
    gain.gain.value = useVoiceStore.getState().localDeafened ? 0 : 1
    vlog('ontrack: gain.value=%d (deafened=%s)', gain.gain.value, useVoiceStore.getState().localDeafened)

    source.connect(gain)
    gain.connect(ctx.destination)
    vlog('ontrack: audio graph connected: source → gain(%.1f) → destination', gain.gain.value)

    if (audioGains[userId]) {
      vwarn('ontrack: replacing existing gain node for userId=%s', userId)
      audioGains[userId].disconnect()
    }
    audioGains[userId] = gain

    // Log track state for debugging
    vlog('ontrack: track.readyState=%s, track.muted=%s, track.enabled=%s',
      ev.track.readyState, ev.track.muted, ev.track.enabled)
    ev.track.onmute = () => vwarn('remote track MUTED for userId=%s', userId)
    ev.track.onunmute = () => vlog('remote track UNMUTED for userId=%s', userId)
    ev.track.onended = () => vwarn('remote track ENDED for userId=%s', userId)
  }

  return pc
}

function cleanup(sendPresenceClear = true) {
  vlog('cleanup: tearing down voice connection')

  if (peerConnection) {
    vlog('cleanup: closing RTCPeerConnection (state=%s)', peerConnection.connectionState)
    peerConnection.close()
    peerConnection = null
  }
  if (localStream) {
    vlog('cleanup: stopping %d local tracks', localStream.getTracks().length)
    for (const track of localStream.getTracks()) {
      track.stop()
    }
    localStream = null
  }

  const gainCount = Object.keys(audioGains).length
  vlog('cleanup: disconnecting %d remote audio gain nodes', gainCount)
  for (const gain of Object.values(audioGains)) {
    try { gain.disconnect() } catch { /* already disconnected */ }
  }
  for (const key of Object.keys(audioGains)) {
    delete audioGains[key]
  }

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

  // Warm up the AudioContext now, while inside the user-gesture scope
  vlog('joinVoice: warming up AudioContext')
  getAudioContext()

  // Request microphone access
  vlog('joinVoice: requesting getUserMedia(audio)')
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    const tracks = localStream.getAudioTracks()
    vlog('joinVoice: got %d audio track(s): %o', tracks.length,
      tracks.map(t => ({ id: t.id, label: t.label, enabled: t.enabled, readyState: t.readyState })))
  } catch (err) {
    vwarn('joinVoice: getUserMedia failed (%s) — joining in receive-only mode', (err as Error).message)
    localStream = null
  }

  // Create WebRTC peer connection
  vlog('joinVoice: creating peer connection')
  peerConnection = createPeerConnection()

  // Add local audio tracks
  if (localStream) {
    for (const track of localStream.getAudioTracks()) {
      peerConnection.addTrack(track, localStream)
      vlog('joinVoice: added local audio track id=%s', track.id)
    }
    if (useVoiceStore.getState().localMuted) {
      for (const track of localStream.getAudioTracks()) {
        track.enabled = false
      }
      vlog('joinVoice: local tracks disabled (muted state)')
    }
  } else {
    vwarn('joinVoice: no local stream — no audio tracks added to peer connection')
  }

  // Connect to the SFU
  vlog('joinVoice: opening SFU WebSocket → %s', sfuUrl)
  sfuSocket = new WebSocket(sfuUrl)
  sfuSocket.addEventListener('message', onSfuMessage)

  sfuSocket.addEventListener('open', () => {
    vlog('joinVoice: SFU WebSocket OPEN')

    // RTCJoin
    const joinMsg = { op: 7, t: T_JOIN, d: { channel: BigInt(channelId), token: sfuToken } }
    vlog('joinVoice: sending RTCJoin (t=%d)', T_JOIN)
    sfuSend(joinMsg)

    // Start SFU heartbeat
    vlog('joinVoice: starting SFU heartbeat every %d ms', SFU_HEARTBEAT_INTERVAL)
    sfuHeartbeatTimer = window.setInterval(() => {
      if (sfuSocket?.readyState === WebSocket.OPEN) {
        const ping = JSON.stringify({ op: 2, d: { ts: Date.now() } })
        sfuSocket.send(ping)
        console.debug(TAG + ' → SFU heartbeat ping', S)
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
  vlog('joinVoice: setup complete, waiting for SFU offer...')
}

export function leaveVoice() {
  vlog('leaveVoice: disconnecting')
  if (sfuSocket) {
    sfuSend({ op: 7, t: T_LEAVE, d: {} })
    sfuSocket.close()
    sfuSocket = null
  }
  cleanup()
}

export function setMuted(muted: boolean) {
  vlog('setMuted: %s', muted)
  if (localStream) {
    for (const track of localStream.getAudioTracks()) {
      track.enabled = !muted
    }
  }
  sfuSend({ op: 7, t: T_MUTE_SELF, d: { muted } })
  useVoiceStore.getState().setLocalMuted(muted)
}

export function setDeafened(deafened: boolean) {
  vlog('setDeafened: %s', deafened)
  // Mute / unmute all remote gain nodes
  for (const [uid, gain] of Object.entries(audioGains)) {
    gain.gain.value = deafened ? 0 : 1
    vlog('setDeafened: gain for userId=%s → %d', uid, gain.gain.value)
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
}
