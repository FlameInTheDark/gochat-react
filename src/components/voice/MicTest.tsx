/**
 * MicTest — Discord-style microphone test component for Voice & Video settings.
 *
 * Features:
 *   - Real-time volume meter showing mic input level
 *   - "Let's Check" / "Stop Testing" button that records a short clip
 *   - Plays back the recording so the user can hear how they sound
 *   - Respects selected input device, volume, and audio processing settings
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Mic, Square, Play, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface MicTestProps {
  inputDeviceId: string
  inputLevel: number      // 0–200
  autoGainControl: boolean
  echoCancellation: boolean
  noiseSuppression: boolean
  outputDeviceId: string
  outputLevel: number     // 0–200
}

type TestState = 'idle' | 'recording' | 'playing'

// Number of bars in the volume meter
const METER_BARS = 20
// Max recording duration (seconds) — Discord uses ~5s
const MAX_RECORD_SECONDS = 5

export default function MicTest({
  inputDeviceId,
  inputLevel,
  autoGainControl,
  echoCancellation,
  noiseSuppression,
  outputDeviceId,
  outputLevel,
}: MicTestProps) {
  const [testState, setTestState] = useState<TestState>('idle')
  const [volume, setVolume] = useState(0) // 0–1 normalized
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null)
  const [playbackProgress, setPlaybackProgress] = useState(0)
  const [recordProgress, setRecordProgress] = useState(0)
  const [permissionDenied, setPermissionDenied] = useState(false)

  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const recordTimerRef = useRef<number | null>(null)
  const recordStartRef = useRef<number>(0)

  // Cleanup function
  const stopEverything = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (recordTimerRef.current !== null) {
      clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    }
    recorderRef.current = null
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop()
      }
      streamRef.current = null
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      void audioCtxRef.current.close()
      audioCtxRef.current = null
    }
    analyserRef.current = null
    gainRef.current = null
    setVolume(0)
    setRecordProgress(0)
    setPlaybackProgress(0)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopEverything()
      if (recordingUrl) URL.revokeObjectURL(recordingUrl)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update gain when inputLevel changes during test
  useEffect(() => {
    if (gainRef.current) {
      gainRef.current.gain.value = inputLevel / 100
    }
  }, [inputLevel])

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

  // Acquire mic and set up audio pipeline
  const acquireMic = useCallback(async () => {
    setPermissionDenied(false)
    try {
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

      const ctx = new AudioContext()
      audioCtxRef.current = ctx

      const source = ctx.createMediaStreamSource(stream)
      const gain = ctx.createGain()
      gain.gain.value = inputLevel / 100
      gainRef.current = gain

      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      analyserRef.current = analyser

      // For the meter: source -> gain -> analyser
      source.connect(gain)
      gain.connect(analyser)
      // Don't connect to destination — we don't want to hear ourselves during test

      startMeterLoop()
      return { stream, ctx, gain }
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
          const gain = ctx.createGain()
          gain.gain.value = inputLevel / 100
          gainRef.current = gain

          const analyser = ctx.createAnalyser()
          analyser.fftSize = 2048
          analyserRef.current = analyser

          source.connect(gain)
          gain.connect(analyser)

          startMeterLoop()
          return { stream, ctx, gain }
        } catch {
          return null
        }
      }
      return null
    }
  }, [inputDeviceId, inputLevel, autoGainControl, echoCancellation, noiseSuppression, startMeterLoop])

  // Start recording
  const handleStartTest = useCallback(async () => {
    // Clean up previous recording
    if (recordingUrl) {
      URL.revokeObjectURL(recordingUrl)
      setRecordingUrl(null)
    }

    const result = await acquireMic()
    if (!result) return

    setTestState('recording')
    chunksRef.current = []
    recordStartRef.current = Date.now()
    setRecordProgress(0)

    // Create a processed stream for recording (with gain applied)
    const destination = result.ctx.createMediaStreamDestination()
    result.gain.connect(destination)

    const recorder = new MediaRecorder(destination.stream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm',
    })
    recorderRef.current = recorder

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType })
      const url = URL.createObjectURL(blob)
      setRecordingUrl(url)

      // Stop mic and cleanup audio pipeline
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) track.stop()
        streamRef.current = null
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        void audioCtxRef.current.close()
      }
      audioCtxRef.current = null
      analyserRef.current = null
      gainRef.current = null
      setVolume(0)
      setRecordProgress(0)
    }

    recorder.start(100) // collect data every 100ms

    // Track recording progress
    recordTimerRef.current = window.setInterval(() => {
      const elapsed = (Date.now() - recordStartRef.current) / 1000
      setRecordProgress(Math.min(1, elapsed / MAX_RECORD_SECONDS))
      if (elapsed >= MAX_RECORD_SECONDS) {
        handleStopRecording()
      }
    }, 50)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acquireMic, recordingUrl])

  // Stop recording
  const handleStopRecording = useCallback(() => {
    if (recordTimerRef.current !== null) {
      clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    }
    setTestState('idle')
  }, [])

  // Play back recording
  const handlePlayback = useCallback(() => {
    if (!recordingUrl) return

    const audio = new Audio(recordingUrl)
    audioRef.current = audio
    audio.volume = outputLevel / 100

    // Set output device if supported
    if (outputDeviceId && 'setSinkId' in audio) {
      void (audio as unknown as { setSinkId(id: string): Promise<void> })
        .setSinkId(outputDeviceId)
        .catch(() => {})
    }

    setTestState('playing')
    setPlaybackProgress(0)

    audio.ontimeupdate = () => {
      if (audio.duration && isFinite(audio.duration)) {
        setPlaybackProgress(audio.currentTime / audio.duration)
      }
    }

    audio.onended = () => {
      setTestState('idle')
      setPlaybackProgress(0)
    }

    audio.onerror = () => {
      setTestState('idle')
      setPlaybackProgress(0)
    }

    void audio.play()
  }, [recordingUrl, outputDeviceId, outputLevel])

  // Stop playback
  const handleStopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
    setTestState('idle')
    setPlaybackProgress(0)
  }, [])

  // Reset everything
  const handleReset = useCallback(() => {
    stopEverything()
    if (recordingUrl) URL.revokeObjectURL(recordingUrl)
    setRecordingUrl(null)
    setTestState('idle')
    setPermissionDenied(false)
  }, [stopEverything, recordingUrl])

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
            testState === 'recording' ? 'text-green-400' : 'text-muted-foreground',
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

      {/* Progress bar — shown during recording or playback */}
      {(testState === 'recording' || testState === 'playing') && (
        <div className="space-y-1">
          <div className="h-1 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-100',
                testState === 'recording' ? 'bg-red-500' : 'bg-primary',
              )}
              style={{
                width: `${(testState === 'recording' ? recordProgress : playbackProgress) * 100}%`,
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {testState === 'recording'
              ? `Recording... ${Math.ceil(MAX_RECORD_SECONDS - recordProgress * MAX_RECORD_SECONDS)}s remaining`
              : 'Playing back...'}
          </p>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-2">
        {testState === 'idle' && !recordingUrl && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleStartTest()}
            className="gap-2"
          >
            <Mic className="w-3.5 h-3.5" />
            Let's Check
          </Button>
        )}

        {testState === 'recording' && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleStopRecording}
            className="gap-2 border-red-500/50 text-red-400 hover:text-red-300 hover:bg-red-500/10"
          >
            <Square className="w-3 h-3 fill-current" />
            Stop Recording
          </Button>
        )}

        {testState === 'idle' && recordingUrl && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={handlePlayback}
              className="gap-2"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              Play Back
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleStartTest()}
              className="gap-2"
            >
              <Mic className="w-3.5 h-3.5" />
              Record Again
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              className="gap-2 text-muted-foreground"
              title="Reset"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </Button>
          </>
        )}

        {testState === 'playing' && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleStopPlayback}
            className="gap-2"
          >
            <Square className="w-3 h-3 fill-current" />
            Stop
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        {testState === 'idle' && !recordingUrl
          ? 'Record a short clip to check how your microphone sounds with your current settings.'
          : testState === 'idle' && recordingUrl
            ? 'Your recording is ready. Play it back to hear how you sound, or record again.'
            : testState === 'recording'
              ? 'Speak into your microphone now. The recording will stop automatically after 5 seconds.'
              : 'Listening to your recording through the selected output device.'}
      </p>
    </div>
  )
}
