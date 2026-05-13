import { PermissionBits, calculateEffectivePermissions, hasPermission, type PermissionBit } from '@/lib/permissions'
import type { DtoChannel, DtoGuild, DtoMember, DtoMessage } from '@/types'
import type { DtoRole, DtoUser } from '@/client'

interface PermissionCheckerInput {
  currentUser?: Pick<DtoUser, 'id'> | null
  guild?: Pick<DtoGuild, 'owner' | 'permissions'> | null
  guildDetail?: Pick<DtoGuild, 'owner' | 'permissions'> | null
  currentMember?: DtoMember | null
  roles?: DtoRole[] | null
}

function idEquals(a: unknown, b: unknown): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b)
}

function roleIdSet(member?: DtoMember | null): Set<string> {
  return new Set((member?.roles ?? []).map(String))
}

export function createPermissionChecker({
  currentUser,
  guild,
  guildDetail,
  currentMember,
  roles = [],
}: PermissionCheckerInput) {
  const ownerId = guild?.owner ?? guildDetail?.owner
  const guildPermissions = guildDetail?.permissions ?? guild?.permissions ?? 0
  const effectivePermissions = currentMember
    ? calculateEffectivePermissions(currentMember, roles ?? [], guildPermissions)
    : guildPermissions
  const isOwner = idEquals(ownerId, currentUser?.id)
  const isAdmin = hasPermission(effectivePermissions, PermissionBits.ADMINISTRATOR)
  const memberRoleIds = roleIdSet(currentMember)

  function has(bit: PermissionBit): boolean {
    return isOwner || isAdmin || hasPermission(effectivePermissions, bit)
  }

  function hasAny(...bits: PermissionBit[]): boolean {
    return isOwner || isAdmin || bits.some((bit) => hasPermission(effectivePermissions, bit))
  }

  function hasAll(...bits: PermissionBit[]): boolean {
    return isOwner || isAdmin || bits.every((bit) => hasPermission(effectivePermissions, bit))
  }

  function canViewChannel(channel?: Pick<DtoChannel, 'private' | 'roles'> | null): boolean {
    if (!channel) return false
    if (isOwner || isAdmin) return true
    if (!channel.private) return true
    return (channel.roles ?? []).some((roleId) => memberRoleIds.has(String(roleId)))
  }

  function canCreateThreads(channel?: Pick<DtoChannel, 'private' | 'roles'> | null): boolean {
    return (channel ? canViewChannel(channel) : true) && has(PermissionBits.CREATE_THREADS)
  }

  function canSendInThreads(channel?: Pick<DtoChannel, 'private' | 'roles'> | null): boolean {
    return (channel ? canViewChannel(channel) : true) && has(PermissionBits.SEND_MESSAGES_IN_THREADS)
  }

  const canManageServer = has(PermissionBits.MANAGE_SERVER)
  const canManageChannels = has(PermissionBits.MANAGE_CHANNELS)
  const canManageRoles = has(PermissionBits.MANAGE_ROLES)
  const canManageMessages = has(PermissionBits.MANAGE_MESSAGES)
  const canManageThreads = has(PermissionBits.MANAGE_THREADS)
  const canCreateInvites = has(PermissionBits.CREATE_INVITES)
  const canKickMembers = has(PermissionBits.KICK_MEMBERS)
  const canBanMembers = has(PermissionBits.BAN_MEMBERS)
  const canCreateExpressions = has(PermissionBits.CREATE_EXPRESSIONS)
  const canManageExpressions = has(PermissionBits.MANAGE_EXPRESSIONS)

  function canManageThread(thread?: Pick<DtoChannel, 'creator_id'> | null): boolean {
    return canManageThreads || idEquals(thread?.creator_id, currentUser?.id)
  }

  function canDeleteMessage(message?: Pick<DtoMessage, 'author'> | null, allowDelete = true): boolean {
    if (!allowDelete || !message) return false
    return idEquals(message.author?.id, currentUser?.id) || canManageMessages
  }

  function canModerateMember(targetMember?: DtoMember | null): boolean {
    if (!targetMember) return false
    const targetUserId = targetMember.user?.id
    if (targetUserId === undefined || targetUserId === null) return false
    if (idEquals(targetUserId, currentUser?.id)) return false
    if (idEquals(targetUserId, ownerId)) return false

    const targetPermissions = calculateEffectivePermissions(targetMember, roles ?? [], guildPermissions)
    const targetIsAdmin = hasPermission(targetPermissions, PermissionBits.ADMINISTRATOR)
    return !targetIsAdmin || isOwner
  }

  function canKickMember(targetMember?: DtoMember | null): boolean {
    return canKickMembers && canModerateMember(targetMember)
  }

  function canBanMember(targetMember?: DtoMember | null): boolean {
    return canBanMembers && canModerateMember(targetMember)
  }

  return {
    effectivePermissions,
    memberRoleIds,
    isOwner,
    isAdmin,
    has,
    hasAny,
    hasAll,
    canManageServer,
    canManageChannels,
    canManageRoles,
    canManageMessages,
    canManageThreads,
    canCreateInvites,
    canKickMembers,
    canBanMembers,
    canCreateExpressions,
    canManageExpressions,
    canViewChannel,
    canCreateThreads,
    canSendInThreads,
    canManageThread,
    canDeleteMessage,
    canModerateMember,
    canKickMember,
    canBanMember,
  }
}

export type PermissionChecker = ReturnType<typeof createPermissionChecker>
