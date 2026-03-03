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
let bindingAliveTimer: number | null = null
let sfuHeartbeatTimer: number | null = null
let pendingCandidates: RTCIceCandidateInit[] = []
let currentChannelId: string | null = null

// Shared AudioContext for all remote peers.
let audioCtx: AudioContext | null = null

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
  if (op === 2) { return }

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
    // Also disconnect their gain node
    if (audioGains[user_id]) {
      audioGains[user_id].disconnect()
      delete audioGains[user_id]
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
    if (ev.track.kind !== 'audio') return

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
      vwarn('ontrack: could NOT resolve userId from any ID candidate — audio will NOT play')
      vwarn('ontrack: candidates were %o', idCandidates)
      userId = 'unknown-' + (ev.track.id || Math.random().toString(36).slice(2, 9))
    }

    vlog('ontrack: resolved userId=%s, adding to voiceStore', userId)
    useVoiceStore.getState().addPeer(userId)

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
    const source = ctx.createMediaStreamSource(stream)
    const gain = ctx.createGain()
    const baseGain = settings.audioOutputLevel / 100
    gain.gain.value = useVoiceStore.getState().localDeafened ? 0 : baseGain

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

function cleanup(sendPresenceClear = true) {
  vlog('cleanup: tearing down voice connection')

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
    vlog('cleanup: stopping %d local tracks', localStream.getTracks().length)
    for (const track of localStream.getTracks()) {
      track.stop()
    }
    localStream = null
  }
  // Stop processed tracks (they're separate from localStream tracks)
  for (const track of sentTracks) {
    try { track.stop() } catch { /* already stopped */ }
  }
  sentTracks = []

  if (localInputGain) {
    localInputGain.disconnect()
    localInputGain = null
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

  // Warm up the AudioContext now, while inside the user-gesture scope, and
  // ensure it's running so the audio pipeline produces real audio (not silence).
  vlog('joinVoice: warming up AudioContext')
  await ensureAudioContextRunning()

  // Request microphone access
  vlog('joinVoice: requesting getUserMedia(audio)')
  const settings = useVoiceStore.getState().settings
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: settings.audioInputDevice ? { exact: settings.audioInputDevice } : undefined,
        autoGainControl: settings.autoGainControl,
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
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
            noiseSuppression: settings.noiseSuppression,
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
    source.connect(localInputGain)

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

    // Start SFU heartbeat
    vlog('joinVoice: starting SFU heartbeat every %d ms', SFU_HEARTBEAT_INTERVAL)
    sfuHeartbeatTimer = window.setInterval(() => {
      if (sfuSocket?.readyState === WebSocket.OPEN) {
        const ping = JSON.stringify({ op: 2, d: { ts: Date.now() } })
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

  // Toggle the SENT (processed) tracks — these are the ones the PeerConnection
  // actually transmits to the SFU.  Toggling the raw localStream tracks may not
  // propagate through the AudioContext pipeline in all browsers.
  if (sentTracks.length > 0) {
    for (const track of sentTracks) {
      track.enabled = !muted
      vlog('setMuted: sent track id=%s enabled=%s', track.id, track.enabled)
    }
  } else if (localStream) {
    // Fallback: if for some reason sentTracks is empty, toggle raw tracks
    vwarn('setMuted: no sentTracks — falling back to localStream tracks')
    for (const track of localStream.getAudioTracks()) {
      track.enabled = !muted
    }
  }

  sfuSend({ op: 7, t: T_MUTE_SELF, d: { muted } })
  useVoiceStore.getState().setLocalMuted(muted)
}

export function setDeafened(deafened: boolean) {
  vlog('setDeafened: %s', deafened)
  const settings = useVoiceStore.getState().settings
  const baseGain = settings.audioOutputLevel / 100
  // Mute / unmute all remote gain nodes
  for (const [uid, gain] of Object.entries(audioGains)) {
    gain.gain.value = deafened ? 0 : baseGain
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
}

/**
 * Updates the output gain of all currently connected peers and the local input gain.
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
