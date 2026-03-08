/**
 * VadSlider — Combined sensitivity-threshold slider + live mic level preview.
 *
 * The track shows the real-time mic volume fill (green when above threshold,
 * dim when below). The thumb is the draggable threshold control.
 */

import { useRef } from 'react'
import { cn } from '@/lib/utils'

interface VadSliderProps {
  /** Threshold in dBFS, -100..0 */
  value: number
  onChange: (v: number) => void
  /** Normalised mic level 0–1 (from VAD meter) */
  vadVolume: number
}

export default function VadSlider({ value, onChange, vadVolume }: VadSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)

  const clamp = (v: number) => Math.max(-100, Math.min(0, Math.round(v)))

  const pctFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current
    if (!track) return null
    const rect = track.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    const pct = pctFromPointer(e)
    if (pct !== null) onChange(clamp(-100 + pct * 100))
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!(e.buttons & 1)) return
    const pct = pctFromPointer(e)
    if (pct !== null) onChange(clamp(-100 + pct * 100))
  }

  const fillPct = vadVolume * 100
  const threshPct = value + 100  // -100..0 → 0..100
  const isActive = fillPct >= threshPct

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-valuemin={-100}
      aria-valuemax={0}
      aria-valuenow={value}
      aria-label="Sensitivity threshold"
      tabIndex={0}
      className="relative h-5 flex items-center cursor-pointer select-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onChange(clamp(value - 1)) }
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onChange(clamp(value + 1)) }
        if (e.key === 'Home') { e.preventDefault(); onChange(-100) }
        if (e.key === 'End') { e.preventDefault(); onChange(0) }
      }}
    >
      {/* Track */}
      <div className="absolute inset-x-0 h-1.5 rounded-full bg-muted overflow-hidden">
        {/* Live mic level fill */}
        <div
          className={cn(
            'absolute inset-y-0 left-0 transition-none',
            isActive ? 'bg-green-500' : 'bg-primary/50',
          )}
          style={{ width: `${fillPct}%` }}
        />
      </div>

      {/* Threshold thumb — vertical pill */}
      <div
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-1 h-5 rounded-full bg-foreground shadow pointer-events-none"
        style={{ left: `${threshPct}%` }}
      />
    </div>
  )
}
