import { forwardRef, useRef, useState, useCallback, useMemo, useEffect, useImperativeHandle } from 'react'
import { messageApi, uploadApi } from '@/api/client'
import { toast } from 'sonner'
import MentionInput, { type MentionInputHandle } from './MentionInput'
import PendingAttachmentBar from './PendingAttachmentBar'
import { useTranslation } from 'react-i18next'
import { flushSync } from 'react-dom'
import { useGifStore } from '@/stores/gifStore'
import { Reply, X } from 'lucide-react'
import { isSvgFileLike } from '@/lib/fileTypes'
import type { PendingUploadAttachment } from '@/lib/pendingAttachments'
import { buildMessagePreviewText } from '@/lib/messagePreview'
import { parseInlineMessageContent, type MentionResolver } from '@/lib/messageParser'
import {
  createMessageNonce,
  sendOptimisticChannelMessage,
} from '@/lib/pendingMessageSend'
import type { DtoMessage } from '@/types'

// ── Slash commands ────────────────────────────────────────────────────────────

const SLASH_COMMANDS: Record<string, string> = {
  '/tableflip': '(╯°□°)╯︵ ┻━┻',
  '/unflip': '┬─┬ノ( º _ ºノ)',
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Rate-limit: send typing at most once per 5 seconds.
 * The server's typing indicator expires after ~6 s, so 5 s keeps it alive
 * while the user is continuously typing.
 */
const TYPING_THROTTLE_MS = 5_000
/** Max files per message. */
const MAX_FILES = 10
/** Max single-file size: 25 MB. */
const MAX_FILE_SIZE = 25 * 1024 * 1024

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve image pixel dimensions from a File. Returns null for file-style images like SVG. */
function getImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/') || isSvgFileLike({ contentType: file.type, filename: file.name })) {
      return resolve(null)
    }
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
  disabled?: boolean
  disabledReason?: string
  uploadChannelId?: string
  typingChannelId?: string | null
  resolver?: MentionResolver
  replyTo?: DtoMessage | null
  onCancelReply?: () => void
  onSendMessage?: (payload: {
    content: string
    attachmentIds: number[]
    nonce: string
    reference?: number
  }) => Promise<void>
  sendFailedMessage?: string
}

export interface MessageInputHandle {
  addFiles: (files: FileList | File[]) => void
  focusEditor: () => void
}

