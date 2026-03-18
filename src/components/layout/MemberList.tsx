import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, Copy, Shield, User } from 'lucide-react'
import { toast } from 'sonner'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import StatusDot from '@/components/ui/StatusDot'
import { guildApi, rolesApi, userApi } from '@/api/client'
import { usePresenceStore, type UserStatus } from '@/stores/presenceStore'
import { useUiStore } from '@/stores/uiStore'
import { useAuthStore } from '@/stores/authStore'
import { addPresenceSubscription } from '@/services/wsService'
import { cn } from '@/lib/utils'
import { PermissionBits, hasPermission, calculateEffectivePermissions } from '@/lib/permissions'
import { getTopRoleColor } from '@/lib/memberColors'
import type { DtoMember, DtoGuild, DtoChannel } from '@/types'
import type { DtoRole } from '@/client'

interface Props {
  serverId: string
  channel?: DtoChannel
}

export default function MemberList({ serverId, channel }: Props) {
  const { data: members = [] } = useQuery({
    queryKey: ['members', serverId],
    queryFn: () =>
      guildApi.guildGuildIdMembersGet({ guildId: serverId }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: 30_000,
  })

  const queryClient = useQueryClient()
  const guild = queryClient.getQueryData<DtoGuild[]>(['guilds'])?.find((g) => String(g.id) === serverId)
  const ownerIdStr = guild?.owner != null ? String(guild.owner) : null

  const visibleMembers = useMemo(() => {
    if (!channel?.private) return members
    const channelRoleIds = new Set((channel.roles ?? []).map(String))
    return members.filter((m) => {
      const userId = String(m.user?.id ?? '')
      if (ownerIdStr && userId === ownerIdStr) return true
      return (m.roles ?? []).map(String).some((r) => channelRoleIds.has(r))
    })
  }, [members, channel, ownerIdStr])

  const statuses = usePresenceStore((s) => s.statuses)

  useEffect(() => {
    const ids = visibleMembers
      .filter((m) => m.user?.id !== undefined)
      .map((m) => String(m.user!.id))
    if (ids.length > 0) addPresenceSubscription(ids)
  }, [visibleMembers])

  const { online, offline } = useMemo(() => {
    const online: DtoMember[] = []
    const offline: DtoMember[] = []
    for (const m of visibleMembers) {
      const userId = String(m.user?.id ?? '')
      const s = (statuses[userId] ?? 'offline') as UserStatus
      if (s === 'offline') offline.push(m)
      else online.push(m)
    }
    return { online, offline }
  }, [visibleMembers, statuses])

  const { t } = useTranslation()

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-sidebar">
      <ScrollArea className="flex-1">
        <div className="px-2 py-3 space-y-4">
          {online.length > 0 && (
            <MemberGroup label={t('memberList.online')} count={online.length}>
              {online.map((m) => (
                <MemberRow key={String(m.user?.id ?? m.username)} member={m} serverId={serverId} />
              ))}
            </MemberGroup>
          )}
          {offline.length > 0 && (
            <MemberGroup label={t('memberList.offline')} count={offline.length}>
              {offline.map((m) => (
                <MemberRow key={String(m.user?.id ?? m.username)} member={m} serverId={serverId} />
              ))}
            </MemberGroup>
          )}
          {members.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">{t('memberList.loading')}</p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function MemberGroup({ label, count, children }: {
  label: string; count: number; children: React.ReactNode
}) {
  return (
    <section>
      <p className="px-2 mb-1 text-xs font-semibold uppercase text-muted-foreground tracking-wider">
        {label} — {count}
      </p>
      <div className="space-y-0.5">{children}</div>
    </section>
  )
}

function MemberRow({ member, serverId }: { member: DtoMember; serverId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const openUserProfile = useUiStore((s) => s.openUserProfile)

  const userId = String(member.user?.id ?? '')
  const status = usePresenceStore(
    (s) => (userId ? ((s.statuses[userId] ?? 'offline') as UserStatus) : 'offline'),
  )
  const customStatus = usePresenceStore((s) => (userId ? (s.customStatuses[userId] ?? '') : ''))
  const displayName = member.username ?? member.user?.name ?? 'Unknown'
  const initials = displayName.charAt(0).toUpperCase()

  const [savingRoleId, setSavingRoleId] = useState<string | null>(null)

  // Fetch all guild roles for the sub-menu (shared cache across all rows)
  const { data: allRoles = [] } = useQuery<DtoRole[]>({
    queryKey: ['roles', serverId],
    queryFn: () => rolesApi.guildGuildIdRolesGet({ guildId: serverId }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: 60_000,
  })

  // Current user permissions check for role management
  const currentUser = useAuthStore((s) => s.user)
  const { data: members } = useQuery({
    queryKey: ['members', serverId],
    queryFn: () => guildApi.guildGuildIdMembersGet({ guildId: serverId }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: 30_000,
  })

  // Resolve guild data for owner check
  const guild = queryClient.getQueryData<DtoGuild[]>(['guilds'])?.find((g) => String(g.id) === serverId)
  const isOwner = guild?.owner != null && currentUser?.id !== undefined && String(guild.owner) === String(currentUser.id)

  const currentMember = members?.find((m) => m.user?.id === currentUser?.id)
  const effectivePermissions = currentMember && allRoles
    ? calculateEffectivePermissions(currentMember as DtoMember, allRoles)
    : 0
  const isAdmin = hasPermission(effectivePermissions, PermissionBits.ADMINISTRATOR)
  const canManageRoles = isOwner || isAdmin || hasPermission(effectivePermissions, PermissionBits.MANAGE_ROLES)

  // Member's current role IDs as a Set for O(1) lookup
  const memberRoleIds = new Set((member.roles ?? []).map(String))

  // Pick top role color: lowest position wins, skip zero-color roles
  const topRoleColor = useMemo(() => {
    return getTopRoleColor(memberRoleIds, allRoles)
  }, [allRoles, memberRoleIds])

  // Track last cursor position so context-menu "View Profile" can position the panel correctly
  const lastPosRef = useRef({ x: 0, y: 0 })

  function handleRowClick(e: React.MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    openUserProfile(userId, serverId, rect.left, rect.top, displayName)
  }

  async function handleMessage() {
    if (!member.user?.id) return
    try {
      const res = await userApi.userMeFriendsUserIdGet({ userId: String(member.user.id) })
      await queryClient.invalidateQueries({ queryKey: ['dm-channels'] })
      if (res.data.id !== undefined) navigate(`/app/@me/${String(res.data.id)}`)
    } catch {
      toast.error(t('memberList.dmFailed'))
    }
  }

  async function toggleRole(roleId: string, currentlyHas: boolean) {
    if (!userId) return
    setSavingRoleId(roleId)
    try {
      if (currentlyHas) {
        await rolesApi.guildGuildIdMemberUserIdRolesRoleIdDelete({ guildId: serverId, userId, roleId })
      } else {
        await rolesApi.guildGuildIdMemberUserIdRolesRoleIdPut({ guildId: serverId, userId, roleId })
      }
      // Optimistically update the members cache so checkboxes reflect the change immediately
      queryClient.setQueryData<DtoMember[]>(['members', serverId], (old = []) =>
        old.map((m) => {
          if (String(m.user?.id) !== userId) return m
          const prev = (m.roles ?? []).map(String)
          const next = currentlyHas
            ? prev.filter((id) => id !== roleId)
            : [...prev, roleId]
          return { ...m, roles: next.map(Number) }
        }),
      )
      toast.success(currentlyHas ? t('memberList.roleRemoved') : t('memberList.roleAssigned'))
    } catch {
      toast.error(currentlyHas ? t('memberList.roleRemoveFailed') : t('memberList.roleAssignFailed'))
    } finally {
      setSavingRoleId(null)
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onMouseMove={(e) => { lastPosRef.current = { x: e.clientX, y: e.clientY } }}
          onClick={handleRowClick}
          className={cn(
            'w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors text-left',
            status === 'offline'
              ? 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-accent/50'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
          )}
        >
          <div className="relative shrink-0">
            <Avatar className="w-8 h-8">
              <AvatarImage src={member.user?.avatar?.url} alt={displayName} className="object-cover" />
              <AvatarFallback className={cn('text-xs', status === 'offline' && 'opacity-50')}>
                {initials}
              </AvatarFallback>
            </Avatar>
            <StatusDot status={status} className="absolute -bottom-0.5 -right-0.5 w-3 h-3" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="truncate text-sm font-medium leading-tight" style={topRoleColor ? { color: topRoleColor } : undefined}>{displayName}</p>
            {customStatus && (
              <p className="truncate text-[10px] text-muted-foreground/70 leading-tight italic">
                {customStatus}
              </p>
            )}
          </div>
        </button>
      </ContextMenuTrigger>

      <ContextMenuContent>
        {/* View Profile */}
        <ContextMenuItem
          onClick={() => openUserProfile(
            userId, serverId,
            lastPosRef.current.x, lastPosRef.current.y,
            displayName,
          )}
          className="gap-2"
        >
          <User className="w-4 h-4" />
          {t('memberList.viewProfile')}
        </ContextMenuItem>

        {/* Roles sub-menu - only show for users with Manage Roles permission, Admin, or Owner */}
        {canManageRoles && allRoles.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger className="gap-2">
              <Shield className="w-4 h-4" />
              {t('memberList.roles')}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-[180px] max-h-72 overflow-y-auto">
              {allRoles.map((role) => {
                const rid = String(role.id)
                const currentlyHas = memberRoleIds.has(rid)
                const isSaving = savingRoleId === rid
                const colorHex = role.color
                  ? `#${Math.max(0, role.color).toString(16).padStart(6, '0')}`
                  : undefined
                return (
                  <ContextMenuCheckboxItem
                    key={rid}
                    checked={currentlyHas}
                    disabled={isSaving}
                    onSelect={(e) => {
                      e.preventDefault() // keep sub-menu open
                      void toggleRole(rid, currentlyHas)
                    }}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0 bg-muted-foreground/50"
                      style={colorHex ? { backgroundColor: colorHex } : undefined}
                    />
                    {role.name}
                  </ContextMenuCheckboxItem>
                )
              })}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}

        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void handleMessage()} className="gap-2">
          <MessageSquare className="w-4 h-4" />
          {t('memberList.message')}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => { void navigator.clipboard.writeText(userId) }}
          className="gap-2"
        >
          <Copy className="w-4 h-4" />
          {t('memberList.copyUserId')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
