import { ChannelType, type DtoChannel, type DtoMessage } from '@/types'

export function isThreadChannel(
  channel: Pick<DtoChannel, 'type'> | null | undefined,
): channel is DtoChannel {
  return channel?.type === ChannelType.ChannelTypeThread
}

export function sortThreadsByActivity(threads: DtoChannel[]): DtoChannel[] {
  return [...threads].sort((a, b) => {
    const aLast = a.last_message_id != null ? BigInt(String(a.last_message_id)) : 0n
    const bLast = b.last_message_id != null ? BigInt(String(b.last_message_id)) : 0n
    if (aLast !== bLast) return aLast > bLast ? -1 : 1

    const aCreated = a.created_at ? Date.parse(a.created_at) : 0
    const bCreated = b.created_at ? Date.parse(b.created_at) : 0
    return bCreated - aCreated
  })
}

export function isAutoThreadFollowup(message: DtoMessage): boolean {
  return (
    message.type === 3 ||
    (
      message.thread_id != null &&
      message.reference != null &&
      (message.content?.trim() ?? '') === String(message.thread_id)
    )
  )
}
