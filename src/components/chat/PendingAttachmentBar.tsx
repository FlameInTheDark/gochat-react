import { X, FileIcon, ImageIcon, Film, Music } from 'lucide-react'
import { isSvgFileLike } from '@/lib/fileTypes'
import { cn } from '@/lib/utils'
import type { PendingUploadAttachment } from '@/lib/pendingAttachments'

// ── Types ─────────────────────────────────────────────────────────────────────
export type PendingAttachment = PendingUploadAttachment

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FileTypeIcon({ file }: { file: File }) {
  const { type } = file
  if (type.startsWith('image/') && !isSvgFileLike({ contentType: type, filename: file.name })) {
    return <ImageIcon className="w-8 h-8 text-muted-foreground" />
  }
  if (type.startsWith('video/')) return <Film className="w-8 h-8 text-muted-foreground" />
  if (type.startsWith('audio/')) return <Music className="w-8 h-8 text-muted-foreground" />
  return <FileIcon className="w-8 h-8 text-muted-foreground" />
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  attachments: PendingAttachment[]
  onRemove?: (localId: string) => void
  className?: string
  showUploadStatus?: boolean
}

export default function PendingAttachmentBar({
  attachments,
  onRemove,
  className,
  showUploadStatus = false,
}: Props) {
  if (attachments.length === 0) return null

  return (
    <div className={cn('flex gap-3 overflow-x-auto px-1 py-2 pb-3 scrollbar-thin', className)}>
      {attachments.map((a) => (
        <div key={a.localId} className="relative shrink-0 flex flex-col gap-1 w-28 group">
          {/* Preview tile */}
          <div className="relative w-28 h-28 rounded-lg border border-border bg-muted overflow-hidden flex items-center justify-center">
            {!isSvgFileLike({ contentType: a.file.type, filename: a.file.name }) &&
            a.file.type.startsWith('image/') &&
            a.objectUrl ? (
              <img
                src={a.objectUrl}
                alt={a.file.name}
                className="w-full h-full object-cover"
                draggable={false}
              />
            ) : a.file.type.startsWith('video/') && a.objectUrl ? (
              <video
                src={a.objectUrl}
                className="w-full h-full object-cover"
                muted
                preload="metadata"
              />
            ) : (
              <FileTypeIcon file={a.file} />
            )}

            {/* Upload-progress overlay (shown while uploading) */}
            {showUploadStatus && a.progress >= 0 && (a.progress < 100 || a.processing) && (
              <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-1.5">
                <span className="text-white text-xs font-semibold tabular-nums">
                  {a.processing ? 'Processing...' : `${a.progress}%`}
                </span>
                <div className="w-16 h-1 rounded-full bg-white/30 overflow-hidden">
                  <div
                    className="h-full bg-white rounded-full transition-[width] duration-200"
                    style={{ width: `${a.processing ? 100 : a.progress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Error overlay */}
            {showUploadStatus && a.progress === -1 && (
              <div className="absolute inset-0 bg-destructive/70 flex items-center justify-center">
                <span className="text-white text-xs font-semibold text-center px-1 leading-tight">
                  Upload<br />failed
                </span>
              </div>
            )}
          </div>

          {/* Remove button — sibling of the clipped preview so it stays fully visible */}
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(a.localId)}
              className="absolute right-1 top-1 h-5 w-5 rounded-full bg-foreground text-background flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-md hover:bg-destructive hover:text-destructive-foreground z-10"
              aria-label={`Remove ${a.file.name}`}
            >
              <X className="w-3 h-3" />
            </button>
          )}

          {/* File name & size */}
          <p className="text-[10px] text-muted-foreground truncate text-center px-0.5 leading-tight">
            {a.file.name}
          </p>
          <p className="text-[9px] text-muted-foreground/60 text-center">
            {formatBytes(a.file.size)}
          </p>
        </div>
      ))}
    </div>
  )
}
