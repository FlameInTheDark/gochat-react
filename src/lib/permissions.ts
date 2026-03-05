import type { DtoRole, DtoMember } from '@/client'

// Permission bit positions
export const PermissionBits = {
  VIEW_CHANNELS: 0,
  MANAGE_CHANNELS: 1,
  MANAGE_ROLES: 2,
  VIEW_AUDIT_LOG: 3,
  MANAGE_SERVER: 4,
  CREATE_INVITES: 5,
  CHANGE_NICKNAME: 6,
  MANAGE_NICKNAMES: 7,
  KICK_MEMBERS: 8,
  BAN_MEMBERS: 9,
  TIMEOUT_MEMBERS: 10,
  SEND_MESSAGES: 11,
  SEND_MESSAGES_IN_THREADS: 12,
  CREATE_THREADS: 13,
  ATTACH_FILES: 14,
  ADD_REACTIONS: 15,
  MENTION_ROLES: 16,
  MANAGE_MESSAGES: 17,
  MANAGE_THREADS: 18,
  READ_MESSAGE_HISTORY: 19,
  CONNECT: 20,
  SPEAK: 21,
  VIDEO: 22,
  MUTE_MEMBERS: 23,
  DEAFEN_MEMBERS: 24,
  MOVE_MEMBERS: 25,
  ADMINISTRATOR: 26,
} as const

export type PermissionBit = (typeof PermissionBits)[keyof typeof PermissionBits]

/**
 * Check if a permission bit is set in a permissions mask
 */
export function hasPermission(permissions: number, bit: PermissionBit): boolean {
  return (permissions & (1 << bit)) !== 0
}

/**
 * Check if user has administrator privileges
 */
export function isAdministrator(permissions: number): boolean {
  return hasPermission(permissions, PermissionBits.ADMINISTRATOR)
}

/**
 * Calculate effective permissions for a member by combining all their role permissions
 */
export function calculateEffectivePermissions(member: DtoMember, roles: DtoRole[]): number {
  if (!member.roles || member.roles.length === 0) {
    return 0
  }

  return member.roles.reduce((acc, roleId) => {
    const role = roles.find((r) => r.id === roleId)
    return acc | (role?.permissions ?? 0)
  }, 0)
}

/**
 * Get role by ID from a list of roles
 */
export function getRoleById(roles: DtoRole[], roleId: number): DtoRole | undefined {
  return roles.find((r) => r.id === roleId)
}
