import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { MessageSquare, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useUiStore } from '@/stores/uiStore'
import { useAuthStore } from '@/stores/authStore'
import { guildApi, rolesApi, userApi } from '@/api/client'
import type { DtoMember, DtoGuild } from '@/types'
import type { DtoRole } from '@/client'
import { cn } from '@/lib/utils'
import { PermissionBits, hasPermission, calculateEffectivePermissions } from '@/lib/permissions'
import ProfileCardBody, { userColor, colorToHex, panelTextColors } from './ProfileCardBody'

// ── Helpers ───────────────────────────────────────────────────────────────────

const PANEL_W = 300

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
    let removeHandler: (() => void) | null = null
    const timer = setTimeout(() => {
      if (!alive) return
      const handler = (e: MouseEvent) => {
        if (!panelRef.current?.contains(e.target as Node)) close()
      }
      document.addEventListener('mousedown', handler)
      removeHandler = () => document.removeEventListener('mousedown', handler)
    }, 80)
    return () => {
      alive = false
      clearTimeout(timer)
      removeHandler?.()
    }
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

  // Fetch the single member's fresh profile (bio, colors, roles) when the panel opens
  useQuery<DtoMember>({
    queryKey: ['member', guildId, userId],
    queryFn: async () => {
      const res = await guildApi.guildGuildIdMemberUserIdGet({
        guildId: guildId!,
        userId: userId as unknown as number,
      })
      // Upsert into the members list cache so the rest of the component reads fresh data
      queryClient.setQueryData<DtoMember[]>(['members', guildId], (old = []) => {
        const idx = old.findIndex((m) => String(m.user?.id) === userId)
        if (idx >= 0) {
          const updated = [...old]
          updated[idx] = res.data
          return updated
        }
        return [...old, res.data]
      })
      return res.data
    },
    enabled: !!guildId && !!userId && !!profile,
    staleTime: 0,
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
  // 0 means "not set" (Go zero value) — treat as null so fallback accent/popover colors are used
  const rawPanelColor = member?.user?.panel_color ? colorToHex(member.user.panel_color) : null
  const rawBannerColor = member?.user?.banner_color ? colorToHex(member.user.banner_color) : null
  const { textColor, mutedColor } = panelTextColors(rawPanelColor)

  return (
    <div
      ref={panelRef}
      className={cn(
        'fixed z-[60] rounded-lg border border-border shadow-2xl overflow-hidden flex flex-col',
        !rawPanelColor && 'bg-popover',
      )}
      style={{ left: panelX, top: panelY, width: PANEL_W, ...(rawPanelColor ? { backgroundColor: rawPanelColor } : {}) }}
    >
      <ProfileCardBody
        userId={userId}
        displayName={displayName}
        globalName={globalName}
        discriminator={discriminator}
        avatarUrl={member?.user?.avatar?.url}
        bio={member?.user?.bio}
        panelColor={rawPanelColor}
        bannerColor={rawBannerColor}
        accent={accent}
      >
        {/* Member since */}
        {joinDate && (
          <div>
            <p
              className={cn('text-[10px] font-semibold uppercase tracking-wider mb-0.5', !mutedColor && 'text-muted-foreground')}
              style={{ color: mutedColor }}
            >
              {t('userProfile.memberSince')}
            </p>
            <p className="text-sm" style={{ color: textColor }}>{joinDate}</p>
          </div>
        )}

        {/* Roles */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p
              className={cn('text-[10px] font-semibold uppercase tracking-wider', !mutedColor && 'text-muted-foreground')}
              style={{ color: mutedColor }}
            >
              {assignedRoles.length > 0 ? t('userProfile.rolesWithCount', { count: assignedRoles.length }) : t('userProfile.roles')}
            </p>
            {canManageRoles && guildId && (
              <button
                onClick={() => setEditingRoles((v) => !v)}
                className={cn('text-[10px] transition-colors', !mutedColor && 'text-muted-foreground hover:text-foreground')}
                style={{ color: mutedColor }}
              >
                {editingRoles ? t('common.done') : t('common.edit')}
              </button>
            )}
          </div>

          {!editingRoles ? (
            <div className="flex flex-wrap gap-1 min-h-[22px]">
              {assignedRoles.map((role) => {
                const hex = colorToHex(role.color ?? 0)
                return (
                  <span
                    key={String(role.id)}
                    className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded font-medium leading-none"
                    style={{ backgroundColor: hex + '22', color: hex, border: `1px solid ${hex}55` }}
                  >
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: hex }} />
                    {role.name}
                  </span>
                )
              })}
              {assignedRoles.length === 0 && (
                <p className="text-xs text-muted-foreground italic">{t('userProfile.noRoles')}</p>
              )}
            </div>
          ) : (
            <div className="max-h-52 overflow-y-auto rounded-md border border-border">
              {allRoles.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-3">{t('userProfile.noServerRoles')}</p>
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
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: hex }} />
                    <span className="flex-1 truncate">{role.name}</span>
                    <span
                      className={cn(
                        'w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors',
                        currentlyHas ? 'bg-primary border-primary' : 'border-border',
                      )}
                    >
                      {currentlyHas && (
                        <svg className="w-3 h-3 text-primary-foreground" viewBox="0 0 12 12" fill="none">
                          <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
            <Button size="sm" variant="secondary" className="w-full gap-2" onClick={() => void handleSendFriendRequest()}>
              <UserPlus className="w-4 h-4" />
              {t('userProfile.addFriend')}
            </Button>
          )}
          <Button size="sm" variant="secondary" className="w-full gap-2" onClick={() => void handleMessage()}>
            <MessageSquare className="w-4 h-4" />
            {t('userProfile.sendMessage')}
          </Button>
        </div>
      </ProfileCardBody>
    </div>
  )
}
