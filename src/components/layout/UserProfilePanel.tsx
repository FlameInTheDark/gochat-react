import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { MessageSquare, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useUiStore } from '@/stores/uiStore'
import { useAuthStore } from '@/stores/authStore'
import { rolesApi, userApi } from '@/api/client'
import type { DtoMember, DtoGuild } from '@/types'
import type { DtoRole } from '@/client'
import { cn } from '@/lib/utils'
import { PermissionBits, hasPermission, calculateEffectivePermissions } from '@/lib/permissions'

// ── Helpers ───────────────────────────────────────────────────────────────────

const PANEL_W = 300

const AVATAR_PALETTE = [
  '#5865f2', '#57f287', '#fee75c', '#eb459e',
  '#ed4245', '#3ba55c', '#faa61a', '#00b0f4',
]

function userColor(userId: string): string {
  let h = 0
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) & 0x7fffffff
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]
}

const colorToHex = (color: number) =>
  `#${Math.max(0, color ?? 0).toString(16).padStart(6, '0')}`

// ── Component ─────────────────────────────────────────────────────────────────

export default function UserProfilePanel() {
  const profile = useUiStore((s) => s.userProfile)
  const close = useUiStore((s) => s.closeUserProfile)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const panelRef = useRef<HTMLDivElement>(null)
  const { t } = useTranslation()

  const [editingRoles, setEditingRoles] = useState(false)
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null)

  // Derive stable primitives BEFORE any early return so hooks order is invariant
  const userId = profile?.userId ?? ''
  const guildId = profile?.guildId ?? null

  // Reset role editor whenever the panel target changes
  useEffect(() => { setEditingRoles(false) }, [profile?.userId, profile?.guildId])

  // Close on outside click (delay to avoid closing on the same click that opened)
  useEffect(() => {
    if (!profile) return
    let alive = true
    const timer = setTimeout(() => {
      if (!alive) return
      const handler = (e: MouseEvent) => {
        if (!panelRef.current?.contains(e.target as Node)) close()
      }
      document.addEventListener('mousedown', handler)
      return () => document.removeEventListener('mousedown', handler)
    }, 80)
    return () => { alive = false; clearTimeout(timer) }
  }, [profile, close])

  // Escape to close
  useEffect(() => {
    if (!profile) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [profile, close])

  // ── Hooks — MUST be before any early return (Rules of Hooks) ───────────────

  // Get current user for permission check
  const currentUser = useAuthStore((s) => s.user)

  const { data: allRoles = [] } = useQuery<DtoRole[]>({
    queryKey: ['roles', guildId],
    queryFn: () => rolesApi.guildGuildIdRolesGet({ guildId: guildId! }).then((r) => r.data ?? []),
    enabled: !!guildId && !!profile,
    staleTime: 60_000,
  })

  const { data: fetchedRoles = [] } = useQuery<DtoRole[]>({
    queryKey: ['member-roles', guildId, userId],
    queryFn: () =>
      rolesApi.guildGuildIdMemberUserIdRolesGet({ guildId: guildId!, userId })
        .then((r) => r.data ?? []),
    enabled: !!guildId && !!userId && editingRoles && !!profile,
    staleTime: 15_000,
  })

  // Get friends list to check if user is already a friend
  const { data: friends = [] } = useQuery({
    queryKey: ['friends'],
    queryFn: () => userApi.userMeFriendsGet().then((r) => r.data ?? []),
    staleTime: 30_000,
  })

  // ── Early return — after ALL hooks ────────────────────────────────────────

  if (!profile) return null

  const { x, y, fallbackName } = profile

  // ── Positioning ───────────────────────────────────────────────────────────

  const panelX = x > window.innerWidth / 2 ? x - PANEL_W - 12 : x + 12
  const panelY = Math.max(8, Math.min(y, window.innerHeight - 540))

  // ── Data from query cache ─────────────────────────────────────────────────

  const members = queryClient.getQueryData<DtoMember[]>(['members', guildId]) ?? []
  const member = members.find((m) => String(m.user?.id) === userId)

  // ── Permission check for role editing ─────────────────────────────────────
  // Resolve guild data for owner check
  const guild = queryClient.getQueryData<DtoGuild[]>(['guilds'])?.find((g) => String(g.id) === guildId)
  const isOwner = guild?.owner != null && currentUser?.id !== undefined && String(guild.owner) === String(currentUser.id)

  const currentMember = members.find((m) => m.user?.id === currentUser?.id)
  const effectivePermissions = currentMember && allRoles.length > 0
    ? calculateEffectivePermissions(currentMember as DtoMember, allRoles)
    : 0
  const isAdmin = hasPermission(effectivePermissions, PermissionBits.ADMINISTRATOR)
  const canManageRoles = isOwner || isAdmin || hasPermission(effectivePermissions, PermissionBits.MANAGE_ROLES)

  const displayName = member?.username ?? member?.user?.name ?? fallbackName ?? t('common.unknown')
  const globalName = member?.user?.name
  const discriminator = member?.user?.discriminator
  const joinDate = member?.join_at
    ? new Date(member.join_at).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
    })
    : null

  // Member's current role IDs (from member cache; typed as number[] but string at runtime)
  const memberRoleIds = new Set((member?.roles ?? []).map((id) => String(id)))
  const assignedRoles = allRoles.filter((r) => memberRoleIds.has(String(r.id)))

  const editingRoleIds = new Set(fetchedRoles.map((r) => String(r.id)))
  const activeRoleIds = editingRoles ? editingRoleIds : memberRoleIds

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleMessage() {
    try {
      const res = await userApi.userMeFriendsUserIdGet({ userId })
      const channel = res.data
      await queryClient.invalidateQueries({ queryKey: ['dm-channels'] })
      if (channel.id !== undefined) {
        navigate(`/app/@me/${String(channel.id)}`)
        close()
      }
    } catch {
      toast.error(t('memberList.dmFailed'))
    }
  }

  const isSelf = currentUser?.id !== undefined && String(currentUser.id) === userId
  const isFriend = friends.some((f) => String(f.id) === userId)
  const memberDiscriminator = member?.user?.discriminator

  async function handleSendFriendRequest() {
    if (!memberDiscriminator) return
    try {
      await userApi.userMeFriendsPost({ request: { discriminator: memberDiscriminator } })
      await queryClient.invalidateQueries({ queryKey: ['friends'] })
      toast.success(t('friends.requestSent'))
    } catch {
      toast.error(t('friends.requestFailed'))
    }
  }

  async function toggleRole(roleId: string, currentlyHas: boolean) {
    if (!guildId) return
    setSavingRoleId(roleId)
    try {
      if (currentlyHas) {
        await rolesApi.guildGuildIdMemberUserIdRolesRoleIdDelete({ guildId, userId, roleId })
      } else {
        await rolesApi.guildGuildIdMemberUserIdRolesRoleIdPut({ guildId, userId, roleId })
      }
      // Optimistically update member cache
      queryClient.setQueryData<DtoMember[]>(['members', guildId], (old = []) =>
        old.map((m) => {
          if (String(m.user?.id) !== userId) return m
          const prev = (m.roles ?? []).map(String)
          const next = currentlyHas
            ? prev.filter((id) => id !== roleId)
            : [...prev, roleId]
          return { ...m, roles: next.map(Number) }
        }),
      )
      await queryClient.invalidateQueries({ queryKey: ['member-roles', guildId, userId] })
      toast.success(currentlyHas ? t('memberList.roleRemoved') : t('memberList.roleAssigned'))
    } catch {
      toast.error(currentlyHas ? t('memberList.roleRemoveFailed') : t('memberList.roleAssignFailed'))
    } finally {
      setSavingRoleId(null)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const accent = userColor(userId)

  return (
    <div
      ref={panelRef}
      className="fixed z-[60] rounded-lg border border-border bg-popover shadow-2xl overflow-hidden flex flex-col"
      style={{ left: panelX, top: panelY, width: PANEL_W }}
    >
      {/* Colored banner */}
      <div className="h-14 shrink-0" style={{ backgroundColor: accent + '44' }} />

      {/* Avatar overlaps banner */}
      <div className="-mt-8 px-4 pb-0">
        {member?.user?.avatar?.url ? (
          <img
            src={member.user.avatar.url}
            alt={displayName}
            className="w-16 h-16 rounded-full border-[3px] border-popover object-cover"
          />
        ) : (
          <div
            className="w-16 h-16 rounded-full border-[3px] border-popover flex items-center justify-center text-2xl font-bold text-white select-none"
            style={{ backgroundColor: accent }}
          >
            {displayName.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      <div className="px-4 pb-4 pt-2 space-y-4">

        {/* Name block */}
        <div>
          <p className="font-bold text-base leading-snug">{displayName}</p>
          {globalName && member?.username && globalName !== member.username && (
            <p className="text-xs text-muted-foreground">{globalName}</p>
          )}
          {discriminator && (
            <p className="text-xs text-muted-foreground">#{discriminator}</p>
          )}
        </div>

        {/* Member since */}
        {joinDate && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">
              {t('userProfile.memberSince')}
            </p>
            <p className="text-sm">{joinDate}</p>
          </div>
        )}

        {/* Roles */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {assignedRoles.length > 0 ? t('userProfile.rolesWithCount', { count: assignedRoles.length }) : t('userProfile.roles')}
            </p>
            {canManageRoles && guildId && (
              <button
                onClick={() => setEditingRoles((v) => !v)}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {editingRoles ? t('common.done') : t('common.edit')}
              </button>
            )}
          </div>

          {!editingRoles ? (
            /* Display mode: colored role badges */
            <div className="flex flex-wrap gap-1 min-h-[22px]">
              {assignedRoles.map((role) => {
                const hex = colorToHex(role.color ?? 0)
                return (
                  <span
                    key={String(role.id)}
                    className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded font-medium leading-none"
                    style={{
                      backgroundColor: hex + '22',
                      color: hex,
                      border: `1px solid ${hex}55`,
                    }}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: hex }}
                    />
                    {role.name}
                  </span>
                )
              })}
              {assignedRoles.length === 0 && (
                <p className="text-xs text-muted-foreground italic">{t('userProfile.noRoles')}</p>
              )}
            </div>
          ) : (
            /* Edit mode: toggleable checklist of all guild roles */
            <div className="max-h-52 overflow-y-auto rounded-md border border-border">
              {allRoles.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-3">
                  {t('userProfile.noServerRoles')}
                </p>
              )}
              {allRoles.map((role) => {
                const rid = String(role.id)
                const currentlyHas = activeRoleIds.has(rid)
                const isSaving = savingRoleId === rid
                const hex = colorToHex(role.color ?? 0)
                return (
                  <button
                    key={rid}
                    onClick={() => void toggleRole(rid, currentlyHas)}
                    disabled={isSaving}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors',
                      isSaving ? 'opacity-50 cursor-wait' : 'hover:bg-accent/60',
                    )}
                  >
                    {/* Role color dot */}
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: hex }}
                    />
                    <span className="flex-1 truncate">{role.name}</span>
                    {/* Checkbox */}
                    <span
                      className={cn(
                        'w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors',
                        currentlyHas ? 'bg-primary border-primary' : 'border-border',
                      )}
                    >
                      {currentlyHas && (
                        <svg className="w-3 h-3 text-primary-foreground" viewBox="0 0 12 12" fill="none">
                          <path
                            d="M2 6l3 3 5-5"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="border-t border-border pt-3 space-y-2">
          {!isSelf && !isFriend && memberDiscriminator && (
            <Button
              size="sm"
              variant="secondary"
              className="w-full gap-2"
              onClick={() => void handleSendFriendRequest()}
            >
              <UserPlus className="w-4 h-4" />
              {t('userProfile.addFriend')}
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            className="w-full gap-2"
            onClick={() => void handleMessage()}
          >
            <MessageSquare className="w-4 h-4" />
            {t('userProfile.sendMessage')}
          </Button>
        </div>

      </div>
    </div>
  )
}
