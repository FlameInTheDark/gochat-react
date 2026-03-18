import type { DtoMessage } from '@/types'

interface MessagePreviewOptions {
  emptyText: string
  embedsText: string
  attachmentsText: (count: number) => string
  maxLength?: number
}

export function buildMessagePreviewText(
  message: DtoMessage | null | undefined,
  { emptyText, embedsText, attachmentsText, maxLength }: MessagePreviewOptions,
): string {
  const content = message?.content?.replace(/\s+/g, ' ').trim()
  if (content) {
    if (maxLength != null && maxLength > 0 && content.length > maxLength) {
      return `${content.slice(0, maxLength - 1).trimEnd()}...`
    }
    return content
  }

  const attachmentCount = message?.attachments?.length ?? 0
  if (attachmentCount > 0) {
    return attachmentsText(attachmentCount)
  }

  if ((message?.embeds?.length ?? 0) > 0) {
    return embedsText
  }

  return emptyText
}
