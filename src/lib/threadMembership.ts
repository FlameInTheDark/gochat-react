import type { DtoThreadMember } from '@/client'
import type { DtoChannel } from '@/types'

export function addThreadMember(thread: DtoChannel, userId: string, member?: DtoThreadMember): DtoChannel {
  const existingIds = (thread.member_ids ?? []).map(String)
  const memberIds = existingIds.includes(userId) ? existingIds : [...existingIds, userId]
  return {
    ...thread,
    member: member ?? thread.member,
    member_ids: memberIds.map(Number),
  }
}

export function removeThreadMember(thread: DtoChannel, userId: string): DtoChannel {
  return {
    ...thread,
    member: undefined,
    member_ids: (thread.member_ids ?? [])
      .map(String)
      .filter((id) => id !== userId)
      .map(Number),
  }
}
