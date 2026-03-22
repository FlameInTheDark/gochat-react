import { useState, useEffect, useRef, useMemo, Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Plus, Trash2, ShieldAlert, Copy, Camera, AlertTriangle, Smile, Upload, Pencil, Shield, UserMinus, Ban, GripVertical, ChevronLeft, ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { useUiStore } from '@/stores/uiStore'
import { useAuthStore } from '@/stores/authStore'
import { guildApi, inviteApi, rolesApi, uploadApi, axiosInstance } from '@/api/client'
import type { DtoGuildInvite, DtoMember } from '@/types'
import type { DtoGuildBan, DtoGuildEmoji, DtoRole, GuildBanMemberRequest } from '@/client'
import { PermissionBits, hasPermission as hasPerm, calculateEffectivePermissions } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import ImageCropDialog from '@/components/modals/ImageCropDialog'
import { useEmojiStore } from '@/stores/emojiStore'
import { emojiUrl } from '@/lib/emoji'
import { getApiBaseUrl, getInviteUrl } from '@/lib/connectionConfig'
import { useClientMode } from '@/hooks/useClientMode'

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Types ─────────────────────────────────────────────────────────────────────

type Section = 'overview' | 'members' | 'roles' | 'invites' | 'emojis' | 'bans' | 'danger'

const NAV: { key: Section; danger?: boolean }[] = [
  { key: 'overview' },
  { key: 'members' },
  { key: 'roles' },
  { key: 'invites' },
  { key: 'emojis' },
  { key: 'bans' },
  { key: 'danger', danger: true },
]

// ── Permission definitions (from backend docs) ────────────────────────────────

interface PermDef { bit: number; label: string; desc: string; danger?: boolean }
interface PermCategory { category: string; perms: PermDef[] }

// ── Helpers ───────────────────────────────────────────────────────────────────

const colorToHex = (color: number) =>
  `#${Math.max(0, color ?? 0).toString(16).padStart(6, '0')}`
const hexToColor = (hex: string) => parseInt(hex.replace('#', ''), 16)

/**
 * Sentinel ID for the synthetic @everyone entry (guild-level default permissions).
 * The backend has no @everyone role row — guild.permissions IS the default.
 */
const EVERYONE_ID = '__everyone__'

/** Sort real roles by position (lower value = higher priority, shown first). */
function sortRoles(roles: DtoRole[]): DtoRole[] {
  return [...roles].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
}

function Toggle({
  value, onToggle, disabled,
}: { value: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        'relative w-10 h-5 rounded-full transition-colors shrink-0',
        value ? 'bg-green-500' : 'bg-muted',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform',
          value && 'translate-x-5',
        )}
      />
    </button>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ServerSettingsModal() {
  const { t } = useTranslation()
  const guildId = useUiStore((s) => s.serverSettingsGuildId)
  const close = useUiStore((s) => s.closeServerSettings)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const open = guildId !== null

  const permissionDefs = useMemo((): PermCategory[] => [
    {
      category: t('serverSettings.permCategoryGeneral'),
      perms: [
        { bit: 26, label: t('serverSettings.permAdministrator'), desc: t('serverSettings.permAdministratorDesc'), danger: true },
        { bit: 4,  label: t('serverSettings.permManageServer'),   desc: t('serverSettings.permManageServerDesc') },
        { bit: 2,  label: t('serverSettings.permManageRoles'),    desc: t('serverSettings.permManageRolesDesc') },
        { bit: 1,  label: t('serverSettings.permManageChannels'), desc: t('serverSettings.permManageChannelsDesc') },
        { bit: 3,  label: t('serverSettings.permViewAuditLog'),   desc: t('serverSettings.permViewAuditLogDesc') },
        { bit: 5,  label: t('serverSettings.permCreateInvites'),  desc: t('serverSettings.permCreateInvitesDesc') },
      ],
    },
    {
      category: t('serverSettings.permCategoryMembership'),
      perms: [
        { bit: 8,  label: t('serverSettings.permKickMembers'),     desc: t('serverSettings.permKickMembersDesc'), danger: true },
        { bit: 9,  label: t('serverSettings.permBanMembers'),      desc: t('serverSettings.permBanMembersDesc'), danger: true },
        { bit: 10, label: t('serverSettings.permTimeoutMembers'),  desc: t('serverSettings.permTimeoutMembersDesc') },
        { bit: 7,  label: t('serverSettings.permManageNicknames'), desc: t('serverSettings.permManageNicknamesDesc') },
        { bit: 6,  label: t('serverSettings.permChangeNickname'),  desc: t('serverSettings.permChangeNicknameDesc') },
      ],
    },
    {
      category: t('serverSettings.permCategoryText'),
      perms: [
        { bit: 0,  label: t('serverSettings.permViewChannels'),    desc: t('serverSettings.permViewChannelsDesc') },
        { bit: 19, label: t('serverSettings.permReadHistory'),     desc: t('serverSettings.permReadHistoryDesc') },
        { bit: 11, label: t('serverSettings.permSendMessages'),    desc: t('serverSettings.permSendMessagesDesc') },
        { bit: 14, label: t('serverSettings.permAttachFiles'),     desc: t('serverSettings.permAttachFilesDesc') },
        { bit: 15, label: t('serverSettings.permAddReactions'),    desc: t('serverSettings.permAddReactionsDesc') },
        { bit: 16, label: t('serverSettings.permMentionRoles'),    desc: t('serverSettings.permMentionRolesDesc') },
        { bit: 17, label: t('serverSettings.permManageMessages'),  desc: t('serverSettings.permManageMessagesDesc') },
        { bit: 12, label: t('serverSettings.permSendInThreads'),   desc: t('serverSettings.permSendInThreadsDesc') },
        { bit: 13, label: t('serverSettings.permCreateThreads'),   desc: t('serverSettings.permCreateThreadsDesc') },
        { bit: 18, label: t('serverSettings.permManageThreads'),   desc: t('serverSettings.permManageThreadsDesc') },
      ],
    },
    {
      category: t('serverSettings.permCategoryVoice'),
      perms: [
        { bit: 20, label: t('serverSettings.permConnect'),        desc: t('serverSettings.permConnectDesc') },
        { bit: 21, label: t('serverSettings.permSpeak'),          desc: t('serverSettings.permSpeakDesc') },
        { bit: 22, label: t('serverSettings.permVideo'),          desc: t('serverSettings.permVideoDesc') },
        { bit: 23, label: t('serverSettings.permMuteMembers'),    desc: t('serverSettings.permMuteMembersDesc') },
        { bit: 24, label: t('serverSettings.permDeafenMembers'),  desc: t('serverSettings.permDeafenMembersDesc') },
        { bit: 25, label: t('serverSettings.permMoveMembers'),    desc: t('serverSettings.permMoveMembersDesc') },
      ],
    },
  ], [t])

  const [section, setSection] = useState<Section>('overview')
  const isMobile = useClientMode() === 'mobile'
  const [mobileShowNav, setMobileShowNav] = useState(true)
  const [deletingServer, setDeletingServer] = useState(false)
  const [deleteConfirmName, setDeleteConfirmName] = useState('')

  // Overview
  const [name, setName] = useState('')
  const [isPublic, setIsPublic] = useState(false)
  const [savingOverview, setSavingOverview] = useState(false)

  // Roles — two-panel layout (list + editor); on mobile uses two-screen nav
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  const [mobileRoleShowList, setMobileRoleShowList] = useState(true)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('#5865f2')
  const [editPermissions, setEditPermissions] = useState(0)
  const [savingRole, setSavingRole] = useState(false)
  const [deletingRoleId, setDeletingRoleId] = useState<string | null>(null)
  // inline create
  const [creatingRole, setCreatingRole] = useState(false)
  const [newRoleName, setNewRoleName] = useState('')
  const [newRoleColor, setNewRoleColor] = useState('#5865f2')

  // Role ordering via drag-and-drop
  const [orderedRoles, setOrderedRoles] = useState<DtoRole[]>([])
  const dragSrcIdx = useRef<number | null>(null)
  const [savingOrder, setSavingOrder] = useState(false)

  // Member role assignment
  const [savingMemberRole, setSavingMemberRole] = useState<string | null>(null) // `${userId}:${roleId}`
  const [memberFilter, setMemberFilter] = useState('')

  async function toggleMemberRole(userId: string, roleId: string, currentlyHas: boolean) {
    if (!guildId) return
    setSavingMemberRole(`${userId}:${roleId}`)
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
          const next = currentlyHas ? prev.filter((id) => id !== roleId) : [...prev, roleId]
          return { ...m, roles: next.map(Number) }
        }),
      )
      toast.success(currentlyHas ? t('memberList.roleRemoved') : t('memberList.roleAssigned'))
    } catch {
      toast.error(currentlyHas ? t('memberList.roleRemoveFailed') : t('memberList.roleAssignFailed'))
    } finally {
      setSavingMemberRole(null)
    }
  }

  // Kick / Ban
  const [kickingUserId, setKickingUserId] = useState<string | null>(null)
  const [banningUserId, setBanningUserId] = useState<string | null>(null)
  const [banReason, setBanReason] = useState('')
  const [banDialogUserId, setBanDialogUserId] = useState<string | null>(null)
  const [unbanningUserId, setUnbanningUserId] = useState<string | null>(null)

  async function handleKick(userId: string) {
    if (!guildId) return
    setKickingUserId(userId)
    try {
      await guildApi.guildGuildIdMemberUserIdKickPost({ guildId, userId })
      queryClient.setQueryData<DtoMember[]>(['members', guildId], (old = []) =>
        old.filter((m) => String(m.user?.id) !== userId),
      )
      toast.success(t('serverSettings.kickSuccess'))
    } catch {
      toast.error(t('serverSettings.kickFailed'))
    } finally {
      setKickingUserId(null)
    }
  }

  async function handleBan(userId: string, reason?: string) {
    if (!guildId) return
    setBanningUserId(userId)
    try {
      const request: GuildBanMemberRequest | undefined = reason?.trim() ? { reason: reason.trim() } : undefined
      await guildApi.guildGuildIdMemberUserIdBanPost({ guildId, userId, request })
      queryClient.setQueryData<DtoMember[]>(['members', guildId], (old = []) =>
        old.filter((m) => String(m.user?.id) !== userId),
      )
      toast.success(t('serverSettings.banSuccess'))
    } catch {
      toast.error(t('serverSettings.banFailed'))
    } finally {
      setBanningUserId(null)
      setBanDialogUserId(null)
      setBanReason('')
    }
  }

  async function handleUnban(userId: string) {
    if (!guildId) return
    setUnbanningUserId(userId)
    try {
      await guildApi.guildGuildIdMemberUserIdBanDelete({ guildId, userId })
      await refetchBans()
      toast.success(t('serverSettings.unbanSuccess'))
    } catch {
      toast.error(t('serverSettings.unbanFailed'))
    } finally {
      setUnbanningUserId(null)
    }
  }

  // Icon upload
  const iconInputRef = useRef<HTMLInputElement>(null)
  const [uploadingIcon, setUploadingIcon] = useState(false)
  const [cropDialogOpen, setCropDialogOpen] = useState(false)
  const [cropImageDataUrl, setCropImageDataUrl] = useState('')
  const [localIconUrl, setLocalIconUrl] = useState<string | null>(null)

  // Invites
  const [inviteExpiry, setInviteExpiry] = useState('86400')
  const [creatingInvite, setCreatingInvite] = useState(false)

  // Emojis
  const emojiFileRef = useRef<HTMLInputElement>(null)
  const [emojiName, setEmojiName] = useState('')
  const [emojiFile, setEmojiFile] = useState<File | null>(null)
  const [uploadingEmoji, setUploadingEmoji] = useState(false)
  const [editingEmojiId, setEditingEmojiId] = useState<string | null>(null)
  const [editingEmojiName, setEditingEmojiName] = useState('')
  const [savingEmojiId, setSavingEmojiId] = useState<string | null>(null)
  const [deletingEmojiId, setDeletingEmojiId] = useState<string | null>(null)

  // ── Queries ─────────────────────────────────────────────────────────────────

  const { data: guild } = useQuery({
    queryKey: ['guild', guildId],
    queryFn: () => guildApi.guildGuildIdGet({ guildId: guildId! }).then((r) => r.data),
    enabled: open && !!guildId,
    staleTime: 30_000,
  })

  // Current user and owner check
  const currentUser = useAuthStore((s) => s.user)
  const ownerIdStr = guild?.owner != null ? String(guild.owner) : null
  const isOwner = ownerIdStr !== null && currentUser?.id !== undefined && ownerIdStr === String(currentUser.id)

  // Redirect away from danger section if not owner
  useEffect(() => {
    if (section === 'danger' && !isOwner) {
      setSection('overview')
    }
  }, [section, isOwner])

  const { data: members = [] } = useQuery<DtoMember[]>({
    queryKey: ['members', guildId],
    queryFn: () => guildApi.guildGuildIdMembersGet({ guildId: guildId! }).then((r) => r.data ?? []),
    enabled: open && !!guildId && (section === 'members' || section === 'bans'),
    staleTime: 30_000,
  })

  const { data: roles = [], dataUpdatedAt: rolesUpdatedAt } = useQuery<DtoRole[]>({
    queryKey: ['roles', guildId],
    queryFn: () => rolesApi.guildGuildIdRolesGet({ guildId: guildId! }).then((r) => r.data ?? []),
    enabled: open && !!guildId && (section === 'roles' || section === 'members' || section === 'bans'),
    staleTime: 30_000,
  })

  const { data: bans = [], refetch: refetchBans } = useQuery<DtoGuildBan[]>({
    queryKey: ['bans', guildId],
    queryFn: () => guildApi.guildGuildIdBansGet({ guildId: guildId! }).then((r) => r.data ?? []),
    enabled: open && !!guildId && section === 'bans',
    staleTime: 30_000,
  })

  // Current user's effective moderation permissions
  const currentMember = members.find((m) => String(m.user?.id) === String(currentUser?.id))
  const effectivePerms = currentMember && roles.length > 0
    ? calculateEffectivePermissions(currentMember as DtoMember, roles as DtoRole[])
    : 0
  const canKick = isOwner || hasPerm(effectivePerms, PermissionBits.ADMINISTRATOR) || hasPerm(effectivePerms, PermissionBits.KICK_MEMBERS)
  const canBan = isOwner || hasPerm(effectivePerms, PermissionBits.ADMINISTRATOR) || hasPerm(effectivePerms, PermissionBits.BAN_MEMBERS)

  const { data: invites = [] } = useQuery<DtoGuildInvite[]>({
    queryKey: ['invites', guildId],
    queryFn: () => inviteApi.guildInvitesGuildIdGet({ guildId: guildId! }).then((r) => r.data ?? []),
    enabled: open && !!guildId && section === 'invites',
    staleTime: 30_000,
  })

  const { data: guildEmojis = [], refetch: refetchEmojis } = useQuery<DtoGuildEmoji[]>({
    queryKey: ['guild-emojis', guildId],
    queryFn: () => guildApi.guildGuildIdEmojisGet({ guildId: guildId! }).then((r) => r.data ?? []),
    enabled: open && !!guildId && section === 'emojis',
    staleTime: 30_000,
  })

  const roleMap = new Map<string, DtoRole>(roles.map((r) => [String(r.id), r]))

  // ── Effects ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (open && guild) {
      setName(guild.name ?? '')
      setIsPublic(guild.public ?? false)
    }
  }, [open, guild])

  // Reset all state when the target guild changes or the modal closes
  useEffect(() => {
    if (open) {
      setSection('overview')
      setSelectedRoleId(null)
      setCreatingRole(false)
    }
  }, [guildId, open])

  // Auto-select @everyone (guild defaults) when entering the roles section
  useEffect(() => {
    if (section === 'roles' && selectedRoleId === null && guild) {
      setSelectedRoleId(EVERYONE_ID)
      setEditPermissions(Number(guild.permissions ?? 0))
    }
  }, [section, selectedRoleId, guild])

  // Reset roles editor when leaving roles section
  useEffect(() => {
    if (section !== 'roles') {
      setSelectedRoleId(null)
      setCreatingRole(false)
      setMobileRoleShowList(true)
    }
  }, [section])

  // Sync ordered roles from server data.
  // Depend on rolesUpdatedAt (a stable number) instead of the `roles` array,
  // because the `= []` default creates a new reference every render when data
  // is undefined, which would cause an infinite setState loop.
  useEffect(() => {
    setOrderedRoles(sortRoles(roles))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rolesUpdatedAt])

  // Escape to close
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, close])

  // Reset mobile nav panel on open
  useEffect(() => { if (open) setMobileShowNav(true) }, [open])

  if (!open) return null

  // ── Permission helpers ───────────────────────────────────────────────────────

  const isAdmin = !!(editPermissions & (1 << 26))

  function hasPermission(bit: number) {
    return !!(editPermissions & (1 << bit))
  }

  function togglePermission(bit: number) {
    setEditPermissions((prev) => {
      const mask = 1 << bit
      return (prev & mask) ? (prev & ~mask) : (prev | mask)
    })
  }

  function selectEvery() {
    setSelectedRoleId(EVERYONE_ID)
    setEditPermissions(Number(guild?.permissions ?? 0))
    setCreatingRole(false)
    if (isMobile) setMobileRoleShowList(false)
  }

  function selectRole(role: DtoRole) {
    setSelectedRoleId(String(role.id))
    setEditName(role.name ?? '')
    setEditColor(colorToHex(role.color ?? 0))
    setEditPermissions(Number(role.permissions ?? 0))
    setCreatingRole(false)
    if (isMobile) setMobileRoleShowList(false)
  }

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const serverInitials = (guild?.name ?? '?').charAt(0).toUpperCase()
  const overviewChanged =
    (name.trim() !== '' && name.trim() !== guild?.name) ||
    isPublic !== (guild?.public ?? false)

  async function handleSaveOverview() {
    if (!guildId || !name.trim()) return
    setSavingOverview(true)
    try {
      await guildApi.guildGuildIdPatch({ guildId, request: { name: name.trim(), public: isPublic } })
      await queryClient.invalidateQueries({ queryKey: ['guilds'] })
      await queryClient.invalidateQueries({ queryKey: ['guild', guildId] })
      toast.success(t('serverSettings.overviewSaved'))
    } catch {
      toast.error(t('serverSettings.overviewFailed'))
    } finally {
      setSavingOverview(false)
    }
  }

  async function handleCreateRole() {
    if (!guildId || !newRoleName.trim()) return
    setSavingRole(true)
    try {
      const res = await rolesApi.guildGuildIdRolesPost({
        guildId,
        req: { name: newRoleName.trim(), color: hexToColor(newRoleColor) },
      })
      await queryClient.invalidateQueries({ queryKey: ['roles', guildId] })
      setCreatingRole(false)
      setNewRoleName('')
      setNewRoleColor('#5865f2')
      if (res.data) selectRole(res.data)
      toast.success(t('serverSettings.roleCreated'))
    } catch {
      toast.error(t('serverSettings.roleCreateFailed'))
    } finally {
      setSavingRole(false)
    }
  }

  async function handleSaveRole() {
    if (!guildId || !selectedRoleId) return
    setSavingRole(true)
    try {
      if (selectedRoleId === EVERYONE_ID) {
        // Save guild-level default permissions
        await guildApi.guildGuildIdPatch({
          guildId,
          request: { permissions: editPermissions },
        })
        await queryClient.invalidateQueries({ queryKey: ['guild', guildId] })
        await queryClient.invalidateQueries({ queryKey: ['guilds'] })
        toast.success(t('serverSettings.roleSaved'))
      } else {
        if (!editName.trim()) return
        await rolesApi.guildGuildIdRolesRoleIdPatch({
          guildId,
          roleId: selectedRoleId,
          req: { name: editName.trim(), color: hexToColor(editColor), permissions: editPermissions },
        })
        await queryClient.invalidateQueries({ queryKey: ['roles', guildId] })
        toast.success(t('serverSettings.roleSaved'))
      }
    } catch {
      toast.error(t('serverSettings.roleFailed'))
    } finally {
      setSavingRole(false)
    }
  }

  async function handleDeleteRole(roleId: string) {
    if (!guildId || roleId === EVERYONE_ID) return
    setDeletingRoleId(roleId)
    try {
      await rolesApi.guildGuildIdRolesRoleIdDelete({ guildId, roleId })
      await queryClient.invalidateQueries({ queryKey: ['roles', guildId] })
      if (selectedRoleId === roleId) {
        // Fall back to @everyone after deleting the selected role
        selectEvery()
      }
      toast.success(t('serverSettings.roleDeleted'))
    } catch {
      toast.error(t('serverSettings.roleDeleteFailed'))
    } finally {
      setDeletingRoleId(null)
    }
  }

  async function handleRoleReorder(newOrder: DtoRole[]) {
    if (!guildId) return
    setSavingOrder(true)
    try {
      await rolesApi.guildGuildIdRolesOrderPatch({
        guildId,
        request: {
          roles: newOrder.map((r, i) => ({ id: String(r.id), position: i })),
        },
      })
      queryClient.setQueryData<DtoRole[]>(
        ['roles', guildId],
        newOrder.map((r, i) => ({ ...r, position: i })),
      )
    } catch {
      setOrderedRoles(sortRoles(roles))
      toast.error(t('serverSettings.roleReorderFailed'))
    } finally {
      setSavingOrder(false)
    }
  }

  // Step 1 — file picker opens → read as data URL → show crop dialog
  function handleIconFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !guildId) return
    e.target.value = '' // allow re-selecting the same file
    const reader = new FileReader()
    reader.onload = () => {
      setCropImageDataUrl(reader.result as string)
      setCropDialogOpen(true)
    }
    reader.readAsDataURL(file)
  }

  // Step 2 — crop confirmed → upload cropped JPEG blob
  async function handleIconCropConfirmed(blob: Blob) {
    setCropDialogOpen(false)
    if (!guildId) return
    // Optimistically show the cropped image immediately
    const optimisticUrl = URL.createObjectURL(blob)
    setLocalIconUrl(optimisticUrl)
    setUploadingIcon(true)
    try {
      // 1. Create the icon placeholder (always send as JPEG after crop)
      const placeholder = await guildApi.guildGuildIdIconPost({
        guildId,
        request: { content_type: 'image/jpeg', file_size: blob.size },
      })
      const iconId = String(placeholder.data.id)
      // 2. Upload the cropped binary
      await uploadApi.uploadIconsGuildIdIconIdPost({
        guildId,
        iconId,
        file: blob as unknown as number[],
      })
      // 3. Refresh guild data
      await queryClient.invalidateQueries({ queryKey: ['guild', guildId] })
      await queryClient.invalidateQueries({ queryKey: ['guilds'] })
      toast.success(t('serverSettings.iconUploaded'))
    } catch {
      toast.error(t('serverSettings.iconFailed'))
    } finally {
      setUploadingIcon(false)
      URL.revokeObjectURL(optimisticUrl)
      setLocalIconUrl(null)
    }
  }

  async function handleCreateInvite() {
    if (!guildId) return
    setCreatingInvite(true)
    try {
      const sec = Number(inviteExpiry)
      await inviteApi.guildInvitesGuildIdPost({
        guildId,
        request: sec > 0 ? { expires_in_sec: sec } : {},
      })
      await queryClient.invalidateQueries({ queryKey: ['invites', guildId] })
      toast.success(t('modals.createNewInvite'))
    } catch {
      toast.error(t('modals.createInviteFailed'))
    } finally {
      setCreatingInvite(false)
    }
  }

  async function handleRevokeInvite(inviteId: string) {
    if (!guildId) return
    try {
      await inviteApi.guildInvitesGuildIdInviteIdDelete({ guildId, inviteId })
      await queryClient.invalidateQueries({ queryKey: ['invites', guildId] })
      toast.success(t('serverSettings.revokeInvite'))
    } catch {
      toast.error(t('serverSettings.inviteRevokeFailed'))
    }
  }

  // ── Emoji handlers ────────────────────────────────────────────────────────

  async function handleUploadEmoji() {
    if (!guildId || !emojiFile || !emojiName.trim()) return
    const baseUrl = getApiBaseUrl()
    setUploadingEmoji(true)
    try {
      // Step 1: create placeholder
      const placeholderRes = await guildApi.guildGuildIdEmojisPost({
        guildId,
        request: {
          name: emojiName.trim(),
          file_size: emojiFile.size,
          content_type: emojiFile.type || 'image/png',
        },
      })
      const { id: emojiId, guild_id } = placeholderRes.data
      if (!emojiId || !guild_id) throw new Error('Invalid placeholder response')

      // Step 2: upload binary — send raw bytes, not JSON
      await axiosInstance.post(
        `${baseUrl}/upload/emojis/${guild_id}/${emojiId}`,
        emojiFile,
        {
          headers: { 'Content-Type': emojiFile.type || 'image/png' },
          transformRequest: [(data) => data],
        },
      )

      // Update local store and refetch
      useEmojiStore.getState().addEmoji({
        id: String(emojiId),
        name: emojiName.trim(),
        guild_id: String(guild_id),
      })
      await refetchEmojis()
      toast.success(t('serverSettings.emojiUploaded'))
      setEmojiName('')
      setEmojiFile(null)
      if (emojiFileRef.current) emojiFileRef.current.value = ''
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? t('serverSettings.emojiUploadFailed'))
    } finally {
      setUploadingEmoji(false)
    }
  }

  async function handleRenameEmoji(emojiId: string) {
    if (!guildId || !editingEmojiName.trim()) return
    setSavingEmojiId(emojiId)
    try {
      await guildApi.guildGuildIdEmojisEmojiIdPatch({
        guildId,
        emojiId,
        request: { name: editingEmojiName.trim() },
      })
      useEmojiStore.getState().updateEmoji({
        id: emojiId,
        name: editingEmojiName.trim(),
        guild_id: guildId,
      })
      await refetchEmojis()
      setEditingEmojiId(null)
      toast.success(t('serverSettings.emojiNameSaved'))
    } catch {
      toast.error(t('serverSettings.emojiNameSaveFailed'))
    } finally {
      setSavingEmojiId(null)
    }
  }

  async function handleDeleteEmoji(emojiId: string) {
    if (!guildId) return
    setDeletingEmojiId(emojiId)
    try {
      await guildApi.guildGuildIdEmojisEmojiIdDelete({ guildId, emojiId })
      useEmojiStore.getState().removeEmoji(guildId, emojiId)
      await refetchEmojis()
      toast.success(t('serverSettings.emojiDeleted'))
    } catch {
      toast.error(t('serverSettings.emojiDeleteFailed'))
    } finally {
      setDeletingEmojiId(null)
    }
  }

  async function handleDeleteServer() {
    if (!guildId) return
    setDeletingServer(true)
    try {
      await guildApi.guildGuildIdDelete({ guildId })
      await queryClient.invalidateQueries({ queryKey: ['guilds'] })
      toast.success(t('serverSettings.deleteServer'))
      close()
      navigate('/app/@me')
    } catch {
      toast.error(t('serverSettings.deleteServerFailed'))
    } finally {
      setDeletingServer(false)
      setDeleteConfirmName('')
    }
  }

  const selectClass =
    'rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring'

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <>
    <div className="fixed inset-0 z-50 flex bg-background/80 backdrop-blur-sm">
      <div className={cn('flex w-full h-full overflow-hidden', isMobile && 'flex-col')}>

          {/* ── Mobile header ── */}
          {isMobile && (
            <div className="h-12 flex items-center px-3 border-b border-sidebar-border shrink-0 bg-sidebar">
              {!mobileShowNav && (
                <button
                  onClick={() => setMobileShowNav(true)}
                  className="w-8 h-8 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors mr-1"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
              )}
              <span className="font-semibold text-sm flex-1 truncate">
                {mobileShowNav ? (guild?.name ?? t('serverSettings.title')) : (() => {
                  const navItem = NAV.find((n) => n.key === section)
                  if (!navItem) return ''
                  const labelMap: Record<Section, string> = {
                    overview: t('serverSettings.navOverview'),
                    members: t('serverSettings.navMembers'),
                    roles: t('serverSettings.navRoles'),
                    invites: t('serverSettings.navInvites'),
                    emojis: t('serverSettings.navEmoji'),
                    bans: t('serverSettings.navBans'),
                    danger: t('serverSettings.navDanger'),
                  }
                  return labelMap[navItem.key] ?? ''
                })()}
              </span>
              <button
                onClick={close}
                className="w-8 h-8 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

        {/* ── Left nav ── */}
        <div className={cn(
          'bg-sidebar',
          isMobile
            ? mobileShowNav ? 'flex flex-col flex-1 min-h-0 overflow-y-auto' : 'hidden'
            : 'flex flex-1 justify-end border-r border-sidebar-border',
        )}>
          <div className={cn('shrink-0', isMobile ? 'w-full py-4 px-3' : 'w-52 py-16 px-3')}>
            <p className="px-3 py-1 text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 truncate">
              {guild?.name ?? t('serverSettings.title')}
            </p>
            <div className="space-y-0.5">
              {(() => {
                const navLabelMap: Record<Section, string> = {
                  overview: t('serverSettings.navOverview'),
                  members: t('serverSettings.navMembers'),
                  roles: t('serverSettings.navRoles'),
                  invites: t('serverSettings.navInvites'),
                  emojis: t('serverSettings.navEmoji'),
                  bans: t('serverSettings.navBans'),
                  danger: t('serverSettings.navDanger'),
                }
                return NAV.map((s, i) => {
                  // Hide danger section for non-owners
                  if (s.danger && !isOwner) return null
                  // Hide bans section for users without ban permission
                  if (s.key === 'bans' && !canBan) return null

                  return (
                    <Fragment key={s.key}>
                      {s.danger && i > 0 && (
                        <div className="my-2 h-px bg-border mx-3" />
                      )}
                      <button
                        onClick={() => { setSection(s.key); if (isMobile) setMobileShowNav(false) }}
                        className={cn(
                          'w-full text-left px-3 rounded text-sm transition-colors flex items-center justify-between',
                          isMobile ? 'py-3' : 'py-1.5',
                          s.danger
                            ? section === s.key
                              ? 'bg-destructive/20 text-destructive'
                              : 'text-destructive/70 hover:text-destructive hover:bg-destructive/10'
                            : section === s.key
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                        )}
                      >
                        {navLabelMap[s.key]}
                        {isMobile && <ChevronRight className="w-4 h-4 shrink-0" />}
                      </button>
                    </Fragment>
                  )
                })
              })()}
            </div>
          </div>
        </div>

        {/* ── Content ── */}
        <div className={cn(
          'flex flex-1 min-w-0 min-h-0',
          isMobile && (mobileShowNav ? 'hidden' : 'flex'),
        )}>
          <div
            className={cn(
              'flex-1 overflow-y-auto h-full',
              isMobile
                ? 'py-4 px-4'
                : section === 'roles' ? 'py-16 px-6' : 'py-16 px-10 max-w-2xl',
            )}
          >

            {/* ── Overview ── */}
            {section === 'overview' && (
              <div className="space-y-6">
                <h2 className="text-xl font-bold">{t('serverSettings.overviewTitle')}</h2>

                <div className="flex items-center gap-4">
                  {/* Clickable icon with camera overlay */}
                  <div
                    className="relative shrink-0 group cursor-pointer"
                    onClick={() => !uploadingIcon && iconInputRef.current?.click()}
                    title={t('serverSettings.changeIcon')}
                  >
                    <div className="w-16 h-16 rounded-2xl overflow-hidden bg-primary flex items-center justify-center text-primary-foreground text-2xl font-bold select-none">
                      {(localIconUrl ?? guild?.icon?.url)
                        ? <img src={localIconUrl ?? guild!.icon!.url} alt={guild?.name ?? ''} className="w-full h-full object-cover" />
                        : serverInitials}
                    </div>
                    {/* Hover overlay */}
                    {!uploadingIcon && (
                      <div className="absolute inset-0 rounded-2xl bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                        <Camera className="w-5 h-5 text-white" />
                      </div>
                    )}
                    {/* Upload spinner */}
                    {uploadingIcon && (
                      <div className="absolute inset-0 rounded-2xl bg-black/60 flex items-center justify-center">
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                  </div>
                  <input
                    ref={iconInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleIconFileSelected}
                  />
                  <div>
                    <p className="font-semibold text-lg">{guild?.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {isPublic ? t('serverSettings.publicServer') : t('serverSettings.privateServer')}
                    </p>
                  </div>
                </div>

                <Separator />

                <div className="space-y-2">
                  <Label htmlFor="server-name">{t('serverSettings.serverNameLabel')}</Label>
                  <Input
                    id="server-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveOverview() }}
                    placeholder={t('serverSettings.serverNamePlaceholder')}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{t('serverSettings.publicServerLabel')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('serverSettings.publicServerDesc')}
                    </p>
                  </div>
                  <Toggle value={isPublic} onToggle={() => setIsPublic((v) => !v)} />
                </div>

                <Separator />

                <div className="space-y-2">
                  <Label>{t('serverSettings.serverIdLabel')}</Label>
                  <div className="flex gap-2 items-center">
                    <p className="text-sm text-muted-foreground bg-muted px-3 py-2 rounded-md flex-1 font-mono truncate">
                      {guildId}
                    </p>
                    <Button
                      variant="outline" size="sm"
                      onClick={() => { void navigator.clipboard.writeText(guildId ?? ''); toast.success(t('serverSettings.copied')) }}
                    >
                      {t('serverSettings.copy')}
                    </Button>
                  </div>
                </div>

                <div className="flex justify-end pt-2">
                  <Button onClick={() => void handleSaveOverview()} disabled={savingOverview || !overviewChanged}>
                    {savingOverview ? t('serverSettings.saving') : t('serverSettings.saveChanges')}
                  </Button>
                </div>
              </div>
            )}

            {/* ── Members ── */}
            {section === 'members' && (() => {
              const q = memberFilter.trim().toLowerCase()
              const filteredMembers = q
                ? members.filter((m) => {
                    const userId = String(m.user?.id ?? '')
                    const username = (m.username ?? '').toLowerCase()
                    const name = (m.user?.name ?? '').toLowerCase()
                    const discriminator = (m.user?.discriminator ?? '').toLowerCase()
                    return userId.includes(q) || username.includes(q) || name.includes(q) || discriminator.includes(q)
                  })
                : members
              return (
              <div className="space-y-4">
                <h2 className="text-xl font-bold">
                  {t('serverSettings.membersTitle')} — {filteredMembers.length}{q && members.length !== filteredMembers.length ? ` ${t('serverSettings.filterOf')} ${members.length}` : ''}
                </h2>
                <Input
                  placeholder={t('serverSettings.filterPlaceholder')}
                  value={memberFilter}
                  onChange={(e) => setMemberFilter(e.target.value)}
                />
                <div className="space-y-0.5">
                  {filteredMembers.map((member) => {
                    const userId = String(member.user?.id ?? '')
                    const displayName = member.username || member.user?.name || 'Unknown'
                    const memberRoles = (member.roles ?? [])
                      .map((rid) => roleMap.get(String(rid)))
                      .filter((r): r is DtoRole => r !== undefined)
                    const joinDate = member.join_at ? new Date(member.join_at).toLocaleDateString() : null
                    const memberRoleIds = new Set((member.roles ?? []).map(String))
                    const topRoleColor = roles
                      .filter((r) => memberRoleIds.has(String(r.id)) && (r.color ?? 0) !== 0)
                      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]
                    const nameColor = topRoleColor ? colorToHex(topRoleColor.color ?? 0) : undefined
                    const isTargetOwner = ownerIdStr !== null && userId === ownerIdStr
                    const targetPerms = calculateEffectivePermissions(member as DtoMember, roles as DtoRole[])
                    const isTargetAdmin = hasPerm(targetPerms, PermissionBits.ADMINISTRATOR)
                    // Admins can only be moderated by the server owner
                    const canModerate = !isTargetOwner && (!isTargetAdmin || isOwner)
                    const canKickTarget = canKick && canModerate
                    const canBanTarget = canBan && canModerate
                    return (
                      <ContextMenu key={userId}>
                        <ContextMenuTrigger asChild>
                          <div className="flex items-center gap-3 px-3 py-2.5 rounded hover:bg-accent/30 transition-colors cursor-pointer">
                            <Avatar className="w-9 h-9 shrink-0">
                              <AvatarImage src={member.user?.avatar?.url} alt={displayName} className="object-cover" />
                              <AvatarFallback className="text-xs">{displayName.charAt(0).toUpperCase()}</AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-medium" style={nameColor ? { color: nameColor } : undefined}>{displayName}</p>
                                {member.user?.discriminator && (
                                  <span className="text-xs text-muted-foreground">#{member.user.discriminator}</span>
                                )}
                                {memberRoles.map((role) => (
                                  <span
                                    key={String(role.id)}
                                    className="text-[10px] px-1.5 py-0.5 rounded font-medium leading-none"
                                    style={{
                                      backgroundColor: `${colorToHex(role.color ?? 0)}22`,
                                      color: colorToHex(role.color ?? 0),
                                      border: `1px solid ${colorToHex(role.color ?? 0)}55`,
                                    }}
                                  >
                                    {role.name}
                                  </span>
                                ))}
                              </div>
                              {joinDate && <p className="text-xs text-muted-foreground mt-0.5">{t('serverSettings.joined')} {joinDate}</p>}
                            </div>
                            <p className="text-xs text-muted-foreground font-mono shrink-0 hidden sm:block">{userId}</p>
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          {roles.length > 0 && (
                            <ContextMenuSub>
                              <ContextMenuSubTrigger className="gap-2">
                                <Shield className="w-4 h-4" />
                                Roles
                              </ContextMenuSubTrigger>
                              <ContextMenuSubContent className="min-w-[180px] max-h-72 overflow-y-auto">
                                {roles.map((role) => {
                                  const rid = String(role.id)
                                  const currentlyHas = memberRoleIds.has(rid)
                                  const isSaving = savingMemberRole === `${userId}:${rid}`
                                  const colorHex = role.color
                                    ? `#${Math.max(0, role.color).toString(16).padStart(6, '0')}`
                                    : undefined
                                  return (
                                    <ContextMenuCheckboxItem
                                      key={rid}
                                      checked={currentlyHas}
                                      disabled={isSaving}
                                      onSelect={(e) => {
                                        e.preventDefault()
                                        void toggleMemberRole(userId, rid, currentlyHas)
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
                          {(canKickTarget || canBanTarget) && <ContextMenuSeparator />}
                          {canKickTarget && (
                            <ContextMenuItem
                              disabled={kickingUserId === userId}
                              onSelect={() => void handleKick(userId)}
                              className="gap-2 text-destructive focus:text-destructive"
                            >
                              <UserMinus className="w-4 h-4" />
                              {kickingUserId === userId ? `${t('serverSettings.kickMember')}…` : t('serverSettings.kickMember')}
                            </ContextMenuItem>
                          )}
                          {canBanTarget && (
                            <ContextMenuItem
                              onSelect={() => { setBanDialogUserId(userId); setBanReason('') }}
                              className="gap-2 text-destructive focus:text-destructive"
                            >
                              <Ban className="w-4 h-4" />
                              {t('serverSettings.banMember')}
                            </ContextMenuItem>
                          )}
                        </ContextMenuContent>
                      </ContextMenu>
                    )
                  })}
                  {filteredMembers.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-12">
                      {q ? t('serverSettings.noMembersMatch', { filter: memberFilter }) : t('serverSettings.noMembers')}
                    </p>
                  )}
                </div>
              </div>
              )
            })()}

            {/* ── Bans ── */}
            {section === 'bans' && (
              <div className="space-y-4">
                <h2 className="text-xl font-bold">{t('serverSettings.bansTitle')}{bans.length > 0 ? ` — ${bans.length}` : ''}</h2>
                <div className="space-y-0.5">
                  {bans.map((ban) => {
                    const userId = String(ban.user?.id ?? '')
                    const displayName = ban.user?.name ?? 'Unknown'
                    return (
                      <div key={userId} className="flex items-center gap-3 px-3 py-2.5 rounded hover:bg-accent/30 transition-colors">
                        <Avatar className="w-9 h-9 shrink-0">
                          <AvatarImage src={ban.user?.avatar?.url} alt={displayName} className="object-cover" />
                          <AvatarFallback className="text-xs">{displayName.charAt(0).toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">{displayName}</p>
                          {ban.reason && <p className="text-xs text-muted-foreground mt-0.5">{t('serverSettings.banReason')}: {ban.reason}</p>}
                        </div>
                        {canBan && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={unbanningUserId === userId}
                            onClick={() => void handleUnban(userId)}
                          >
                            {unbanningUserId === userId ? t('serverSettings.unbanning') : t('serverSettings.unban')}
                          </Button>
                        )}
                      </div>
                    )
                  })}
                  {bans.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-12">{t('serverSettings.noBans')}</p>
                  )}
                </div>
              </div>
            )}

            {/* ── Roles ── two-panel layout ── */}
            {section === 'roles' && (
              <div className={cn('flex gap-0 h-full', isMobile && 'flex-col')}>

                {/* Left: Role list */}
                <div className={cn(
                  'shrink-0 flex flex-col',
                  isMobile
                    ? cn('w-full', !mobileRoleShowList && 'hidden')
                    : 'w-48 border-r border-border pr-2 mr-6',
                )}>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {t('serverSettings.rolesTitle')} — {roles.length}
                    </p>
                  </div>

                  {/* Inline create form */}
                  {creatingRole && (
                    <div className="mb-2 p-2 rounded border border-border bg-accent/10 space-y-2">
                      <div className="flex gap-2 items-center">
                        <input
                          type="color"
                          value={newRoleColor}
                          onChange={(e) => setNewRoleColor(e.target.value)}
                          className="w-7 h-7 rounded border border-input cursor-pointer p-0.5 bg-background shrink-0"
                        />
                        <Input
                          value={newRoleName}
                          onChange={(e) => setNewRoleName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleCreateRole()
                            if (e.key === 'Escape') setCreatingRole(false)
                          }}
                          placeholder={t('serverSettings.roleNamePlaceholder')}
                          autoFocus
                          className="flex-1 h-7 text-xs"
                        />
                      </div>
                      <div className="flex gap-1">
                        <Button size="sm" className="h-6 text-xs flex-1" onClick={() => void handleCreateRole()} disabled={savingRole || !newRoleName.trim()}>
                          {t('modals.create')}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setCreatingRole(false)}>
                          ✕
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Role list */}
                  <div className="space-y-0.5 flex-1 overflow-y-auto mb-3">

                    {/* Synthetic @everyone entry — always first */}
                    <button
                      onClick={selectEvery}
                      className={cn(
                        'w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left transition-colors',
                        selectedRoleId === EVERYONE_ID
                          ? 'bg-accent text-foreground'
                          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                      )}
                    >
                      <span className="w-3 h-3 rounded-full shrink-0 bg-zinc-400" />
                      <span className="truncate flex-1">{t('serverSettings.everyoneRole')}</span>
                      <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground font-medium leading-none shrink-0">
                        {t('serverSettings.everyoneBadge')}
                      </span>
                      {isMobile && <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground" />}
                    </button>

                    {/* Regular roles — drag-and-drop to reorder */}
                    {orderedRoles.map((role, index) => {
                      const rid = String(role.id)
                      const isDeleting = deletingRoleId === rid
                      return (
                        <div
                          key={rid}
                          draggable={!isDeleting && !savingOrder}
                          onDragStart={(e) => {
                            dragSrcIdx.current = index
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onDragOver={(e) => {
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            if (dragSrcIdx.current === null || dragSrcIdx.current === index) return
                            const newOrder = [...orderedRoles]
                            const [removed] = newOrder.splice(dragSrcIdx.current, 1)
                            newOrder.splice(index, 0, removed)
                            dragSrcIdx.current = index
                            setOrderedRoles(newOrder)
                          }}
                          onDragEnd={() => {
                            dragSrcIdx.current = null
                            void handleRoleReorder(orderedRoles)
                          }}
                          className={cn(
                            'flex items-center gap-1 rounded text-sm transition-colors group',
                            selectedRoleId === rid
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                            isDeleting && 'opacity-40',
                            savingOrder && 'cursor-wait',
                          )}
                        >
                          <GripVertical className="w-3.5 h-3.5 shrink-0 ml-1 opacity-30 group-hover:opacity-60 cursor-grab active:cursor-grabbing" />
                          <button
                            onClick={() => selectRole(role)}
                            disabled={isDeleting}
                            className="flex items-center gap-2 px-1 py-1.5 flex-1 min-w-0 text-left"
                          >
                            <span
                              className="w-3 h-3 rounded-full shrink-0"
                              style={{ backgroundColor: colorToHex(role.color ?? 0) }}
                            />
                            <span className="truncate flex-1">{role.name}</span>
                            {isMobile && <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground" />}
                          </button>
                        </div>
                      )
                    })}
                    {roles.length === 0 && !creatingRole && (
                      <p className="text-xs text-muted-foreground text-center py-4 opacity-60">
                        {t('serverSettings.noCustomRoles')}
                      </p>
                    )}
                  </div>

                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full gap-1 text-xs"
                    onClick={() => { setCreatingRole(true); setNewRoleName(''); setNewRoleColor('#5865f2') }}
                  >
                    <Plus className="w-3 h-3" />
                    {t('serverSettings.createRole')}
                  </Button>
                </div>

                {/* Right: Role editor */}
                <div className={cn(
                  'flex-1 min-w-0 overflow-y-auto',
                  isMobile && mobileRoleShowList && 'hidden',
                )}>
                  {isMobile && (
                    <button
                      onClick={() => setMobileRoleShowList(true)}
                      className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4" />
                      {t('serverSettings.backToRoles')}
                    </button>
                  )}
                  {selectedRoleId ? (() => {
                    const isEveryoneSelected = selectedRoleId === EVERYONE_ID
                    const selectedRole = isEveryoneSelected ? null : roleMap.get(selectedRoleId)
                    return (
                      <div className="space-y-6 pb-8">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <h2 className="text-xl font-bold">
                              {isEveryoneSelected ? t('serverSettings.everyoneRole') : t('serverSettings.editRole')}
                            </h2>
                            <p className="text-sm text-muted-foreground">
                              {isEveryoneSelected
                                ? t('serverSettings.everyoneDesc')
                                : t('serverSettings.roleEditDesc')}
                            </p>
                          </div>
                          {!isEveryoneSelected && (
                            <button
                              onClick={() => void handleDeleteRole(selectedRoleId)}
                              disabled={deletingRoleId === selectedRoleId}
                              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0 mt-1"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              {t('serverSettings.deleteRole')}
                            </button>
                          )}
                        </div>

                        {/* Name + Color row — only for real roles */}
                        {!isEveryoneSelected && (
                        <div className="flex gap-3 items-end">
                          <div className="space-y-2">
                            <Label>{t('serverSettings.colorLabel')}</Label>
                            <input
                              type="color"
                              value={editColor}
                              onChange={(e) => setEditColor(e.target.value)}
                              className="w-12 h-9 rounded border border-input cursor-pointer p-0.5 bg-background block"
                              title={t('serverSettings.roleColorTitle')}
                            />
                          </div>
                          <div className="flex-1 space-y-2">
                            <Label htmlFor="edit-role-name">{t('serverSettings.roleNameLabel')}</Label>
                            <Input
                              id="edit-role-name"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              placeholder={t('serverSettings.roleNamePlaceholder')}
                            />
                          </div>
                        </div>
                        )}

                        {/* Administrator warning banner */}
                        {isAdmin && (
                          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-500">
                            <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
                            <p className="text-xs leading-relaxed">
                              <strong>{t('serverSettings.adminWarningTitle')}</strong> {t('serverSettings.adminWarningDesc')}
                            </p>
                          </div>
                        )}

                        {/* Permissions */}
                        {permissionDefs.map((cat) => (
                          <div key={cat.category}>
                            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                              {cat.category}
                            </p>
                            <div className="rounded-lg border border-border overflow-hidden">
                              {cat.perms.map((perm, idx) => {
                                const isLast = idx === cat.perms.length - 1
                                const effectivelyOn = isAdmin && perm.bit !== 26
                                  ? true
                                  : hasPermission(perm.bit)
                                const isDisabled = isAdmin && perm.bit !== 26
                                return (
                                  <div
                                    key={perm.bit}
                                    className={cn(
                                      'flex items-start gap-4 px-4 py-3 transition-colors',
                                      !isLast && 'border-b border-border',
                                      isDisabled ? 'opacity-50' : 'hover:bg-accent/20',
                                    )}
                                  >
                                    <div className="flex-1 min-w-0">
                                      <p className={cn(
                                        'text-sm font-medium',
                                        perm.danger && !isDisabled && 'text-red-400',
                                      )}>
                                        {perm.label}
                                      </p>
                                      <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                                        {perm.desc}
                                      </p>
                                    </div>
                                    <div className="pt-0.5 shrink-0">
                                      <Toggle
                                        value={effectivelyOn}
                                        onToggle={() => togglePermission(perm.bit)}
                                        disabled={isDisabled}
                                      />
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ))}

                        {/* Save row */}
                        <div className="flex items-center justify-between pt-2 border-t border-border">
                          <div className="text-xs text-muted-foreground">
                            {!isEveryoneSelected && selectedRole && (
                              <>
                                {t('serverSettings.roleIdLabel')}{' '}
                                <button
                                  onClick={() => {
                                    void navigator.clipboard.writeText(selectedRoleId)
                                    toast.success(t('serverSettings.copied'))
                                  }}
                                  className="font-mono hover:text-foreground hover:underline"
                                >
                                  {selectedRoleId}
                                </button>
                              </>
                            )}
                          </div>
                          <Button
                            onClick={() => void handleSaveRole()}
                            disabled={savingRole || (!isEveryoneSelected && !editName.trim())}
                          >
                            {savingRole ? t('serverSettings.saving') : t('serverSettings.saveChanges')}
                          </Button>
                        </div>
                      </div>
                    )
                  })() : (
                    <div className="flex flex-col items-center justify-center h-64 text-center">
                      <p className="text-muted-foreground text-sm">
                        {t('serverSettings.selectRoleHint')}
                      </p>
                    </div>
                  )}
                </div>

              </div>
            )}

            {/* ── Invites ── */}
            {section === 'invites' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <h2 className="text-xl font-bold">{t('serverSettings.invitesTitle')}</h2>
                  <div className="flex gap-2 items-center">
                    <select
                      value={inviteExpiry}
                      onChange={(e) => setInviteExpiry(e.target.value)}
                      className={selectClass}
                    >
                      <option value="3600">{t('serverSettings.inviteOneHour')}</option>
                      <option value="86400">{t('serverSettings.inviteOneDay')}</option>
                      <option value="604800">{t('serverSettings.inviteSevenDays')}</option>
                      <option value="2592000">{t('serverSettings.inviteThirtyDays')}</option>
                      <option value="0">{t('serverSettings.inviteNeverExpires')}</option>
                    </select>
                    <Button size="sm" className="gap-1" onClick={() => void handleCreateInvite()} disabled={creatingInvite}>
                      <Plus className="w-3.5 h-3.5" />
                      {t('modals.create')}
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  {invites.map((invite) => {
                    const inviteId = String(invite.id)
                    const createdAt = invite.created_at ? new Date(invite.created_at).toLocaleDateString() : '—'
                    const expiresDate = invite.expires_at ? new Date(invite.expires_at) : null
                    const isExpired = expiresDate ? expiresDate < new Date() : false
                    const expiresLabel = expiresDate
                      ? isExpired ? t('serverSettings.inviteExpired') : expiresDate.toLocaleDateString()
                      : t('serverSettings.inviteNever')
                    return (
                      <div
                        key={inviteId}
                        className={cn(
                          'flex items-center gap-3 px-4 py-3 rounded-lg border',
                          isExpired ? 'border-border/50 opacity-60' : 'border-border bg-accent/10',
                        )}
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-mono font-semibold truncate">
                            {invite.code ?? '—'}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {t('serverSettings.inviteCreatedAt')} {createdAt} · {isExpired ? t('serverSettings.inviteExpired') : `${t('serverSettings.inviteExpires')} ${expiresLabel}`}
                          </p>
                        </div>
                        {/* Copy full invite URL */}
                        <button
                          onClick={() => {
                            if (!invite.code) return
                            void navigator.clipboard.writeText(getInviteUrl(invite.code))
                            toast.success(t('serverSettings.inviteCopied'))
                          }}
                          disabled={!invite.code}
                          className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
                          title={t('serverSettings.copyInviteLink')}
                        >
                          <Copy className="w-4 h-4" />
                        </button>
                        {/* Revoke */}
                        <button
                          onClick={() => void handleRevokeInvite(inviteId)}
                          className="p-1.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors shrink-0"
                          title={t('serverSettings.revokeInvite')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )
                  })}
                  {invites.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-12">
                      {t('serverSettings.noActiveInvites')}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* ── Emojis ── */}
            {section === 'emojis' && (
              <div className="space-y-6">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <Smile className="w-5 h-5" />
                  {t('serverSettings.emojiTitle')}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t('serverSettings.emojiDesc')}
                </p>

                {/* Upload form */}
                {isOwner && (
                  <div className="rounded-lg border border-border p-4 space-y-3">
                    <p className="text-sm font-semibold">{t('serverSettings.uploadEmoji')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('serverSettings.emojiLimits')}
                    </p>
                    <div className="flex gap-3 flex-wrap items-end">
                      <div className="space-y-1 flex-1 min-w-[140px]">
                        <Label className="text-xs">{t('serverSettings.emojiNameLabel')}</Label>
                        <Input
                          value={emojiName}
                          onChange={(e) => setEmojiName(e.target.value.replace(/[^A-Za-z0-9-]/g, ''))}
                          placeholder={t('serverSettings.emojiNamePlaceholder')}
                          className="h-8 text-sm"
                          maxLength={32}
                        />
                        <p className="text-[10px] text-muted-foreground">{t('serverSettings.emojiNameHint')}</p>
                      </div>
                      <div className="space-y-1 flex-1 min-w-[140px]">
                        <Label className="text-xs">{t('serverSettings.emojiFileLabel')}</Label>
                        <input
                          ref={emojiFileRef}
                          type="file"
                          accept="image/png,image/gif,image/webp,image/jpeg"
                          className="block w-full text-xs text-muted-foreground file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-muted file:text-foreground hover:file:bg-accent cursor-pointer"
                          onChange={(e) => setEmojiFile(e.target.files?.[0] ?? null)}
                        />
                      </div>
                      <Button
                        size="sm"
                        className="gap-2 shrink-0"
                        onClick={() => void handleUploadEmoji()}
                        disabled={uploadingEmoji || !emojiName.trim() || !emojiFile}
                      >
                        <Upload className="w-3.5 h-3.5" />
                        {uploadingEmoji ? t('serverSettings.uploading') : t('serverSettings.upload')}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Emoji list — Static & Animated */}
                {(() => {
                  const staticEmojis = guildEmojis.filter((e) => !e.animated)
                  const animatedEmojis = guildEmojis.filter((e) => e.animated)

                  const renderEmojiRow = (emoji: DtoGuildEmoji) => {
                    const eid = String(emoji.id)
                    const isEditing = editingEmojiId === eid
                    const isDeleting = deletingEmojiId === eid
                    const isSaving = savingEmojiId === eid
                    return (
                      <div
                        key={eid}
                        className={cn(
                          'flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent/50 group',
                          isDeleting && 'opacity-40',
                        )}
                      >
                        <img
                          src={emojiUrl(eid, 44)}
                          alt={emoji.name}
                          className="w-8 h-8 object-contain shrink-0"
                        />
                        {isEditing ? (
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <Input
                              value={editingEmojiName}
                              onChange={(e) => setEditingEmojiName(e.target.value.replace(/[^A-Za-z0-9-]/g, ''))}
                              className="h-7 text-sm flex-1"
                              maxLength={32}
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void handleRenameEmoji(eid)
                                if (e.key === 'Escape') setEditingEmojiId(null)
                              }}
                            />
                            <Button size="sm" className="h-7 text-xs" onClick={() => void handleRenameEmoji(eid)} disabled={isSaving || !editingEmojiName.trim()}>
                              {t('common.save')}
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingEmojiId(null)}>
                              {t('common.cancel')}
                            </Button>
                          </div>
                        ) : (
                          <>
                            <span className="font-mono text-sm flex-1 min-w-0 truncate">:{emoji.name}:</span>
                            {isOwner && (
                              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                <button
                                  onClick={() => { setEditingEmojiId(eid); setEditingEmojiName(emoji.name ?? '') }}
                                  className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                                  title="Rename"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => void handleDeleteEmoji(eid)}
                                  disabled={isDeleting}
                                  className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                                  title="Delete"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )
                  }

                  return (
                    <div className="space-y-6">
                      {/* Static */}
                      <div className="space-y-1">
                        <p className="text-sm font-medium">Static Emoji — {staticEmojis.length} / 50</p>
                        {staticEmojis.length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground rounded-md border border-dashed border-border">
                            <Smile className="w-8 h-8 mb-2 opacity-20" />
                            <p className="text-sm">No static emoji yet</p>
                            {isOwner && <p className="text-xs mt-1 opacity-70">Upload a PNG, WEBP or JPG above</p>}
                          </div>
                        ) : (
                          <div className="space-y-0.5">{staticEmojis.map(renderEmojiRow)}</div>
                        )}
                      </div>

                      {/* Animated */}
                      <div className="space-y-1">
                        <p className="text-sm font-medium">Animated Emoji — {animatedEmojis.length} / 50</p>
                        {animatedEmojis.length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground rounded-md border border-dashed border-border">
                            <Smile className="w-8 h-8 mb-2 opacity-20" />
                            <p className="text-sm">No animated emoji yet</p>
                            {isOwner && <p className="text-xs mt-1 opacity-70">Upload a GIF above</p>}
                          </div>
                        ) : (
                          <div className="space-y-0.5">{animatedEmojis.map(renderEmojiRow)}</div>
                        )}
                      </div>
                    </div>
                  )
                })()}
              </div>
            )}

            {/* ── Danger Zone ── */}
            {section === 'danger' && (
              <div className="space-y-6">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-destructive" />
                  {t('serverSettings.navDanger')}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t('serverSettings.deleteServerDesc')}
                </p>

                {/* Delete Server */}
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-5 space-y-4">
                  <div>
                    <p className="font-semibold text-destructive">{t('serverSettings.deleteServer')}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Permanently deletes <span className="font-medium text-foreground">{guild?.name}</span> and
                      all its channels, messages, and members. This action cannot be undone.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">
                      Type the server name <span className="font-mono font-semibold text-foreground">{guild?.name}</span> to confirm
                    </Label>
                    <Input
                      value={deleteConfirmName}
                      onChange={(e) => setDeleteConfirmName(e.target.value)}
                      placeholder={guild?.name ?? ''}
                      className="border-destructive/40 focus-visible:ring-destructive/40"
                    />
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="gap-2"
                    disabled={deletingServer || deleteConfirmName !== guild?.name}
                    onClick={() => void handleDeleteServer()}
                  >
                    <Trash2 className="w-4 h-4" />
                    {deletingServer ? t('serverSettings.deleteServerConfirm') : t('serverSettings.deleteServer')}
                  </Button>
                </div>
              </div>
            )}

          </div>

          {/* Close button — desktop only */}
          {!isMobile && (
            <div className="pt-16 pr-6 shrink-0">
              <button
                onClick={close}
                className="w-9 h-9 rounded-full border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

      </div>
    </div>

    {/* Ban confirm dialog */}
    <Dialog open={banDialogUserId !== null} onOpenChange={(o) => { if (!o) { setBanDialogUserId(null); setBanReason('') } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('serverSettings.banMember')}</DialogTitle>
          <DialogDescription>
            This member will be banned and unable to rejoin unless unbanned.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <label className="text-sm font-medium">{t('serverSettings.banReason')} (optional)</label>
          <Input
            placeholder="Enter ban reason…"
            value={banReason}
            onChange={(e) => setBanReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && banDialogUserId) void handleBan(banDialogUserId, banReason) }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setBanDialogUserId(null); setBanReason('') }}>{t('modals.cancel')}</Button>
          <Button
            variant="destructive"
            disabled={banningUserId !== null}
            onClick={() => { if (banDialogUserId) void handleBan(banDialogUserId, banReason) }}
          >
            {banningUserId !== null ? `${t('serverSettings.banMember')}…` : t('serverSettings.banMember')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Icon crop dialog — rendered above the settings modal */}
    <ImageCropDialog
      open={cropDialogOpen}
      imageDataUrl={cropImageDataUrl}
      onCancel={() => setCropDialogOpen(false)}
      onCrop={(blob) => void handleIconCropConfirmed(blob)}
    />
    </>
  )
}
