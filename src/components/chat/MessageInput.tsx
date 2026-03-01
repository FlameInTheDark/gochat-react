import { useRef, useState, useCallback } from 'react'
import { messageApi, uploadApi } from '@/api/client'
import { sendTyping } from '@/services/wsService'
import { toast } from 'sonner'
import MentionInput from './MentionInput'
import PendingAttachmentBar, { type PendingAttachment } from './PendingAttachmentBar'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Rate-limit: send typing at most once per 3 seconds. */
const TYPING_THROTTLE_MS = 3_000
/** Max files per message (mirrors Discord). */
const MAX_FILES = 10
/** Max single-file size: 25 MB. */
const MAX_FILE_SIZE = 25 * 1024 * 1024

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve image pixel dimensions from a File. Returns null for non-images. */
function getImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) return resolve(null)
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      resolve(null)
      URL.revokeObjectURL(url)
    }
    img.src = url
  })
}

/** Resolve video pixel dimensions from a File. Returns null for non-videos. */
function getVideoDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('video/')) return resolve(null)
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      resolve({ width: video.videoWidth, height: video.videoHeight })
      URL.revokeObjectURL(url)
    }
    video.onerror = () => {
      resolve(null)
      URL.revokeObjectURL(url)
    }
    video.src = url
  })
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  channelId: string
  channelName?: string
}

export default function MessageInput({ channelId, channelName }: Props) {
  const lastTypingRef = useRef<number>(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])

  // ── Attachment management ──────────────────────────────────────────────────

  function removeAttachment(localId: string) {
    setPendingAttachments((prev) => {
      const a = prev.find((x) => x.localId === localId)
      if (a?.objectUrl) URL.revokeObjectURL(a.objectUrl)
      return prev.filter((x) => x.localId !== localId)
    })
  }

  async function addFiles(files: FileList | File[]) {
    const arr = Array.from(files)

    const filtered = arr.filter((f) => {
      if (f.size > MAX_FILE_SIZE) {
        toast.error(`${f.name} exceeds the 25 MB limit`)
        return false
      }
      return true
    })

    if (filtered.length === 0) return

    if (pendingAttachments.length + filtered.length > MAX_FILES) {
      toast.error(`You can attach at most ${MAX_FILES} files per message`)
      return
    }

    const newAttachments: PendingAttachment[] = await Promise.all(
      filtered.map(async (file) => {
        const isImage = file.type.startsWith('image/')
        const isVideo = file.type.startsWith('video/')
        // Create an object URL for image/video previews only
        const objectUrl = isImage || isVideo ? URL.createObjectURL(file) : null

        let dims: { width: number; height: number } | null = null
        if (isImage) dims = await getImageDimensions(file)
        else if (isVideo) dims = await getVideoDimensions(file)

        return {
          localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file,
          objectUrl,
          progress: 0,
          ...(dims ?? {}),
        }
      }),
    )

    setPendingAttachments((prev) => [...prev, ...newAttachments])
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  async function send(content: string) {
    // Snapshot which attachments are being sent in THIS call.
    // The user may add more while we're uploading; those get deferred.
    const sending = [...pendingAttachments]

    try {
      let attachmentIds: number[] = []

      if (sending.length > 0) {
        // ── Step 1: Allocate attachment metadata (all in parallel) ───────────
        const allocated = await Promise.all(
          sending.map(async (a) => {
            const res = await messageApi.messageChannelChannelIdAttachmentPost({
              channelId,
              request: {
                filename: a.file.name,
                content_type: a.file.type || 'application/octet-stream',
                file_size: a.file.size,
                width: a.width,
                height: a.height,
              },
            })
            return { localId: a.localId, dto: res.data, file: a.file }
          }),
        )

        // ── Step 2: Upload binary data for each allocation (in parallel) ─────
        attachmentIds = await Promise.all(
          allocated.map(async ({ localId, dto, file }) => {
            await uploadApi.uploadAttachmentsChannelIdAttachmentIdPost(
              {
                channelId,
                attachmentId: String(dto.id),
                // The generated type is Array<number> but the backend expects
                // raw binary — passing the File object directly as Axios does
                // not serialize it (matches legacy SvelteKit behaviour).
                file: file as unknown as Array<number>,
              },
              {
                headers: { 'Content-Type': file.type || 'application/octet-stream' },
                onUploadProgress: (evt: { loaded: number; total?: number }) => {
                  const pct = evt.total
                    ? Math.round((evt.loaded / evt.total) * 100)
                    : 0
                  setPendingAttachments((prev) =>
                    prev.map((x) =>
                      x.localId === localId ? { ...x, progress: pct } : x,
                    ),
                  )
                },
              },
            )
            // dto.id is typed as number but is a BigInt string at runtime
            // (JSONBig storeAsString).  Return it as-is; the JSONBig serialiser
            // will round-trip the large integer correctly when posting the message.
            return dto.id as unknown as number
          }),
        )
      }

      // ── Step 3: Send the message with content + attachment IDs ───────────
      await messageApi.messageChannelChannelIdPost({
        channelId,
        request: {
          content: content || undefined,
          attachments: attachmentIds.length > 0 ? attachmentIds : undefined,
        },
      })

      // Success — revoke object URLs and remove only the attachments we sent.
      sending.forEach((a) => {
        if (a.objectUrl) URL.revokeObjectURL(a.objectUrl)
      })
      setPendingAttachments((prev) =>
        prev.filter((a) => !sending.some((s) => s.localId === a.localId)),
      )
    } catch {
      toast.error('Failed to send message')
      // Mark in-flight attachments as failed so the user sees the error tiles.
      setPendingAttachments((prev) =>
        prev.map((a) =>
          sending.some((s) => s.localId === a.localId) && a.progress > 0 && a.progress < 100
            ? { ...a, progress: -1 }
            : a,
        ),
      )
    }
  }

  // ── Typing indicator ──────────────────────────────────────────────────────

  function handleTyping() {
    const now = Date.now()
    if (now - lastTypingRef.current > TYPING_THROTTLE_MS) {
      lastTypingRef.current = now
      sendTyping(channelId)
    }
  }

  // ── File picker / drag-drop passthrough ───────────────────────────────────

  function handleAttachClick() {
    fileInputRef.current?.click()
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) {
      void addFiles(e.target.files)
      // Reset input so the same file can be selected again after removal.
      e.target.value = ''
    }
  }

  const handleFileDrop = useCallback(
    (files: FileList) => {
      void addFiles(files)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingAttachments.length],
  )

  // ── Render ────────────────────────────────────────────────────────────────

  const attachmentBar =
    pendingAttachments.length > 0 ? (
      <PendingAttachmentBar attachments={pendingAttachments} onRemove={removeAttachment} />
    ) : undefined

  return (
    <div className="px-4 pb-4 pt-2 shrink-0">
      {/* Hidden file input driven by the paperclip button */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileChange}
        aria-hidden
      />

      <MentionInput
        channelId={channelId}
        channelName={channelName}
        onSend={send}
        onTyping={handleTyping}
        onAttachClick={handleAttachClick}
        onFileDrop={handleFileDrop}
        attachmentBar={attachmentBar}
        hasAttachments={pendingAttachments.length > 0}
      />
    </div>
  )
}
