/**
 * OutputTest — plays a test sound through the selected output device
 * so the user can verify their speaker/headphone configuration.
 *
 * Uses a synthesized multi-tone melody (no external audio file needed).
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { Volume2, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface OutputTestProps {
  outputDeviceId: string
  outputLevel: number // 0–200
}

interface AudioContextWithSinkId extends AudioContext {
  setSinkId(sinkId: string): Promise<void>
}

// Test tone: a short ascending melody of pleasant tones
const TEST_NOTES = [523.25, 659.25, 783.99, 1046.5] // C5, E5, G5, C6
const NOTE_DURATION = 0.2  // seconds per note
const NOTE_GAP = 0.05      // gap between notes

export default function OutputTest({ outputDeviceId, outputLevel }: OutputTestProps) {
  const [playing, setPlaying] = useState(false)
  const ctxRef = useRef<AudioContext | null>(null)
  const timeoutRef = useRef<number | null>(null)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
      if (ctxRef.current && ctxRef.current.state !== 'closed') {
        void ctxRef.current.close()
      }
    }
  }, [])

  const handlePlay = useCallback(async () => {
    if (playing) return
    setPlaying(true)

    const ctx = new AudioContext()
    ctxRef.current = ctx

    // Set output device if supported
    if (outputDeviceId && 'setSinkId' in ctx) {
      try {
        await (ctx as unknown as AudioContextWithSinkId).setSinkId(outputDeviceId)
      } catch {
        // fallback to default
      }
    }

    const masterGain = ctx.createGain()
    masterGain.gain.value = Math.min(outputLevel / 100, 2)
    masterGain.connect(ctx.destination)

    let startTime = ctx.currentTime + 0.05

    for (const freq of TEST_NOTES) {
      const osc = ctx.createOscillator()
      const noteGain = ctx.createGain()

      osc.type = 'sine'
      osc.frequency.value = freq

      // Envelope: smooth attack and release to avoid clicks
      noteGain.gain.setValueAtTime(0, startTime)
      noteGain.gain.linearRampToValueAtTime(0.3, startTime + 0.02)
      noteGain.gain.setValueAtTime(0.3, startTime + NOTE_DURATION - 0.03)
      noteGain.gain.linearRampToValueAtTime(0, startTime + NOTE_DURATION)

      osc.connect(noteGain)
      noteGain.connect(masterGain)

      osc.start(startTime)
      osc.stop(startTime + NOTE_DURATION)

      startTime += NOTE_DURATION + NOTE_GAP
    }

    // Total duration of the test sound
    const totalMs = (TEST_NOTES.length * (NOTE_DURATION + NOTE_GAP) + 0.1) * 1000
    timeoutRef.current = window.setTimeout(() => {
      setPlaying(false)
      if (ctxRef.current && ctxRef.current.state !== 'closed') {
        void ctxRef.current.close()
      }
      ctxRef.current = null
    }, totalMs)
  }, [outputDeviceId, outputLevel, playing])

  const handleStop = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (ctxRef.current && ctxRef.current.state !== 'closed') {
      void ctxRef.current.close()
    }
    ctxRef.current = null
    setPlaying(false)
  }, [])

  return (
    <div className="flex items-center gap-3">
      {!playing ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handlePlay()}
          className="gap-2"
        >
          <Volume2 className="w-3.5 h-3.5" />
          Test Output
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={handleStop}
          className="gap-2"
        >
          <Square className="w-3 h-3 fill-current" />
          Stop
        </Button>
      )}
      <span className="text-xs text-muted-foreground">
        {playing ? 'Playing test tone...' : 'Play a test sound through your output device'}
      </span>
    </div>
  )
}
