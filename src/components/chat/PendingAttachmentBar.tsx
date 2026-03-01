import { X, FileIcon, ImageIcon, Film, Music } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingAttachment {
  /** Stable local key (for React lists). */
  localId: string
  file: File
  /** Object URL for image/video preview; null for other file types. */
  objectUrl: string | null
  /**
   * Upload progress 0–100.
   * 0  = not yet started / queued
   * -1 = upload failed
   */
  progress: number
  /** Image / video width in pixels (optional — passed to backend). */
  width?: number
  /** Image / video height in pixels (optional — passed to backend). */
  height?: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FileTypeIcon({ file }: { file: File }) {
  const { type } = file
  if (type.startsWith('image/')) return <ImageIcon className="w-8 h-8 text-muted-foreground" />
  if (type.startsWith('video/')) return <Film className="w-8 h-8 text-muted-foreground" />
  if (type.startsWith('audio/')) return <Music className="w-8 h-8 text-muted-foreground" />
  return <FileIcon className="w-8 h-8 text-muted-foreground" />
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  attachments: PendingAttachment[]
  onRemove: (localId: string) => void
}

export default function PendingAttachmentBar({ attachments, onRemove }: Props) {
  if (attachments.length === 0) return null

  return (
    <div className="flex gap-3 overflow-x-auto px-1 py-2 pb-3 scrollbar-thin">
      {attachments.map((a) => (
        <div key={a.localId} className="relative shrink-0 flex flex-col gap-1 w-28 group">
          {/* Preview tile */}
          <div className="relative w-28 h-28 rounded-lg border border-border bg-muted overflow-hidden flex items-center justify-center">
            {a.file.type.startsWith('image/') && a.objectUrl ? (
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
            {a.progress > 0 && a.progress < 100 && (
              <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-1.5">
                <span className="text-white text-xs font-semibold tabular-nums">{a.progress}%</span>
                <div className="w-16 h-1 rounded-full bg-white/30 overflow-hidden">
                  <div
                    className="h-full bg-white rounded-full transition-[width] duration-200"
                    style={{ width: `${a.progress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Error overlay */}
            {a.progress === -1 && (
              <div className="absolute inset-0 bg-destructive/70 flex items-center justify-center">
                <span className="text-white text-xs font-semibold text-center px-1 leading-tight">
                  Upload<br />failed
                </span>
              </div>
            )}

            {/* Remove button — visible on hover */}
            <button
              type="button"
              onClick={() => onRemove(a.localId)}
              className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-foreground text-background flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-md hover:bg-destructive hover:text-destructive-foreground z-10"
              aria-label={`Remove ${a.file.name}`}
            >
              <X className="w-3 h-3" />
            </button>
          </div>

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
