import type { DtoRole } from '@/client'

export function roleColorHex(color: number | null | undefined): string | undefined {
  if (!color) return undefined
  return `#${Math.max(0, color).toString(16).padStart(6, '0')}`
}

export function roleIsHoisted(role: DtoRole): boolean {
  return role.hoist === true
}

export function sortRolesForDisplay(roles: DtoRole[]): DtoRole[] {
  return [...roles].sort((a, b) => {
    const byPosition = (a.position ?? 0) - (b.position ?? 0)
    if (byPosition !== 0) return byPosition
    return String(a.id ?? '').localeCompare(String(b.id ?? ''))
  })
}
