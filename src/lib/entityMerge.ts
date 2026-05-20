import type { DtoGuild, DtoUser } from '@/types'

export function mergeUserPreservingAssets(current: DtoUser | null | undefined, incoming: DtoUser): DtoUser {
  if (!current) return incoming

  const next: DtoUser = { ...current, ...incoming }
  if (current.avatar?.url && !incoming.avatar?.url) {
    next.avatar = incoming.avatar
      ? { ...incoming.avatar, url: current.avatar.url }
      : current.avatar
  }
  return next
}

export function mergeGuildPreservingAssets(current: DtoGuild | null | undefined, incoming: DtoGuild): DtoGuild {
  if (!current) return incoming

  const next: DtoGuild = { ...current, ...incoming }
  if (current.icon?.url && !incoming.icon?.url) {
    next.icon = incoming.icon
      ? { ...incoming.icon, url: current.icon.url }
      : current.icon
  }
  return next
}

export function mergeGuildListPreservingAssets(
  current: DtoGuild[] | undefined,
  incoming: DtoGuild[],
): DtoGuild[] {
  if (!current?.length) return incoming

  const currentById = new Map(current.map((guild) => [String(guild.id), guild]))
  return incoming.map((guild) => mergeGuildPreservingAssets(currentById.get(String(guild.id)), guild))
}
