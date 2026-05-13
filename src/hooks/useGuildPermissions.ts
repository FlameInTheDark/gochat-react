import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { guildApi, rolesApi } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'
import { createPermissionChecker } from '@/lib/permissionChecker'
import type { DtoGuild, DtoMember } from '@/types'
import type { DtoRole } from '@/client'

const EMPTY_ROLES: DtoRole[] = []
const EMPTY_MEMBERS: DtoMember[] = []

export function useGuildPermissions(serverId?: string | null) {
  const queryClient = useQueryClient()
  const currentUser = useAuthStore((s) => s.user)
  const enabled = !!serverId
  const guildId = serverId as unknown as number

  const guildFromList = queryClient.getQueryData<DtoGuild[]>(['guilds'])?.find((g) => String(g.id) === String(serverId))

  const { data: guildDetail } = useQuery({
    queryKey: ['guild', serverId],
    queryFn: () => guildApi.guildGuildIdGet({ guildId }).then((r) => r.data),
    enabled,
    staleTime: 30_000,
  })

  const { data: members = EMPTY_MEMBERS } = useQuery<DtoMember[]>({
    queryKey: ['members', serverId],
    queryFn: () => guildApi.guildGuildIdMembersGet({ guildId }).then((r) => r.data ?? []),
    enabled,
    staleTime: 30_000,
  })

  const { data: roles = EMPTY_ROLES } = useQuery<DtoRole[]>({
    queryKey: ['roles', serverId],
    queryFn: () => rolesApi.guildGuildIdRolesGet({ guildId }).then((r) => r.data ?? []),
    enabled,
    staleTime: 60_000,
  })

  const currentMember = useMemo(
    () => members.find((m) => String(m.user?.id) === String(currentUser?.id)),
    [members, currentUser?.id],
  )

  return useMemo(
    () => createPermissionChecker({
      currentUser,
      guild: guildFromList,
      guildDetail,
      currentMember,
      roles,
    }),
    [currentUser, guildFromList, guildDetail, currentMember, roles],
  )
}