const MessageInput = forwardRef<MessageInputHandle, Props>(function MessageInput({
  channelId,
  channelName,
  disabled = false,
  disabledReason,
  uploadChannelId,
  typingChannelId,
  resolver,
  replyTo,
  onCancelReply,
  onSendMessage,
  sendFailedMessage,
}: Props, ref) {
  const lastTypingRef = useRef<number>(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mentionInputRef = useRef<MentionInputHandle>(null)
  const [pendingAttachments, setPendingAttachments] = useState<PendingUploadAttachment[]>([])
  const { t } = useTranslation()
  const contentHosts = useGifStore((s) => s.contentHosts)
  const replyToId = replyTo?.id != null ? String(replyTo.id) : null
  const replyReference = replyTo?.id != null ? (replyTo.id as unknown as number) : undefined
  const replyAuthorName = replyTo?.author?.name?.trim() || t('common.unknown')
  const replyPreviewText = useMemo(
    () => buildMessagePreviewText(replyTo, {
      emptyText: t('messageItem.replyUnavailable'),
      embedsText: t('messageItem.replyEmbeds'),
      attachmentsText: (count) => t('messageItem.replyAttachments', { count }),
      maxLength: 128,
    }),
    [replyTo, t],
  )

  useEffect(() => {
    if (replyToId == null || disabled) return
    mentionInputRef.current?.focusEditor()
  }, [disabled, replyToId])

  useImperativeHandle(ref, () => ({
    addFiles: (files) => {
      void addFiles(files)
    },
    focusEditor: () => {
      mentionInputRef.current?.focusEditor()
    },
  }))

  // ── Attachment management ──────────────────────────────────────────────────

  function removeAttachment(localId: string) {
    setPendingAttachments((prev) => {
      const a = prev.find((x) => x.localId === localId)
      if (a?.objectUrl) URL.revokeObjectURL(a.objectUrl)
      return prev.filter((x) => x.localId !== localId)
    })
  }

  async function addFiles(files: FileList | File[]) {
    if (disabled) return
    const arr = Array.from(files)

    const filtered = arr.filter((f) => {
      if (f.size > MAX_FILE_SIZE) {
        toast.error(t('chat.fileExceedsLimit', { name: f.name }))
        return false
      }
      return true
    })

    if (filtered.length === 0) return

    if (pendingAttachments.length + filtered.length > MAX_FILES) {
      toast.error(t('chat.maxFilesError', { count: MAX_FILES }))
      return
    }

    const newAttachments: PendingUploadAttachment[] = await Promise.all(
      filtered.map(async (file) => {
        const isImage = file.type.startsWith('image/') && !isSvgFileLike({ contentType: file.type, filename: file.name })
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
          processing: false,
          ...(dims ?? {}),
        }
      }),
    )

    setPendingAttachments((prev) => [...prev, ...newAttachments])
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  async function send(content: string) {
    if (disabled) return
    const trimmed = content.trim()
    if (trimmed in SLASH_COMMANDS) {
      content = SLASH_COMMANDS[trimmed]
    }
    // Snapshot which attachments are being sent in THIS call.
    // The user may add more while we're uploading; those get deferred.
    const sending = [...pendingAttachments]
    const attachmentChannelId = uploadChannelId ?? channelId
    const nonce = createMessageNonce()
    const sendingAttachmentIds = new Set(sending.map((attachment) => attachment.localId))
    const sendingAttachmentDrafts = sending.map((attachment) => ({
      localId: attachment.localId,
      file: attachment.file,
      objectUrl: attachment.objectUrl,
      progress: attachment.progress,
      processing: attachment.processing,
      width: attachment.width,
      height: attachment.height,
    }))

    try {
      if (!onSendMessage) {
        let queuedMessage:
          | ReturnType<typeof sendOptimisticChannelMessage>
          | undefined

        flushSync(() => {
          queuedMessage = sendOptimisticChannelMessage({
            channelId,
            uploadChannelId: attachmentChannelId,
            content,
            attachmentDrafts: sendingAttachmentDrafts,
            nonce,
            reference: replyReference,
            contentHosts,
          })
        })

        setPendingAttachments((prev) =>
          prev.filter((attachment) => !sendingAttachmentIds.has(attachment.localId)),
        )
        onCancelReply?.()

        void queuedMessage?.completion.catch(() => {
          toast.error(sendFailedMessage ?? t('chat.sendFailed'))
        })
        return
      }

      let attachmentIds: number[] = []

      if (sending.length > 0) {
        // ── Step 1: Allocate attachment metadata (all in parallel) ───────────
        const allocated = await Promise.all(
          sending.map(async (a) => {
            const res = await messageApi.messageChannelChannelIdAttachmentPost({
              channelId: attachmentChannelId,
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
                channelId: attachmentChannelId,
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
                      x.localId === localId
                        ? { ...x, progress: pct, processing: pct >= 100 }
                        : x,
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

      await onSendMessage({
        content,
        attachmentIds,
        nonce,
        reference: replyReference,
      })

      // Success — revoke object URLs and remove only the attachments we sent.
      sending.forEach((a) => {
        if (a.objectUrl) URL.revokeObjectURL(a.objectUrl)
      })
      setPendingAttachments((prev) =>
        prev.filter((a) => !sending.some((s) => s.localId === a.localId)),
      )
      onCancelReply?.()
    } catch {
      toast.error(sendFailedMessage ?? t('chat.sendFailed'))
      if (onSendMessage) {
        // Mark in-flight attachments as failed so the user sees the error tiles.
        setPendingAttachments((prev) =>
          prev.map((a) =>
            sending.some((s) => s.localId === a.localId) && a.progress > 0 && a.progress < 100
              ? { ...a, progress: -1 }
              : a,
          ).map((a) =>
            sending.some((s) => s.localId === a.localId)
              ? { ...a, processing: false }
              : a,
          ),
        )
      }
    }
  }

  // ── Typing indicator ──────────────────────────────────────────────────────

  function handleTyping() {
    if (disabled) return
    if (typingChannelId === null) return
    const now = Date.now()
    if (now - lastTypingRef.current > TYPING_THROTTLE_MS) {
      lastTypingRef.current = now
      const targetChannelId = typingChannelId ?? channelId
      // POST to the typing endpoint; the backend will broadcast t=301 to all
      // channel subscribers so their typing indicators update in real-time.
      void messageApi.messageChannelChannelIdTypingPost({ channelId: targetChannelId as unknown as number })
    }
  }

  // ── File picker / drag-drop passthrough ───────────────────────────────────

  function handleAttachClick() {
    if (disabled) return
    fileInputRef.current?.click()
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (disabled) return
    if (e.target.files?.length) {
      void addFiles(e.target.files)
      // Reset input so the same file can be selected again after removal.
      e.target.value = ''
    }
  }

  const handleFileDrop = useCallback(
    (files: FileList) => {
      if (disabled) return
      void addFiles(files)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabled, pendingAttachments.length],
  )

  // ── Render ────────────────────────────────────────────────────────────────

  const attachmentBar =
    pendingAttachments.length > 0 ? (
      <PendingAttachmentBar attachments={pendingAttachments} onRemove={removeAttachment} />
    ) : undefined
  const replyBar = replyTo ? (
    <div className="flex items-start gap-2 border-b border-border/60 px-3 py-2">
      <Reply className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-muted-foreground">
          {t('messageItem.replyingTo', { name: replyAuthorName })}
        </p>
        <div className="mt-0.5 line-clamp-1 break-words text-xs text-muted-foreground">
          {parseInlineMessageContent(replyPreviewText, resolver, 'composer-reply')}
        </div>
      </div>
      <button
        type="button"
        onClick={onCancelReply}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label={t('messageItem.cancelReply')}
        title={t('messageItem.cancelReply')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  ) : undefined

  return (
    <div className="px-4 pt-2 shrink-0" style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}>
      {/* Hidden file input driven by the paperclip button */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileChange}
        disabled={disabled}
        aria-hidden
      />

      <MentionInput
        ref={mentionInputRef}
        channelId={channelId}
        channelName={channelName}
        onSend={send}
        onTyping={handleTyping}
        disabled={disabled}
        onAttachClick={handleAttachClick}
        onFileDrop={handleFileDrop}
        topBar={replyBar}
        attachmentBar={attachmentBar}
        hasAttachments={pendingAttachments.length > 0}
      />
      {disabledReason && (
        <p className="px-2 pt-2 text-xs text-muted-foreground">
          {disabledReason}
        </p>
      )}
    </div>
  )
})

MessageInput.displayName = 'MessageInput'

export default MessageInput
