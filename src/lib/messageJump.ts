import type { PendingMessageAttachmentDraft } from '@/stores/messageStore'
import type { DtoMessage } from '@/types'

export type JumpBehavior = 'direct-scroll' | 'preload-window'
export type MessageTimelineMode = 'live-tail' | 'history-browse' | 'jump-travel'
export type MessageTimelineGapStatus = 'idle' | 'loading' | 'error'
export type MessageTimelineGapDirection = 'older' | 'newer'
export type MessageTimelineGapKind = 'older-edge' | 'newer-edge' | 'between' | 'jump-runway'

export interface JumpRequest {
  messageId: string
  requestKey: string
  behavior: JumpBehavior
  positionHint?: number | null
}

export interface MessageTimelineMessageRow {
  kind: 'message'
  key: string
  message: DtoMessage
  grouped: boolean
  pendingLocalId?: string
  deliveryState?: 'sending' | 'failed'
  pendingAttachmentDrafts?: PendingMessageAttachmentDraft[]
  optimisticCreatedAt?: number
}

export interface MessageTimelineDateDividerRow {
  kind: 'date-divider'
  key: string
  label: string
}

export interface MessageTimelineUnreadSeparatorRow {
  kind: 'unread-separator'
  key: string
}

export interface MessageTimelineConversationStartRow {
  kind: 'conversation-start'
  key: string
}

export interface MessageTimelineGapRow {
  kind: 'gap'
  key: string
  direction: MessageTimelineGapDirection
  gapKind: MessageTimelineGapKind
  status: MessageTimelineGapStatus
  approxMissingCount?: number
  heightPx: number
}

export type MessageTimelineRow =
  | MessageTimelineMessageRow
  | MessageTimelineDateDividerRow
  | MessageTimelineUnreadSeparatorRow
  | MessageTimelineConversationStartRow
  | MessageTimelineGapRow

export function createJumpRequest(
  messageId: string,
  options?: {
    behavior?: JumpBehavior
    positionHint?: number | null
  },
): JumpRequest {
  return {
    messageId,
    requestKey: `${messageId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
    behavior: options?.behavior ?? 'direct-scroll',
    positionHint: options?.positionHint ?? null,
  }
}

export function getMessageRowKey(messageId: string): string {
  return `message:${messageId}`
}
