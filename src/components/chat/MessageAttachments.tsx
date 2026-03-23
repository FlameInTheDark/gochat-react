import { useState, useEffect, useRef } from 'react'
import { FileText, Download, X, Play, Pause, ChevronLeft, ChevronRight, Volume1, Volume2, VolumeX, Maximize, Minimize, Star, ZoomIn, ZoomOut } from 'lucide-react'
import { getFileExtension, isSvgFileLike } from '@/lib/fileTypes'
import { cn } from '@/lib/utils'
import PendingAttachmentBar from '@/components/chat/PendingAttachmentBar'
import type { PendingUploadAttachment } from '@/lib/pendingAttachments'
import type { DtoAttachment } from '@/types'
import AnimatedImage from '@/components/ui/AnimatedImage'
import { useGifStore } from '@/stores/gifStore'

// ── GIF favorite star button ──────────────────────────────────────────────────
function GifStarButton({ url }: { url: string }) {
  const isFavorite = useGifStore((s) => s.favoriteGifs.includes(url))
  const addFavorite = useGifStore((s) => s.addFavorite)
  const removeFavorite = useGifStore((s) => s.removeFavorite)
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        if (isFavorite) removeFavorite(url)
        else addFavorite(url)
      }}
      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 h-7 w-7 flex items-center justify-center rounded-full bg-black/60 text-white transition-opacity hover:bg-black/80 z-10"
      aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
    >
      <Star className={cn('h-4 w-4', isFavorite && 'fill-yellow-400 text-yellow-400')} />
    </button>
  )
}

// ── Attachment kind ───────────────────────────────────────────────────────────
type AttachmentKind = 'image' | 'video' | 'audio' | 'other'

interface AttachmentMeta {
  url: string | null
  previewUrl: string | null
  kind: AttachmentKind
  sizeLabel: string | null
  name: string
  contentType: string | null
  width: number | null
  height: number | null
  isGif: boolean
}

type RenderItem = { attachment: DtoAttachment; meta: AttachmentMeta; index: number }
type RenderGroup =
  | { type: 'gallery'; items: RenderItem[] }
  | { type: 'single'; item: RenderItem }

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_DIM = 360
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'])
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus'])

// ── Helpers ───────────────────────────────────────────────────────────────────
function detectKind(a: DtoAttachment): AttachmentKind {
  const ct = a.content_type?.toLowerCase() ?? ''
  if (ct.startsWith('image/') && !isSvgFileLike({ contentType: a.content_type, filename: a.filename })) return 'image'
  if (ct.startsWith('video/')) return 'video'
  if (ct.startsWith('audio/')) return 'audio'
  const ext = getFileExtension(a.filename)
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return 'other'
}

function formatSize(bytes: number | undefined | null): string | null {
  if (bytes == null || bytes < 0) return null
  const units = ['B', 'KB', 'MB', 'GB'] as const
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  const s = i === 0 ? Math.round(n).toString() : n >= 10 ? n.toFixed(0) : n.toFixed(1)
  return `${s} ${units[i]}`
}

function getMeta(a: DtoAttachment): AttachmentMeta {
  const kind = detectKind(a)
  const name = a.filename?.trim() || 'Attachment'
  const contentType = a.content_type?.trim() || null
  const isGif =
    kind === 'image' &&
    (contentType === 'image/gif' || contentType === 'image/webp' ||
     name.toLowerCase().endsWith('.gif') || name.toLowerCase().endsWith('.webp'))
  const url = a.url?.trim() || null
  const previewUrl = a.preview_url?.trim() || url
  const width = typeof a.width === 'number' && a.width > 0 ? a.width : null
  const height = typeof a.height === 'number' && a.height > 0 ? a.height : null
  return { url, previewUrl, kind, sizeLabel: formatSize(a.size), name, contentType, width, height, isGif }
}

