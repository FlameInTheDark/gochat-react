/**
 * MicTest — Real-time microphone monitoring for Voice & Video settings.
 *
 * Features:
 *   - Real-time volume meter showing mic input level
 *   - Live microphone monitoring (hear yourself in real-time)
 *   - Automatically mutes/deafens user in voice channel during test
 *   - Respects selected input device, volume, and audio processing settings
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Mic, Square, Headphones } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useVoiceStore } from '@/stores/voiceStore'
import { setMuted, setDeafened } from '@/services/voiceService'

interface MicTestProps {
  inputDeviceId: string
  inputLevel: number      // 0–200
  autoGainControl: boolean
  echoCancellation: boolean
  noiseSuppression: boolean
  outputDeviceId: string
  outputLevel: number     // 0–200
}

// Number of bars in the volume meter
const METER_BARS = 20

export default function MicTest({
  inputDeviceId,
  inputLevel,
  autoGainControl,
  echoCancellation,
  noiseSuppression,
  outputDeviceId,
  outputLevel,
}: MicTestProps) {
  const [isTesting, setIsTesting] = useState(false)
  const [volume, setVolume] = useState(0) // 0–1 normalized
  const [permissionDenied, setPermissionDenied] = useState(false)

  // Track previous voice state to restore after test
  const prevVoiceStateRef = useRef<{ muted: boolean; deafened: boolean } | null>(null)
  const wasInVoiceChannelRef = useRef(false)

  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rafRef = useRef<number | null>(null)

  // Get voice channel state
  const channelId = useVoiceStore((s) => s.channelId)
  const isInVoiceChannel = !!channelId

  // Cleanup function
  const stopEverything = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    // Stop playback audio
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current = null
    }

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
    destinationRef.current = null
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

  // Update output volume when outputLevel changes during test
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = outputLevel / 100
    }
  }, [outputLevel])

  // Poll the analyser to read mic volume
  const startMeterLoop = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser) return

    const dataArray = new Uint8Array(analyser.fftSize)

    const loop = () => {
      analyser.getByteTimeDomainData(dataArray)
      // RMS volume calculation
      let sum = 0
      for (let i = 0; i < dataArray.length; i++) {
        const val = (dataArray[i] - 128) / 128
        sum += val * val
      }
      const rms = Math.sqrt(sum / dataArray.length)
      // Amplify slightly for visual feedback and clamp
      const normalized = Math.min(1, rms * 3)
      setVolume(normalized)
      rafRef.current = requestAnimationFrame(loop)
    }
    loop()
  }, [])

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
      // Mute and deafen in voice channel
      setMuted(true)
      setDeafened(true)
    }

    try {
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined,
          autoGainControl,
          echoCancellation,
          noiseSuppression,
        },
        video: false,
      })
      streamRef.current = stream

      // Create audio context
      const ctx = new AudioContext()
      audioCtxRef.current = ctx

      // Create source from mic stream
      const source = ctx.createMediaStreamSource(stream)

      // Check actual channel count from the track settings
      const audioTrack = stream.getAudioTracks()[0]
      const trackSettings = audioTrack?.getSettings()
      const channelCount = trackSettings?.channelCount ?? source.channelCount ?? 2

      // Create gain node for input level control
      const gain = ctx.createGain()
      gain.gain.value = inputLevel / 100
      gainRef.current = gain

      // Create analyser for volume meter
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      analyserRef.current = analyser

      // Create destination for monitoring output
      const destination = ctx.createMediaStreamDestination()
      destinationRef.current = destination

      // Handle mono-to-stereo conversion for single-channel microphones
      // Some microphones only output to left channel, we want to hear it in both ears
      if (channelCount === 1) {
        // Use ChannelMerger to duplicate mono to both left and right channels
        const merger = ctx.createChannelMerger(2)

        // Connect the mono source to both merger inputs (0=left, 1=right)
        // For a mono source, connect it twice - once to each channel of the merger
        gain.connect(merger, 0, 0)
        gain.connect(merger, 0, 1)

        // Now create a new MediaStreamDestination that has 2 channels
        // Connect merger output to destination
        merger.connect(analyser)
        analyser.connect(destination)

        // Force the destination stream to be stereo by setting channelCount on the track
        const destTrack = destination.stream.getAudioTracks()[0]
        if (destTrack) {
          // Apply constraints to ensure stereo output
          destTrack.applyConstraints({ channelCount: 2 }).catch(() => {
            // If constraints fail, the audio might still work
          })
        }
      } else {
        // For stereo mics that might only have left channel audio,
        // we still want to ensure both channels have audio
        const splitter = ctx.createChannelSplitter(2)
        const merger = ctx.createChannelMerger(2)

        gain.connect(splitter)
        // Connect left channel to both left and right outputs
        splitter.connect(merger, 0, 0)
        splitter.connect(merger, 0, 1)

        merger.connect(analyser)
        analyser.connect(destination)
      }

      // Connect source to gain
      source.connect(gain)

      // Create audio element for playback
      const audio = new Audio()
      audio.srcObject = destination.stream
      audio.volume = outputLevel / 100
      audio.muted = false
      audioRef.current = audio

      // Set output device if supported
      if (outputDeviceId && 'setSinkId' in audio) {
        await (audio as unknown as { setSinkId(id: string): Promise<void> })
          .setSinkId(outputDeviceId)
          .catch(() => {})
      }

      // Start playback
      await audio.play()

      // Start volume meter
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
            audio: { autoGainControl, echoCancellation, noiseSuppression },
            video: false,
          })
          streamRef.current = stream

          const ctx = new AudioContext()
          audioCtxRef.current = ctx

          const source = ctx.createMediaStreamSource(stream)

          // Check actual channel count from the track settings
          const audioTrack = stream.getAudioTracks()[0]
          const trackSettings = audioTrack?.getSettings()
          const channelCount = trackSettings?.channelCount ?? source.channelCount ?? 2

          const gain = ctx.createGain()
          gain.gain.value = inputLevel / 100
          gainRef.current = gain

          const analyser = ctx.createAnalyser()
          analyser.fftSize = 2048
          analyserRef.current = analyser

          const destination = ctx.createMediaStreamDestination()
          destinationRef.current = destination

          // Handle mono-to-stereo conversion for single-channel microphones
          if (channelCount === 1) {
            const merger = ctx.createChannelMerger(2)
            gain.connect(merger, 0, 0)
            gain.connect(merger, 0, 1)
            merger.connect(analyser)
            analyser.connect(destination)
            const destTrack = destination.stream.getAudioTracks()[0]
            if (destTrack) {
              destTrack.applyConstraints({ channelCount: 2 }).catch(() => {})
            }
          } else {
            // For stereo mics that might only have left channel audio
            const splitter = ctx.createChannelSplitter(2)
            const merger = ctx.createChannelMerger(2)
            gain.connect(splitter)
            splitter.connect(merger, 0, 0)
            splitter.connect(merger, 0, 1)
            merger.connect(analyser)
            analyser.connect(destination)
          }

          source.connect(gain)

          const audio = new Audio()
          audio.srcObject = destination.stream
          audio.volume = outputLevel / 100
          audioRef.current = audio

          await audio.play()
          startMeterLoop()
          setIsTesting(true)
        } catch {
          restoreVoiceState()
        }
      } else {
        restoreVoiceState()
      }
    }
  }, [inputDeviceId, inputLevel, autoGainControl, echoCancellation, noiseSuppression, outputDeviceId, outputLevel, isInVoiceChannel, startMeterLoop, restoreVoiceState])

  // Stop testing
  const handleStopTest = useCallback(() => {
    stopEverything()
    restoreVoiceState()
    setIsTesting(false)
  }, [stopEverything, restoreVoiceState])

  // Active bars in the meter
  const activeBars = Math.round(volume * METER_BARS)

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
          <div className="flex-1 flex gap-[2px] h-3">
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
          <Button
            variant="outline"
            size="sm"
            onClick={handleStopTest}
            className="gap-2 border-red-500/50 text-red-400 hover:text-red-300 hover:bg-red-500/10"
          >
            <Square className="w-3 h-3 fill-current" />
            Stop Testing
          </Button>
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
