/**
 * MicTest — Real-time microphone monitoring for Voice & Video settings.
 *
 * Features:
 *   - Real-time volume meter showing mic input level
 *   - Live microphone monitoring (hear yourself in real-time)
 *   - Automatically mutes/deafens user in voice channel during test
 *   - Respects selected input device, volume, and audio processing settings
 *   - Applies the selected denoiser (RNNoise / Speex / browser default)
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Mic, Square, Headphones, Gauge, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useVoiceStore } from '@/stores/voiceStore'
import { setMuted, setDeafened } from '@/services/voiceService'
import {
  buildDenoiserNode, destroyDenoiserNode, effectiveDenoiserType, effectiveNoiseSuppression,
  type DenoiserType, type DenoiserNode,
} from '@/services/denoiserService'

interface MicTestProps {
  inputDeviceId: string
  inputLevel: number      // 0–200
  autoGainControl: boolean
  echoCancellation: boolean
  noiseSuppression: boolean
  denoiserType: DenoiserType
  outputDeviceId: string
  outputLevel: number     // 0–200
  inputMode?: 'voice_activity' | 'push_to_talk'
  voiceActivityThreshold?: number  // dBFS, -100..0
}

// Number of bars in the volume meter
const METER_BARS = 20

export default function MicTest({
  inputDeviceId,
  inputLevel,
  inputMode,
  voiceActivityThreshold,
  autoGainControl,
  echoCancellation,
  noiseSuppression,
  denoiserType,
}: MicTestProps) {
  const [isTesting, setIsTesting] = useState(false)
  const [volume, setVolume] = useState(0) // 0–1 normalized
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [bypassGate, setBypassGate] = useState(false)

  // Track previous voice state to restore after test
  const prevVoiceStateRef = useRef<{ muted: boolean; deafened: boolean } | null>(null)
  const wasInVoiceChannelRef = useRef(false)

  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const gateRef = useRef<GainNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const denoiserNodeRef = useRef<DenoiserNode | null>(null)
  // Stable ref to buildPipeline so the restart effect doesn't depend on inputLevel
  const buildPipelineRef = useRef<typeof buildPipeline | null>(null)

  // Refs so the meter loop can read current VAD settings without being recreated
  const inputModeRef = useRef(inputMode)
  const thresholdRef = useRef(voiceActivityThreshold)
  const bypassGateRef = useRef(false)
  useEffect(() => { inputModeRef.current = inputMode }, [inputMode])
  useEffect(() => { thresholdRef.current = voiceActivityThreshold }, [voiceActivityThreshold])
  useEffect(() => { bypassGateRef.current = bypassGate }, [bypassGate])

  // Get voice channel state
  const channelId = useVoiceStore((s) => s.channelId)
  const isInVoiceChannel = !!channelId

  // Cleanup function
  const stopEverything = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    destroyDenoiserNode(denoiserNodeRef.current)
    denoiserNodeRef.current = null

    // Stop stream tracks
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop()
      }
      streamRef.current = null
    }

    // Close audio context
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      void audioCtxRef.current.close()
      audioCtxRef.current = null
    }

    analyserRef.current = null
    gainRef.current = null
    gateRef.current = null
    setVolume(0)
  }, [])

  // Restore voice channel state when stopping test
  const restoreVoiceState = useCallback(() => {
    if (wasInVoiceChannelRef.current && prevVoiceStateRef.current) {
      // Restore previous mute/deafen state
      setMuted(prevVoiceStateRef.current.muted)
      setDeafened(prevVoiceStateRef.current.deafened)
    }
    wasInVoiceChannelRef.current = false
    prevVoiceStateRef.current = null
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopEverything()
      restoreVoiceState()
    }
  }, [stopEverything, restoreVoiceState])

  // Update gain when inputLevel changes during test
  useEffect(() => {
    if (gainRef.current) {
      gainRef.current.gain.value = inputLevel / 100
    }
  }, [inputLevel])

  // Poll the analyser to read mic volume.
  // Uses the same dBFS scale as the VAD engine so the threshold marker lines up.
  const startMeterLoop = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser) return

    const floatData = new Float32Array(analyser.fftSize)

    const loop = () => {
      analyser.getFloatTimeDomainData(floatData)
      let sum = 0
      for (let i = 0; i < floatData.length; i++) sum += floatData[i] * floatData[i]
      const rms = Math.sqrt(sum / floatData.length)
      // Linear dBFS → 0–1: same formula as VAD engine and VAD meter in settings
      const db = Math.max(20 * Math.log10(Math.max(rms, 1e-8)), -100)
      setVolume(Math.max(0, (db + 100) / 100))

      // Gate playback based on VAD threshold — open only when level exceeds threshold
      // (or when bypass toggle is active)
      const gate = gateRef.current
      if (gate) {
        const threshold = thresholdRef.current
        const mode = inputModeRef.current
        const open = bypassGateRef.current || mode !== 'voice_activity' || threshold == null || db >= threshold
        gate.gain.setTargetAtTime(open ? 1 : 0, analyser.context.currentTime, 0.005)
      }

      rafRef.current = requestAnimationFrame(loop)
    }
    loop()
  }, [])

  /**
   * Builds the audio pipeline for a given stream + AudioContext.
   * Pipeline: source → [denoiserNode?] → gain → analyser (meter)
   *                                            → gateGain → merger → destination
   * gateGain is driven by the meter loop: open when level >= VAD threshold.
   */
  const buildPipeline = useCallback(async (stream: MediaStream, ctx: AudioContext) => {
    const source = ctx.createMediaStreamSource(stream)

    // Insert denoiser if selected (respects noiseSuppression global toggle)
    destroyDenoiserNode(denoiserNodeRef.current)
    denoiserNodeRef.current = await buildDenoiserNode(effectiveDenoiserType(denoiserType, noiseSuppression), ctx, source)
    const postDenoise: AudioNode = denoiserNodeRef.current ?? source

    // Gain node for input level control
    const gain = ctx.createGain()
    gain.gain.value = inputLevel / 100
    gainRef.current = gain
    postDenoise.connect(gain)

    // Down-mix all channels to mono so a USB mic that only sends left channel
    // doesn't play only in the left ear.
    gain.channelCount = 1
    gain.channelCountMode = 'explicit'
    gain.channelInterpretation = 'speakers'

    // Analyser for volume meter (taps pre-gate so meter always shows true level)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    analyserRef.current = analyser
    gain.connect(analyser)

    // Gate node — meter loop opens/closes this based on VAD threshold
    const gate = ctx.createGain()
    gate.gain.value = 1
    gateRef.current = gate
    gain.connect(gate)

    // Up-mix mono back to stereo for playback
    const merger = ctx.createChannelMerger(2)
    gate.connect(merger, 0, 0)
    gate.connect(merger, 0, 1)
    merger.connect(ctx.destination)
  }, [denoiserType, inputLevel])

  // Keep ref in sync so the restart effect below can call the latest buildPipeline
  // without listing it as a dependency (which would also restart on inputLevel changes)
  useEffect(() => { buildPipelineRef.current = buildPipeline }, [buildPipeline])

  // When the test is running and settings that require mic re-init change,
  // silently rebuild the audio pipeline without touching the voice channel state.
  useEffect(() => {
    if (!isTesting) return

    // Tear down only the audio pipeline — voice channel mute/deafen stays in place
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    destroyDenoiserNode(denoiserNodeRef.current); denoiserNodeRef.current = null
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      void audioCtxRef.current.close(); audioCtxRef.current = null
    }
    analyserRef.current = null; gainRef.current = null; gateRef.current = null
    setVolume(0)

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined,
            autoGainControl,
            echoCancellation,
            noiseSuppression: effectiveNoiseSuppression(denoiserType, noiseSuppression),
          },
          video: false,
        })
        streamRef.current = stream
        const ctx = new AudioContext()
        audioCtxRef.current = ctx
        await buildPipelineRef.current!(stream, ctx)
        if (ctx.state === 'suspended') await ctx.resume()
        startMeterLoop()
      } catch {
        // Can't acquire mic with new settings — stop test
        restoreVoiceState()
        setIsTesting(false)
      }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputDeviceId, autoGainControl, echoCancellation, noiseSuppression, denoiserType])

  // Start real-time mic monitoring
  const handleStartTest = useCallback(async () => {
    setPermissionDenied(false)

    // Save current voice state and mute/deafen if in voice channel
    if (isInVoiceChannel) {
      const store = useVoiceStore.getState()
      wasInVoiceChannelRef.current = true
      prevVoiceStateRef.current = {
        muted: store.localMuted,
        deafened: store.localDeafened,
      }
      setMuted(true)
      setDeafened(true)
    }

    const useNativeSuppression = effectiveNoiseSuppression(denoiserType, noiseSuppression)

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined,
          autoGainControl,
          echoCancellation,
          noiseSuppression: useNativeSuppression,
        },
        video: false,
      })
      streamRef.current = stream

      const ctx = new AudioContext()
      audioCtxRef.current = ctx

      await buildPipeline(stream, ctx)

      if (ctx.state === 'suspended') {
        await ctx.resume()
      }

      startMeterLoop()
      setIsTesting(true)
    } catch (err) {
      const error = err as Error
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        setPermissionDenied(true)
      }

      // Try fallback to default device
      if (inputDeviceId && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { autoGainControl, echoCancellation, noiseSuppression: useNativeSuppression },
            video: false,
          })
          streamRef.current = stream

          const ctx = new AudioContext()
          audioCtxRef.current = ctx

          await buildPipeline(stream, ctx)

          if (ctx.state === 'suspended') {
            await ctx.resume()
          }

          startMeterLoop()
          setIsTesting(true)
        } catch {
          restoreVoiceState()
        }
      } else {
        restoreVoiceState()
      }
    }
  }, [inputDeviceId, inputLevel, autoGainControl, echoCancellation, noiseSuppression, denoiserType, isInVoiceChannel, buildPipeline, startMeterLoop, restoreVoiceState])

  // Stop testing
  const handleStopTest = useCallback(() => {
    stopEverything()
    restoreVoiceState()
    setIsTesting(false)
    setBypassGate(false)
  }, [stopEverything, restoreVoiceState])

  // Active bars in the meter
  const activeBars = Math.round(volume * METER_BARS)
  // Threshold marker position: voiceActivityThreshold is dBFS (-100..0) → 0..1
  const thresholdPos = voiceActivityThreshold != null
    ? Math.max(0, Math.min(1, (voiceActivityThreshold + 100) / 100))
    : null

  return (
    <div className="space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Mic Test
      </p>

      {/* Volume meter */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Mic className={cn(
            'w-4 h-4 shrink-0 transition-colors',
            isTesting ? 'text-green-400' : 'text-muted-foreground',
          )} />
          <div className="flex-1 relative flex gap-[2px] h-3">
            {Array.from({ length: METER_BARS }).map((_, i) => {
              const isActive = i < activeBars
              // Color gradient: green -> yellow -> red
              let barColor = 'bg-muted'
              if (isActive) {
                const ratio = i / METER_BARS
                if (ratio < 0.6) barColor = 'bg-green-500'
                else if (ratio < 0.85) barColor = 'bg-yellow-500'
                else barColor = 'bg-red-500'
              }
              return (
                <div
                  key={i}
                  className={cn(
                    'flex-1 rounded-[1px] transition-colors duration-75',
                    barColor,
                  )}
                />
              )
            })}
            {/* Threshold marker — only shown in voice activity mode */}
            {inputMode === 'voice_activity' && thresholdPos !== null && (
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-white/80 rounded-full pointer-events-none"
                style={{ left: `calc(${thresholdPos * 100}% - 1px)` }}
              />
            )}
          </div>
        </div>

        {permissionDenied && (
          <p className="text-xs text-destructive">
            Microphone access denied. Please allow microphone access in your browser settings.
          </p>
        )}
      </div>

      {/* Voice channel warning */}
      {isInVoiceChannel && isTesting && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-yellow-500/10 border border-yellow-500/20">
          <Headphones className="w-4 h-4 text-yellow-500" />
          <p className="text-xs text-yellow-600 dark:text-yellow-400">
            You are muted and deafened in the voice channel while testing your microphone.
          </p>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-2">
        {!isTesting ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleStartTest()}
            className="gap-2"
          >
            <Mic className="w-3.5 h-3.5" />
            Test Microphone
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={handleStopTest}
              className="gap-2 border-red-500/50 text-red-400 hover:text-red-300 hover:bg-red-500/10"
            >
              <Square className="w-3 h-3 fill-current" />
              Stop Testing
            </Button>

            {inputMode === 'voice_activity' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setBypassGate(b => !b)}
                className={cn(
                  'gap-1.5 text-xs font-normal',
                  bypassGate ? 'text-green-400 hover:text-green-300' : 'text-muted-foreground',
                )}
                title={bypassGate ? 'Click to apply threshold' : 'Click to hear yourself without threshold'}
              >
                {bypassGate
                  ? <Volume2 className="w-3.5 h-3.5" />
                  : <Gauge className="w-3.5 h-3.5" />
                }
                {bypassGate ? 'Monitor all' : 'Threshold'}
              </Button>
            )}
          </>
        )}
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        {!isTesting
          ? 'Test your microphone to hear how you sound with your current settings. If you are in a voice channel, you will be temporarily muted and deafened during the test.'
          : 'Speak into your microphone to hear yourself in real-time. Your voice channel audio is muted while testing.'}
      </p>
    </div>
  )
}
