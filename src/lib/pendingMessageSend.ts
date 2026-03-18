import { messageApi, uploadApi } from '@/api/client'
import { needsEmbedSuppression } from '@/lib/gifUrls'
import { useAuthStore } from '@/stores/authStore'
import {
  useMessageStore,
  type PendingMessage,
  type PendingMessageAttachmentDraft,
} from '@/stores/messageStore'
import { useReadStateStore } from '@/stores/readStateStore'
import { maxSnowflake } from '@/lib/snowflake'
import type { DtoAttachment, DtoMessage } from '@/types'

interface SendOptimisticChannelMessageParams {
  channelId: string
  uploadChannelId?: string
  content: string
  attachmentDrafts?: PendingMessageAttachmentDraft[]
  nonce?: string
  reference?: number
  contentHosts?: string[]
}

interface UploadedAttachmentBatch {
  attachmentIds: number[]
  attachments: DtoAttachment[]
}

interface QueuedOptimisticChannelMessage {
  localId: string
  nonce: string
  completion: Promise<void>
}

function createPendingMessageLocalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pending:${crypto.randomUUID()}`
  }
  return `pending:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
}

export function createMessageNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 25)
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`.slice(0, 25)
}

function cloneAttachmentDrafts(
  attachmentDrafts: PendingMessageAttachmentDraft[] | undefined,
): PendingMessageAttachmentDraft[] {
  return (attachmentDrafts ?? []).map((draft) => ({
    localId: draft.localId,
    file: draft.file,
    objectUrl: draft.objectUrl,
    progress: draft.progress,
    processing: draft.processing,
    width: draft.width,
    height: draft.height,
  }))
}

function updatePendingAttachmentDraft(
  localId: string,
  attachmentLocalId: string,
  updater: (draft: PendingMessageAttachmentDraft) => PendingMessageAttachmentDraft,
) {
  useMessageStore.getState().updatePendingMessage(localId, (pending) => ({
    ...pending,
    attachmentDrafts: pending.attachmentDrafts.map((draft) =>
      draft.localId === attachmentLocalId ? updater(draft) : draft,
    ),
  }))
}

function buildOptimisticMessage(params: {
  channelId: string
  content: string
  nonce: string
  reference?: number
  attachments?: DtoAttachment[]
}): DtoMessage {
  const currentUser = useAuthStore.getState().user

  return {
    author: currentUser ?? undefined,
    channel_id: params.channelId as unknown as number,
    content: params.content || undefined,
    nonce: params.nonce,
    reference: params.reference,
    reference_channel_id:
      params.reference != null
        ? params.channelId as unknown as number
        : undefined,
    attachments: params.attachments && params.attachments.length > 0
      ? params.attachments
      : undefined,
    type: params.reference != null ? 1 : 0,
  }
}

function getPendingMessage(localId: string): PendingMessage | null {
  return useMessageStore.getState().findPendingMessage(localId)
}

function markChannelReadBeforeOwnSend(channelId: string) {
  const readStateStore = useReadStateStore.getState()
  const loadedMessages = useMessageStore.getState().messages[channelId] ?? []
  const newestLoadedMessageId = loadedMessages[loadedMessages.length - 1]?.id != null
    ? String(loadedMessages[loadedMessages.length - 1].id)
    : undefined
  const newestSeenMessageId = maxSnowflake(
    readStateStore.lastMessages[channelId],
    newestLoadedMessageId,
  )

  if (!newestSeenMessageId) return
  readStateStore.ackChannel(channelId, newestSeenMessageId)
}

async function uploadPendingAttachments(
  pending: PendingMessage,
): Promise<UploadedAttachmentBatch> {
  if (
    pending.attachmentIds.length > 0 &&
    pending.attachments.length === pending.attachmentIds.length
  ) {
    return {
      attachmentIds: pending.attachmentIds,
      attachments: pending.attachments,
    }
  }

  if (pending.attachmentDrafts.length === 0) {
    return { attachmentIds: [], attachments: [] }
  }

  const uploadChannelId = pending.uploadChannelId
  const allocated = await Promise.all(
    pending.attachmentDrafts.map(async (draft) => {
      const response = await messageApi.messageChannelChannelIdAttachmentPost({
        channelId: uploadChannelId,
        request: {
          filename: draft.file.name,
          content_type: draft.file.type || 'application/octet-stream',
          file_size: draft.file.size,
          width: draft.width,
          height: draft.height,
        },
      })

      return {
        draft,
        dto: response.data,
      }
    }),
  )

  const attachmentIds = await Promise.all(
    allocated.map(async ({ draft, dto }) => {
      await uploadApi.uploadAttachmentsChannelIdAttachmentIdPost(
        {
          channelId: uploadChannelId,
          attachmentId: String(dto.id),
          file: draft.file as unknown as Array<number>,
        },
        {
          headers: { 'Content-Type': draft.file.type || 'application/octet-stream' },
          onUploadProgress: (evt: { loaded: number; total?: number }) => {
            const pct = evt.total
              ? Math.round((evt.loaded / evt.total) * 100)
              : draft.progress
            updatePendingAttachmentDraft(pending.localId, draft.localId, (current) => ({
              ...current,
              progress: pct,
              processing: pct >= 100,
            }))
          },
        },
      )
      updatePendingAttachmentDraft(pending.localId, draft.localId, (current) => ({
        ...current,
        progress: 100,
        processing: false,
      }))
      return dto.id as unknown as number
    }),
  )

  return {
    attachmentIds,
    attachments: allocated.map(({ dto }) => dto),
  }
}

async function dispatchPendingMessage(localId: string): Promise<void> {
  const initialPending = getPendingMessage(localId)
  if (!initialPending) return

  try {
    const uploadedAttachments = await uploadPendingAttachments(initialPending)
    const messageStore = useMessageStore.getState()
    messageStore.updatePendingMessage(localId, (pending) => ({
      ...pending,
      attachmentIds: uploadedAttachments.attachmentIds,
      attachments: uploadedAttachments.attachments,
      message: {
        ...pending.message,
        attachments:
          uploadedAttachments.attachments.length > 0
            ? uploadedAttachments.attachments
            : undefined,
      },
    }))

    const pendingAfterUpload = getPendingMessage(localId)
    if (!pendingAfterUpload) return

    const sentMessage = await messageApi.messageChannelChannelIdPost({
      channelId: pendingAfterUpload.channelId as unknown as number,
      request: {
        content: pendingAfterUpload.content || undefined,
        attachments:
          pendingAfterUpload.attachmentIds.length > 0
            ? pendingAfterUpload.attachmentIds
            : undefined,
        nonce: pendingAfterUpload.nonce,
        enforce_nonce: true,
        reference: pendingAfterUpload.reference,
      },
    })

    if (pendingAfterUpload.suppressEmbeds && sentMessage.data?.id !== undefined) {
      void messageApi.messageChannelChannelIdMessageIdPatch({
        channelId: pendingAfterUpload.channelId as unknown as number,
        messageId: String(sentMessage.data.id),
        request: { flags: 4 },
      }).catch(() => {})
    }
  } catch (error) {
    useMessageStore.getState().updatePendingMessage(localId, (pending) => ({
      ...pending,
      status: 'failed',
      attachmentDrafts: pending.attachmentDrafts.map((draft) => ({
        ...draft,
        progress: draft.progress >= 100 ? 100 : -1,
        processing: false,
      })),
    }))
    throw error
  }
}

function schedulePendingDispatch(localId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      void dispatchPendingMessage(localId).then(resolve).catch(reject)
    }, 0)
  })
}

export function sendOptimisticChannelMessage(
  params: SendOptimisticChannelMessageParams,
): QueuedOptimisticChannelMessage {
  const nonce = params.nonce ?? createMessageNonce()
  const localId = createPendingMessageLocalId()
  const createdAt = Date.now()
  const attachmentDrafts = cloneAttachmentDrafts(params.attachmentDrafts)
  const suppressEmbeds = needsEmbedSuppression(params.content, params.contentHosts ?? [])

  markChannelReadBeforeOwnSend(params.channelId)

  useMessageStore.getState().addPendingMessage({
    localId,
    channelId: params.channelId,
    uploadChannelId: params.uploadChannelId ?? params.channelId,
    nonce,
    status: 'sending',
    createdAt,
    content: params.content,
    reference: params.reference,
    referenceChannelId:
      params.reference != null
        ? params.channelId as unknown as number
        : undefined,
    attachmentIds: [],
    attachments: [],
    attachmentDrafts,
    suppressEmbeds,
    message: buildOptimisticMessage({
      channelId: params.channelId,
      content: params.content,
      nonce,
      reference: params.reference,
    }),
  })

  return {
    localId,
    nonce,
    // Yield once so the optimistic row can paint before request setup begins.
    completion: schedulePendingDispatch(localId),
  }
}

export async function retryPendingChannelMessage(localId: string): Promise<void> {
  const pending = getPendingMessage(localId)
  if (!pending || pending.status === 'sending') return

  markChannelReadBeforeOwnSend(pending.channelId)

  const nextNonce = createMessageNonce()
  useMessageStore.getState().updatePendingMessage(localId, (current) => ({
    ...current,
    nonce: nextNonce,
    status: 'sending',
    attachmentDrafts: current.attachmentDrafts.map((draft) => {
      const keepCompletedUpload =
        current.attachmentDrafts.length > 0 &&
        current.attachments.length === current.attachmentDrafts.length
      return {
        ...draft,
        progress: keepCompletedUpload ? 100 : 0,
        processing: false,
      }
    }),
    message: {
      ...current.message,
      nonce: nextNonce,
    },
  }))

  await dispatchPendingMessage(localId)
}
