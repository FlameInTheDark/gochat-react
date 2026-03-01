// Re-export key API types for convenience
export type {
  DtoUser,
  DtoGuild,
  DtoChannel,
  DtoMessage,
  DtoMember,
  DtoGuildInvite,
  DtoAttachment,
  ModelChannelType,
} from '@/client'

export { ModelChannelType as ChannelType } from '@/client'

export interface ContextMenuItem {
  label: string
  action: () => void
  danger?: boolean
}
