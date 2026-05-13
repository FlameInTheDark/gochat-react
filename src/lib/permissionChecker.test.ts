import { describe, expect, it } from 'vitest'
import { createPermissionChecker } from './permissionChecker'
import { PermissionBits } from './permissions'
import type { DtoChannel, DtoGuild, DtoMember, DtoMessage } from '@/types'
import type { DtoRole, DtoUser } from '@/client'

const user = (id: number): DtoUser => ({ id, name: `user-${id}` })
const guild = (owner: number, permissions = 0): DtoGuild => ({ id: 1, owner, permissions, name: 'Guild' })
const member = (userId: number, roles: number[] = []): DtoMember => ({ user: user(userId), roles })
const role = (id: number, permissions: number): DtoRole => ({ id, permissions, name: `role-${id}` })
const bit = (permission: number) => 1 << permission

describe('createPermissionChecker', () => {
  it('lets the owner perform semantic management actions', () => {
    const checker = createPermissionChecker({
      currentUser: user(1),
      guild: guild(1),
      currentMember: member(1),
      roles: [],
    })

    expect(checker.isOwner).toBe(true)
    expect(checker.canManageServer).toBe(true)
    expect(checker.canManageChannels).toBe(true)
    expect(checker.canManageRoles).toBe(true)
    expect(checker.canManageMessages).toBe(true)
    expect(checker.canManageThreads).toBe(true)
  })

  it('lets administrators pass all permission checks', () => {
    const checker = createPermissionChecker({
      currentUser: user(2),
      guild: guild(1),
      currentMember: member(2, [10]),
      roles: [role(10, bit(PermissionBits.ADMINISTRATOR))],
    })

    expect(checker.isAdmin).toBe(true)
    expect(checker.has(PermissionBits.MANAGE_MESSAGES)).toBe(true)
    expect(checker.canManageChannels).toBe(true)
  })

  it('grants capabilities from role permissions', () => {
    const checker = createPermissionChecker({
      currentUser: user(2),
      guild: guild(1),
      currentMember: member(2, [10]),
      roles: [role(10, bit(PermissionBits.MANAGE_ROLES))],
    })

    expect(checker.canManageRoles).toBe(true)
    expect(checker.canManageMessages).toBe(false)
  })

  it('includes guild baseline permissions', () => {
    const checker = createPermissionChecker({
      currentUser: user(2),
      guildDetail: guild(1, bit(PermissionBits.CREATE_INVITES)),
      currentMember: member(2),
      roles: [],
    })

    expect(checker.canCreateInvites).toBe(true)
  })

  it('checks private channel visibility by member role', () => {
    const channel: DtoChannel = { id: 5, private: true, roles: [7] }
    const checker = createPermissionChecker({
      currentUser: user(2),
      guild: guild(1),
      currentMember: member(2, [7]),
      roles: [],
    })

    expect(checker.canViewChannel(channel)).toBe(true)
    expect(checker.canViewChannel({ ...channel, roles: [8] })).toBe(false)
  })

  it('lets thread creator or manage-threads users manage a thread', () => {
    const creatorChecker = createPermissionChecker({
      currentUser: user(2),
      guild: guild(1),
      currentMember: member(2),
      roles: [],
    })
    const managerChecker = createPermissionChecker({
      currentUser: user(3),
      guild: guild(1),
      currentMember: member(3, [10]),
      roles: [role(10, bit(PermissionBits.MANAGE_THREADS))],
    })

    expect(creatorChecker.canManageThread({ creator_id: 2 })).toBe(true)
    expect(managerChecker.canManageThread({ creator_id: 2 })).toBe(true)
  })

  it('lets message author or manage-messages users delete messages', () => {
    const message: DtoMessage = { id: 1, author: user(2) }
    const authorChecker = createPermissionChecker({
      currentUser: user(2),
      guild: guild(1),
      currentMember: member(2),
      roles: [],
    })
    const managerChecker = createPermissionChecker({
      currentUser: user(3),
      guild: guild(1),
      currentMember: member(3, [10]),
      roles: [role(10, bit(PermissionBits.MANAGE_MESSAGES))],
    })

    expect(authorChecker.canDeleteMessage(message)).toBe(true)
    expect(managerChecker.canDeleteMessage(message)).toBe(true)
    expect(managerChecker.canDeleteMessage(message, false)).toBe(false)
  })

  it('lets kick/ban members moderate ordinary members but not owners, admins, or self', () => {
    const moderatorChecker = createPermissionChecker({
      currentUser: user(2),
      guild: guild(1),
      currentMember: member(2, [10]),
      roles: [
        role(10, bit(PermissionBits.KICK_MEMBERS) | bit(PermissionBits.BAN_MEMBERS)),
        role(20, bit(PermissionBits.ADMINISTRATOR)),
      ],
    })

    expect(moderatorChecker.canKickMember(member(3))).toBe(true)
    expect(moderatorChecker.canBanMember(member(3))).toBe(true)
    expect(moderatorChecker.canKickMember(member(1))).toBe(false)
    expect(moderatorChecker.canBanMember(member(2))).toBe(false)
    expect(moderatorChecker.canBanMember(member(4, [20]))).toBe(false)
  })

  it('lets the owner moderate administrators', () => {
    const ownerChecker = createPermissionChecker({
      currentUser: user(1),
      guild: guild(1),
      currentMember: member(1),
      roles: [role(20, bit(PermissionBits.ADMINISTRATOR))],
    })

    expect(ownerChecker.canKickMember(member(4, [20]))).toBe(true)
    expect(ownerChecker.canBanMember(member(4, [20]))).toBe(true)
  })
})
