import type { DtoRole } from '@/client'

export function getTopRoleColor(
  roleIds: Iterable<string | number> | null | undefined,
  roles: DtoRole[] | null | undefined,
): string | undefined {
  if (!roleIds || !roles?.length) return undefined

  const roleIdSet = new Set(Array.from(roleIds, (roleId) => String(roleId)))
  const topRole = roles
    .filter((role) => roleIdSet.has(String(role.id)) && (role.color ?? 0) !== 0)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]

  if (!topRole) return undefined
  return `#${(topRole.color ?? 0).toString(16).padStart(6, '0')}`
}
