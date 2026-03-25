import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, useDragControls } from 'motion/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { MessageSquare, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useUiStore } from '@/stores/uiStore'
import { useAuthStore } from '@/stores/authStore'
import { usePresenceStore, type UserStatus } from '@/stores/presenceStore'
import { guildApi, rolesApi, userApi } from '@/api/client'
import type { DtoMember, DtoGuild } from '@/types'
import type { DtoRole, DtoUser } from '@/client'
import { cn } from '@/lib/utils'
import { PermissionBits, hasPermission, calculateEffectivePermissions } from '@/lib/permissions'
import ProfileCardBody, { userColor, colorToHex, panelTextColors, isDark } from './ProfileCardBody'
import { useClientMode } from '@/hooks/useClientMode'

// ── Helpers ───────────────────────────────────────────────────────────────────

const PANEL_W = 300

// ── Component ─────────────────────────────────────────────────────────────────

export default function UserProfilePanel() {
  const profile = useUiStore((s) => s.userProfile)
  const close = useUiStore((s) => s.closeUserProfile)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const panelRef = useRef<HTMLDivElement>(null)

  // Keep last non-null profile so content stays correct during exit animation
  const lastProfileRef = useRef(profile)
  if (profile) lastProfileRef.current = profile
  const activeProfile = lastProfileRef.current

  const { t } = useTranslation()

  const [editingRoles, setEditingRoles] = useState(false)
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null)
  const [sheetAtTop, setSheetAtTop] = useState(true)
  const sheetScrollRef = useRef<HTMLDivElement>(null)
  const dragControls = useDragControls()

  // Derive stable primitives BEFORE any early return so hooks order is invariant
  const userId = activeProfile?.userId ?? ''
  const guildId = activeProfile?.guildId ?? null

  // Reset role editor whenever the panel target changes
  useEffect(() => { setEditingRoles(false) }, [activeProfile?.userId, activeProfile?.guildId])

  // Close on outside click (desktop only — mobile uses backdrop)
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

  const currentUser = useAuthStore((s) => s.user)
  const userStatus = usePresenceStore(
    (s) => (userId ? ((s.statuses[userId] ?? 'offline') as UserStatus) : 'offline'),
  )

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

  useQuery<DtoMember>({
    queryKey: ['member', guildId, userId],
    queryFn: async () => {
      const res = await guildApi.guildGuildIdMemberUserIdGet({
        guildId: guildId!,
        userId: userId as unknown as number,
      })
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

  const { data: friends = [] } = useQuery({
    queryKey: ['friends'],
    queryFn: () => userApi.userMeFriendsGet().then((r) => r.data ?? []),
    staleTime: 30_000,
  })

  // In DM context (no guildId) there's no member record — fetch the user directly
  const { data: fetchedUser } = useQuery<DtoUser>({
    queryKey: ['user', userId],
    queryFn: () => userApi.userUserIdGet({ userId }).then((r) => r.data),
    enabled: !!userId && !guildId && !!profile,
    staleTime: 60_000,
  })

  const isMobile = useClientMode() === 'mobile'

  // ── Data from query cache ─────────────────────────────────────────────────

  const members = queryClient.getQueryData<DtoMember[]>(['members', guildId]) ?? []
  const member = members.find((m) => String(m.user?.id) === userId)
  // In DM context member is undefined; fall back to the directly-fetched user
  const userData = member?.user ?? fetchedUser

  const guild = queryClient.getQueryData<DtoGuild[]>(['guilds'])?.find((g) => String(g.id) === guildId)
  const isOwner = guild?.owner != null && currentUser?.id !== undefined && String(guild.owner) === String(currentUser.id)

  const currentMember = members.find((m) => m.user?.id === currentUser?.id)
  const effectivePermissions = currentMember && allRoles.length > 0
    ? calculateEffectivePermissions(currentMember as DtoMember, allRoles)
    : 0
  const isAdmin = hasPermission(effectivePermissions, PermissionBits.ADMINISTRATOR)
  const canManageRoles = isOwner || isAdmin || hasPermission(effectivePermissions, PermissionBits.MANAGE_ROLES)

  const displayName = member?.username ?? userData?.name ?? activeProfile?.fallbackName ?? t('common.unknown')
  const globalName = userData?.name
  const discriminator = userData?.discriminator
  const joinDate = member?.join_at
    ? new Date(member.join_at).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
    })
    : null

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
  const memberDiscriminator = userData?.discriminator

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
  const rawPanelColor = activeProfile && userData?.panel_color ? colorToHex(userData.panel_color) : null
  const rawBannerColor = activeProfile && userData?.banner_color ? colorToHex(userData.banner_color) : null
  const { textColor, mutedColor } = panelTextColors(rawPanelColor)

  // ── Shared inner content ───────────────────────────────────────────────────

  function renderContent(mobile = false) {
    if (!activeProfile) return null

    // Semi-transparent block background for mobile grouped sections
    const blockBg = rawPanelColor
      ? (isDark(rawPanelColor) ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)')
      : 'rgba(255,255,255,0.07)'

    const roleChips = (
      <div className="flex flex-wrap gap-1.5">
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
          <p className="text-xs italic" style={{ color: mutedColor ?? undefined }}
            {...(!mutedColor ? { className: 'text-xs text-muted-foreground italic' } : {})}
          >{t('userProfile.noRoles')}</p>
        )}
      </div>
    )

    return (
      <ProfileCardBody
        userId={userId}
        displayName={displayName}
        globalName={globalName}
        discriminator={discriminator}
        avatarUrl={userData?.avatar?.url}
        bio={mobile ? undefined : userData?.bio}
        panelColor={rawPanelColor}
        bannerColor={rawBannerColor}
        accent={accent}
        status={userStatus}
      >
        {mobile ? (
          // ── Mobile: grouped semi-transparent blocks ────────────────────────
          <>
            {/* Block 1: Bio + Member Since */}
            {(userData?.bio || joinDate) && (
              <div className="rounded-2xl p-3 space-y-2.5" style={{ backgroundColor: blockBg }}>
                {userData?.bio && (
                  <div>
                    <p
                      className={cn('text-[10px] font-semibold uppercase tracking-wider mb-0.5', !mutedColor && 'text-muted-foreground')}
                      style={{ color: mutedColor }}
                    >
                      {t('userProfile.bio')}
                    </p>
                    <p
                      className={cn('text-sm whitespace-pre-wrap break-words', !textColor && 'text-foreground')}
                      style={{ color: textColor }}
                    >
                      {userData.bio}
                    </p>
                  </div>
                )}
                {userData?.bio && joinDate && (
                  <div className="h-px" style={{ backgroundColor: rawPanelColor ? (isDark(rawPanelColor) ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)') : 'rgba(255,255,255,0.1)' }} />
                )}
                {joinDate && (
                  <div>
                    <p
                      className={cn('text-[10px] font-semibold uppercase tracking-wider mb-0.5', !mutedColor && 'text-muted-foreground')}
                      style={{ color: mutedColor }}
                    >
                      {t('userProfile.memberSince')}
                    </p>
                    <p className={cn('text-sm', !textColor && 'text-foreground')} style={{ color: textColor }}>{joinDate}</p>
                  </div>
                )}
              </div>
            )}

            {/* Block 2: Roles */}
            {guildId && (
              <div className="rounded-2xl p-3" style={{ backgroundColor: blockBg }}>
                <div className="flex items-center justify-between mb-2">
                  <p
                    className={cn('text-[10px] font-semibold uppercase tracking-wider', !mutedColor && 'text-muted-foreground')}
                    style={{ color: mutedColor }}
                  >
                    {assignedRoles.length > 0 ? t('userProfile.rolesWithCount', { count: assignedRoles.length }) : t('userProfile.roles')}
                  </p>
                  {canManageRoles && (
                    <button
                      onClick={() => setEditingRoles((v) => !v)}
                      className={cn('text-[10px] transition-colors', !mutedColor && 'text-muted-foreground hover:text-foreground')}
                      style={{ color: mutedColor }}
                    >
                      {editingRoles ? t('common.done') : t('common.edit')}
                    </button>
                  )}
                </div>
                {!editingRoles ? roleChips : (
                  <div className="rounded-md border border-border overflow-hidden">
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
            )}

            {/* Block 3: Actions */}
            {!isSelf && (
              <div className="rounded-2xl p-3 space-y-2" style={{ backgroundColor: blockBg }}>
                {!isFriend && memberDiscriminator && (
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
            )}
          </>
        ) : (
          // ── Desktop: original flat layout ──────────────────────────────────
          <>
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
            {guildId && <div>
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
            </div>}

            {/* Actions */}
            <div className="space-y-2">
              {!isSelf && !isFriend && memberDiscriminator && (
                <Button size="sm" variant="secondary" className="w-full gap-2" onClick={() => void handleSendFriendRequest()}>
                  <UserPlus className="w-4 h-4" />
                  {t('userProfile.addFriend')}
                </Button>
              )}
              {!isSelf && (
                <Button size="sm" variant="secondary" className="w-full gap-2" onClick={() => void handleMessage()}>
                  <MessageSquare className="w-4 h-4" />
                  {t('userProfile.sendMessage')}
                </Button>
              )}
            </div>
          </>
        )}
      </ProfileCardBody>
    )
  }

  // ── Mobile: full-width bottom sheet via portal ─────────────────────────────
  if (isMobile) {
    return createPortal(
      <AnimatePresence>
        {profile && (
          <>
            {/* Backdrop */}
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[200] bg-black/50"
              onClick={close}
            />
            {/* Bottom sheet */}
            <motion.div
              key="sheet"
              ref={panelRef}
              drag="y"
              dragControls={dragControls}
              dragListener={false}
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0, bottom: 0.4 }}
              onDragEnd={(_, { offset, velocity }) => {
                if (offset.y > 80 || velocity.y > 400) close()
              }}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className={cn(
                'fixed bottom-0 left-0 right-0 z-[201] rounded-t-2xl border-t border-x border-border shadow-2xl flex flex-col overflow-hidden',
                !rawPanelColor && 'bg-popover',
              )}
              style={{ height: '75dvh', ...(rawPanelColor ? { backgroundColor: rawPanelColor } : {}) }}
            >
              {/* Drag handle — absolutely overlaid on top of the banner */}
              <div
                className="absolute top-0 left-0 right-0 z-10 flex justify-center pt-2.5 cursor-grab active:cursor-grabbing"
                onPointerDown={(e) => dragControls.start(e)}
                style={{ touchAction: 'none' }}
              >
                <div className="w-10 h-1 rounded-full bg-white/40" />
              </div>
              <div
                ref={sheetScrollRef}
                className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
                onScroll={() => setSheetAtTop((sheetScrollRef.current?.scrollTop ?? 0) === 0)}
                onPointerDown={(e) => { if (sheetAtTop) dragControls.start(e) }}
                style={{ touchAction: sheetAtTop ? 'none' : 'pan-y' }}
              >
                {renderContent(true)}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>,
      document.body,
    )
  }

  // ── Desktop: fixed panel with directional slide ─────────────────────────────

  const panelX = activeProfile
    ? (activeProfile.x > window.innerWidth / 2 ? activeProfile.x - PANEL_W - 12 : activeProfile.x + 12)
    : 0
  const panelY = activeProfile
    ? Math.max(8, Math.min(activeProfile.y, window.innerHeight - 540))
    : 0
  const slideX = activeProfile
    ? (activeProfile.x > window.innerWidth / 2 ? -24 : 24)
    : 0

  return (
    <AnimatePresence>
      {profile && activeProfile && (
        <motion.div
          ref={panelRef}
          initial={{ opacity: 0, x: slideX }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: slideX }}
          transition={{ type: 'spring', damping: 26, stiffness: 340 }}
          className={cn(
            'fixed z-[60] rounded-lg border border-border shadow-2xl overflow-hidden flex flex-col',
            !rawPanelColor && 'bg-popover',
          )}
          style={{ left: panelX, top: panelY, width: PANEL_W, ...(rawPanelColor ? { backgroundColor: rawPanelColor } : {}) }}
        >
          {renderContent()}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