function computeBounds(meta: AttachmentMeta, maxDim: number): { width: number; height: number } {
  const w = meta.width ?? maxDim
  const h = meta.height ?? maxDim
  if (!w && !h) return { width: maxDim, height: maxDim }
  if (!w) return { width: Math.min(maxDim, h), height: h }
  if (!h) return { width: w, height: Math.min(maxDim, w) }
  const scale = Math.min(maxDim / w, maxDim / h, 1)
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

function groupForRender(attachments: DtoAttachment[]): RenderGroup[] {
  const groups: RenderGroup[] = []
  let pending: RenderItem[] = []

  const flush = () => {
    if (pending.length > 1) groups.push({ type: 'gallery', items: pending })
    else if (pending.length === 1) groups.push({ type: 'single', item: pending[0] })
    pending = []
  }

  attachments.forEach((a, index) => {
    const meta = getMeta(a)
    const item: RenderItem = { attachment: a, meta, index }
    if (meta.kind === 'image' && meta.previewUrl) {
      pending.push(item)
    } else {
      flush()
      groups.push({ type: 'single', item })
    }
  })
  flush()

  return groups
}

// ── Shared image lightbox (navigable for galleries) ───────────────────────────
function Lightbox({
  items,
  startIndex,
  onClose,
}: {
  items: RenderItem[]
  startIndex: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(startIndex)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null)
  const hasDragged = useRef(false)
  const item = items[index]!
  const { meta } = item

  // Reset zoom/pan when navigating to a different image
  useEffect(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }, [index])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1))
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(items.length - 1, i + 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items.length, onClose])

  function resetZoom() {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }

  function handleImageClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (hasDragged.current) return
    if (zoom > 1) {
      resetZoom()
    } else {
      setZoom(2)
    }
  }

  function handleWheel(e: React.WheelEvent) {
    e.stopPropagation()
    e.preventDefault()
    setZoom((z) => {
      const next = z - e.deltaY * 0.005
      const clamped = Math.min(4, Math.max(1, next))
      if (clamped === 1) setOffset({ x: 0, y: 0 })
      return clamped
    })
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (zoom <= 1) return
    e.preventDefault()
    hasDragged.current = false
    setDragging(true)
    dragStart.current = { mx: e.clientX, my: e.clientY, ox: offset.x, oy: offset.y }
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!dragging || !dragStart.current) return
    const dx = e.clientX - dragStart.current.mx
    const dy = e.clientY - dragStart.current.my
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasDragged.current = true
    setOffset({ x: dragStart.current.ox + dx, y: dragStart.current.oy + dy })
  }

  function handleMouseUp() {
    setDragging(false)
    dragStart.current = null
  }

  const imageCursor = zoom > 1
    ? (dragging ? 'cursor-grabbing' : 'cursor-grab')
    : 'cursor-zoom-in'

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center"
      onClick={onClose}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Toolbar: zoom reset + download + close */}
      <div className="absolute top-4 right-4 flex items-center gap-2">
        {zoom > 1 && (
          <button
            className="flex items-center justify-center w-9 h-9 rounded-full bg-black/50 text-white/70 hover:text-white hover:bg-black/70 transition-colors"
            onClick={(e) => { e.stopPropagation(); resetZoom() }}
            aria-label="Reset zoom"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
        )}
        {meta.url && (
          <a
            href={meta.url}
            download={meta.name}
            className="flex items-center justify-center w-9 h-9 rounded-full bg-black/50 text-white/70 hover:text-white hover:bg-black/70 transition-colors"
            onClick={(e) => e.stopPropagation()}
            aria-label="Download"
          >
            <Download className="w-4 h-4" />
          </a>
        )}
        <button
          className="flex items-center justify-center w-9 h-9 rounded-full bg-black/50 text-white/70 hover:text-white hover:bg-black/70 transition-colors"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Prev arrow */}
      {items.length > 1 && index > 0 && (
        <button
          className="absolute left-4 flex items-center justify-center w-10 h-10 rounded-full bg-black/50 text-white/70 hover:text-white hover:bg-black/70 transition-colors z-10"
          onClick={(e) => {
            e.stopPropagation()
            setIndex((i) => i - 1)
          }}
          aria-label="Previous image"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      )}

      {/* Full-size image */}
      <img
        key={index}
        src={meta.url ?? meta.previewUrl ?? ''}
        alt={meta.name}
        className={cn('max-w-[90vw] max-h-[85vh] object-contain rounded shadow-2xl select-none', imageCursor)}
        style={{
          transform: `scale(${zoom}) translate(${offset.x / zoom}px, ${offset.y / zoom}px)`,
          transition: dragging ? 'none' : 'transform 0.15s ease',
        }}
        onClick={handleImageClick}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseLeave={handleMouseUp}
        draggable={false}
      />

      {/* Next arrow */}
      {items.length > 1 && index < items.length - 1 && (
        <button
          className="absolute right-4 flex items-center justify-center w-10 h-10 rounded-full bg-black/50 text-white/70 hover:text-white hover:bg-black/70 transition-colors z-10"
          onClick={(e) => {
            e.stopPropagation()
            setIndex((i) => i + 1)
          }}
          aria-label="Next image"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      )}

      {/* Zoom level indicator */}
      {zoom > 1 && (
        <div className="absolute top-4 left-4 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/50 text-white/70 text-xs pointer-events-none select-none">
          <ZoomIn className="w-3 h-3" />
          {Math.round(zoom * 100)}%
        </div>
      )}

      {/* Caption */}
      <div className="absolute bottom-4 flex flex-col items-center gap-1 pointer-events-none select-none">
        <p className="text-white/80 text-sm">
          {meta.name}
          {meta.sizeLabel ? ` · ${meta.sizeLabel}` : ''}
        </p>
        {items.length > 1 && (
          <p className="text-white/50 text-xs">
            {index + 1} / {items.length}
          </p>
        )}
      </div>
    </div>
  )
}

