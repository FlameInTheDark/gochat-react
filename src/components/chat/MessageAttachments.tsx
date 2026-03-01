import { useState, useEffect } from 'react'
import { FileText, Download, X, Play, ChevronLeft, ChevronRight } from 'lucide-react'
import type { DtoAttachment } from '@/types'

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
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'])
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus'])

// ── Helpers ───────────────────────────────────────────────────────────────────
function detectKind(a: DtoAttachment): AttachmentKind {
  const ct = a.content_type?.toLowerCase() ?? ''
  if (ct.startsWith('image/')) return 'image'
  if (ct.startsWith('video/')) return 'video'
  if (ct.startsWith('audio/')) return 'audio'
  const ext = (a.filename ?? '').toLowerCase().split('.').pop() ?? ''
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
    (contentType === 'image/gif' || name.toLowerCase().endsWith('.gif'))
  const url = a.url?.trim() || null
  const previewUrl = a.preview_url?.trim() || url
  const width = typeof a.width === 'number' && a.width > 0 ? a.width : null
  const height = typeof a.height === 'number' && a.height > 0 ? a.height : null
  return { url, previewUrl, kind, sizeLabel: formatSize(a.size), name, contentType, width, height, isGif }
}

function computeBounds(meta: AttachmentMeta): { width: number; height: number } {
  const w = meta.width ?? MAX_DIM
  const h = meta.height ?? MAX_DIM
  if (!w && !h) return { width: MAX_DIM, height: MAX_DIM }
  if (!w) return { width: Math.min(MAX_DIM, h), height: h }
  if (!h) return { width: w, height: Math.min(MAX_DIM, w) }
  const scale = Math.min(MAX_DIM / w, MAX_DIM / h, 1)
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
  const item = items[index]!
  const { meta } = item

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1))
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(items.length - 1, i + 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items.length, onClose])

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center cursor-zoom-out"
      onClick={onClose}
    >
      {/* Toolbar: download + close */}
      <div className="absolute top-4 right-4 flex items-center gap-2">
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
          className="absolute left-4 flex items-center justify-center w-10 h-10 rounded-full bg-black/50 text-white/70 hover:text-white hover:bg-black/70 transition-colors"
          onClick={(e) => {
            e.stopPropagation()
            setIndex((i) => i - 1)
          }}
          aria-label="Previous image"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      )}

      {/* Full-size image — key forces remount so browser re-fetches cleanly */}
      <img
        key={index}
        src={meta.url ?? meta.previewUrl ?? ''}
        alt={meta.name}
        className="max-w-[90vw] max-h-[85vh] object-contain rounded shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />

      {/* Next arrow */}
      {items.length > 1 && index < items.length - 1 && (
        <button
          className="absolute right-4 flex items-center justify-center w-10 h-10 rounded-full bg-black/50 text-white/70 hover:text-white hover:bg-black/70 transition-colors"
          onClick={(e) => {
            e.stopPropagation()
            setIndex((i) => i + 1)
          }}
          aria-label="Next image"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
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
      className={`rounded overflow-hidden cursor-zoom-in ${className ?? ''}`}
      style={style}
      onClick={onClick}
    >
      <img
        src={meta.previewUrl ?? ''}
        alt={meta.name}
        className="w-full h-full object-cover"
        loading="lazy"
        draggable={false}
      />
    </div>
  )
}

// ── Single image with lightbox ────────────────────────────────────────────────
function AttachmentImage({ item }: { item: RenderItem }) {
  const [open, setOpen] = useState(false)
  const { meta } = item
  if (!meta.previewUrl) return null
  const bounds = computeBounds(meta)

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
function GalleryGroup({ items }: { items: RenderItem[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const cols = items.length === 1 ? 1 : 2

  return (
    <>
      <div
        className="grid gap-1 rounded overflow-hidden"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          maxWidth: MAX_DIM,
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

// ── Video: thumbnail → click to play ─────────────────────────────────────────
function AttachmentVideo({ item }: { item: RenderItem }) {
  const { meta } = item
  const [playing, setPlaying] = useState(false)
  if (!meta.url) return null

  // Show thumbnail preview with a play-button overlay when not yet playing
  if (!playing && meta.previewUrl) {
    const bounds = computeBounds(meta)
    return (
      <div
        className="relative rounded overflow-hidden cursor-pointer inline-block group"
        style={{ width: bounds.width, height: bounds.height, maxWidth: '100%' }}
        onClick={() => setPlaying(true)}
      >
        <img
          src={meta.previewUrl}
          alt={meta.name}
          className="w-full h-full object-cover"
          draggable={false}
        />
        {/* Translucent play-button overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/40 transition-colors">
          <div className="w-14 h-14 rounded-full bg-black/60 flex items-center justify-center backdrop-blur-sm transition-transform group-hover:scale-110">
            <Play className="w-6 h-6 text-white fill-white ml-1" />
          </div>
        </div>
      </div>
    )
  }

  // Inline player (autoplay since the user explicitly clicked "play")
  return (
    <video
      src={meta.url}
      controls
      autoPlay
      className="rounded"
      style={{ maxWidth: MAX_DIM, maxHeight: MAX_DIM, display: 'block' }}
    />
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
}

export default function MessageAttachments({ attachments }: Props) {
  if (!attachments?.length) return null

  const groups = groupForRender(attachments)

  return (
    <div className="mt-1 flex flex-col gap-1">
      {groups.map((group, gi) => {
        if (group.type === 'gallery') {
          return <GalleryGroup key={gi} items={group.items} />
        }
        const { item } = group
        switch (item.meta.kind) {
          case 'image': return <AttachmentImage key={gi} item={item} />
          case 'video': return <AttachmentVideo key={gi} item={item} />
          case 'audio': return <AttachmentAudio key={gi} item={item} />
          default:      return <AttachmentFile  key={gi} item={item} />
        }
      })}
    </div>
  )
}
