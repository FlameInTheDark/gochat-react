import type { MessageTimelineMessageRow, MessageTimelineRow } from '@/lib/messageJump'

function estimateMessageRowHeight(row: MessageTimelineMessageRow, chatSpacing: number): number {
  let height = row.grouped ? 30 : 76
  const contentLength = row.message.content?.length ?? 0
  const attachmentCount = (row.message.attachments?.length ?? 0) + (row.pendingAttachmentDrafts?.length ?? 0)
  const embedCount = row.message.embeds?.length ?? 0
  const isInformationalMessage = row.message.type === 2 || row.message.type === 3 || row.message.type === 4

  if (contentLength > 120) {
    height += 24
  }
  if (contentLength > 420) {
    height += 40
  }
  if (attachmentCount > 0) {
    height += 180
  }
  if (embedCount > 0) {
    height += 140
  }
  if (isInformationalMessage) {
    height = Math.max(height, row.grouped ? 38 : 46)
  }

  return height + chatSpacing
}

export function getEstimatedMessageListRowHeight(
  row: MessageTimelineRow,
  options: {
    chatSpacing: number
    minGapHeightPx: number
  },
) {
  switch (row.kind) {
    case 'conversation-start':
      return 196
    case 'date-divider':
      return 36
    case 'unread-separator':
      return 28
    case 'gap':
      return Math.max(row.heightPx, options.minGapHeightPx)
    case 'message':
      return estimateMessageRowHeight(row, options.chatSpacing)
  }
}