// ── Image thumbnail tile (reused by single image + gallery) ───────────────────
function ImageTile({
  item,
  onClick,
  className,
  style,
}: {
  item: RenderItem
  onClick: () => void
  className?: string
  style?: React.CSSProperties
}) {
  const { meta } = item
  return (
    <div
      className={`rounded overflow-hidden cursor-zoom-in relative group ${className ?? ''}`}
      style={style}
      onClick={onClick}
    >
      {meta.isGif ? (
        <AnimatedImage
          src={meta.url ?? ''}
          preview={meta.previewUrl !== meta.url ? (meta.previewUrl ?? undefined) : undefined}
          alt={meta.name}
          className="w-full h-full object-cover"
          draggable={false}
        />
      ) : (
        <img
          src={meta.previewUrl ?? ''}
          alt={meta.name}
          className="w-full h-full object-cover"
          loading="lazy"
          draggable={false}
        />
      )}
      {meta.isGif && meta.url && <GifStarButton url={meta.url} />}
    </div>
  )
}

// ── Single image with lightbox ────────────────────────────────────────────────
function AttachmentImage({ item, maxDim }: { item: RenderItem; maxDim: number }) {
  const [open, setOpen] = useState(false)
  const { meta } = item
  if (!meta.previewUrl) return null
  const bounds = computeBounds(meta, maxDim)

  return (
    <>
      <ImageTile
        item={item}
        onClick={() => setOpen(true)}
        style={{ width: bounds.width, height: bounds.height, maxWidth: '100%' }}
      />
      {open && (
        <Lightbox items={[item]} startIndex={0} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

// ── Image gallery grid with shared navigable lightbox ────────────────────────
function GalleryGroup({ items, maxDim }: { items: RenderItem[]; maxDim: number }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const cols = items.length === 1 ? 1 : 2

  return (
    <>
      <div
        className="grid gap-1 rounded overflow-hidden"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          maxWidth: maxDim,
        }}
      >
        {items.map((item, i) => (
          <ImageTile
            key={item.index}
            item={item}
            onClick={() => setOpenIndex(i)}
            className="aspect-square"
          />
        ))}
      </div>
      {openIndex !== null && (
        <Lightbox
          items={items}
          startIndex={openIndex}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </>
  )
}

// ── Video: custom player ───────────────────────────────────────────────────────
function AttachmentVideo({ item, maxDim }: { item: RenderItem; maxDim: number }) {
  const { meta } = item
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // All hooks must be unconditional — declared before any early returns
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [hasStarted, setHasStarted] = useState(false)
  const [bufferedEnd, setBufferedEnd] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
  }, [])

  if (!meta.url) return null

  const bounds = computeBounds(meta, maxDim)
  const containerStyle: React.CSSProperties =
    meta.width && meta.height
      ? { width: bounds.width, height: bounds.height, maxWidth: '100%' }
      : { width: '100%', maxWidth: maxDim, aspectRatio: '16/9' }

  // ── Pre-play: thumbnail + play button, no <video> in DOM ─────────────────────
  if (!hasStarted) {
    return (
      <div
        className="relative rounded overflow-hidden bg-zinc-900 inline-block cursor-pointer group"
        style={containerStyle}
        onClick={() => setHasStarted(true)}
      >
        {meta.previewUrl && (
          <img
            src={meta.previewUrl}
            alt={meta.name}
            className="w-full h-full object-cover"
            draggable={false}
          />
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/35 transition-colors">
          <div className="w-14 h-14 rounded-full bg-black/60 flex items-center justify-center backdrop-blur-sm group-hover:scale-110 transition-transform">
            <Play className="w-7 h-7 fill-white stroke-none ml-0.5" />
          </div>
        </div>
      </div>
    )
  }

  // ── Active player: <video> mounted, autoPlay since user clicked ───────────────
  function formatTime(s: number): string {
    if (!isFinite(s) || s < 0) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  function scheduleHide() {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setControlsVisible(false), 2500)
  }

  function revealControls() {
    setControlsVisible(true)
    if (isPlaying) scheduleHide()
  }

  function togglePlay() {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play()
    else v.pause()
  }

  function handleSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const v = videoRef.current
    if (!v || !duration) return
    const t = Number(e.target.value)
    v.currentTime = t
    setCurrentTime(t)
  }

  function handleVolumeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = videoRef.current
    if (!v) return
    const vol = Number(e.target.value)
    v.volume = vol
    v.muted = vol === 0
    setVolume(vol)
    setMuted(vol === 0)
  }

  function toggleMute() {
    const v = videoRef.current
    if (!v) return
    const nm = !muted
    v.muted = nm
    setMuted(nm)
    if (!nm && volume === 0) { v.volume = 0.5; setVolume(0.5) }
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) void containerRef.current?.requestFullscreen()
    else void document.exitFullscreen()
  }

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0
  const bufPct = duration > 0 ? (bufferedEnd / duration) * 100 : 0

  return (
    <div
      ref={containerRef}
      className="relative rounded overflow-hidden bg-black select-none inline-block"
      style={containerStyle}
      onMouseMove={revealControls}
      onMouseLeave={() => { if (isPlaying) setControlsVisible(false) }}
    >
      {/* Video — mounted only after first click, autoPlay since it was a user gesture */}
      <video
        ref={videoRef}
        src={meta.url}
        className="w-full h-full object-contain cursor-pointer"
        autoPlay
        onClick={togglePlay}
        onPlay={() => { setIsPlaying(true); scheduleHide() }}
        onPause={() => {
          setIsPlaying(false)
          setControlsVisible(true)
          if (hideTimer.current) clearTimeout(hideTimer.current)
        }}
        onEnded={() => { setIsPlaying(false); setControlsVisible(true) }}
        onTimeUpdate={() => {
          const v = videoRef.current
          if (!v) return
          setCurrentTime(v.currentTime)
          if (v.buffered.length > 0) setBufferedEnd(v.buffered.end(v.buffered.length - 1))
        }}
        onLoadedMetadata={() => {
          const v = videoRef.current
          if (v) setDuration(v.duration)
        }}
        muted={muted}
      />

      {/* Controls overlay — fades out 2.5 s after last mouse move while playing */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 z-30 transition-opacity duration-200',
          controlsVisible || !isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
      >
        {/* Gradient backdrop */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent pointer-events-none" />

        <div className="relative px-3 pb-2.5 pt-8">
          {/* Seek bar */}
          <div className="relative py-1 mb-1 group/seek cursor-pointer">
            <div className="relative h-[3px]">
              <div className="absolute inset-0 rounded-full bg-white/25" />
              <div className="absolute inset-y-0 left-0 rounded-full bg-white/45" style={{ width: `${bufPct}%` }} />
              <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${pct}%` }} />
              {/* Thumb dot — appears on hover */}
              <div
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white shadow opacity-0 group-hover/seek:opacity-100 transition-opacity pointer-events-none"
                style={{ left: `${pct}%` }}
              />
            </div>
            {/* Transparent range input covers the seek bar for interaction */}
            <input
              type="range"
              min={0}
              max={duration || 100}
              step={0.1}
              value={currentTime}
              onChange={handleSeek}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>

          {/* Controls row */}
          <div className="flex items-center gap-1">
            {/* Play / Pause */}
            <button
              onClick={togglePlay}
              className="flex items-center justify-center w-7 h-7 rounded text-white hover:text-white/70 transition-colors shrink-0"
            >
              {isPlaying
                ? <Pause className="w-4 h-4 fill-white stroke-none" />
                : <Play className="w-4 h-4 fill-white stroke-none" />}
            </button>

            {/* Mute toggle */}
            <button
              onClick={toggleMute}
              className="flex items-center justify-center w-7 h-7 rounded text-white hover:text-white/70 transition-colors shrink-0"
            >
              {(muted || volume === 0)
                ? <VolumeX className="w-4 h-4" />
                : volume < 0.5
                  ? <Volume1 className="w-4 h-4" />
                  : <Volume2 className="w-4 h-4" />}
            </button>

            {/* Volume slider */}
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={handleVolumeChange}
              className="w-16 shrink-0 cursor-pointer"
              style={{ accentColor: 'white' }}
            />

            {/* Time */}
            <span className="text-[11px] text-white/80 tabular-nums ml-1.5 flex-1 whitespace-nowrap">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>

            {/* Download */}
            <a
              href={meta.url}
              download={meta.name}
              className="flex items-center justify-center w-7 h-7 rounded text-white/60 hover:text-white transition-colors shrink-0"
              onClick={(e) => e.stopPropagation()}
              title={`Download ${meta.name}`}
            >
              <Download className="w-4 h-4" />
            </a>

            {/* Fullscreen */}
            <button
              onClick={toggleFullscreen}
              className="flex items-center justify-center w-7 h-7 rounded text-white/60 hover:text-white transition-colors shrink-0"
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Audio ─────────────────────────────────────────────────────────────────────
function AttachmentAudio({ item }: { item: RenderItem }) {
  const { meta } = item
  if (!meta.url) return null
  return (
    <div className="rounded bg-muted/50 p-2 max-w-xs">
      <p className="text-xs text-muted-foreground truncate mb-1">{meta.name}</p>
      <audio src={meta.url} controls className="w-full h-8" />
    </div>
  )
}

// ── Generic file download ─────────────────────────────────────────────────────
function AttachmentFile({ item }: { item: RenderItem }) {
  const { meta } = item
  return (
    <div className="flex items-center gap-2 rounded bg-muted/50 border border-border px-3 py-2 max-w-xs">
      <FileText className="w-8 h-8 text-muted-foreground shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{meta.name}</p>
        {meta.sizeLabel && (
          <p className="text-xs text-muted-foreground">{meta.sizeLabel}</p>
        )}
      </div>
      {meta.url && (
        <a
          href={meta.url}
          download={meta.name}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          onClick={(e) => e.stopPropagation()}
          aria-label={`Download ${meta.name}`}
        >
          <Download className="w-4 h-4" />
        </a>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
interface Props {
  attachments: DtoAttachment[] | null | undefined
  pendingAttachments?: PendingUploadAttachment[] | null | undefined
  maxWidth?: number
}

export default function MessageAttachments({
  attachments,
  pendingAttachments,
  maxWidth = MAX_DIM,
}: Props) {
  if (pendingAttachments?.length) {
    return (
      <PendingAttachmentBar
        attachments={pendingAttachments}
        className="mt-1 px-0 py-0.5 pb-0"
        showUploadStatus
      />
    )
  }

  if (!attachments?.length) return null

  const groups = groupForRender(attachments)

  return (
    <div className="mt-1 flex flex-col gap-1">
      {groups.map((group, gi) => {
        if (group.type === 'gallery') {
          return <GalleryGroup key={gi} items={group.items} maxDim={maxWidth} />
        }
        const { item } = group
        switch (item.meta.kind) {
          case 'image': return <AttachmentImage key={gi} item={item} maxDim={maxWidth} />
          case 'video': return <AttachmentVideo key={gi} item={item} maxDim={maxWidth} />
          case 'audio': return <AttachmentAudio key={gi} item={item} />
          default:      return <AttachmentFile  key={gi} item={item} />
        }
      })}
    </div>
  )
}
