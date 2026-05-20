import { useState, useEffect, useRef, useMemo, Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Plus, Trash2, ShieldAlert, Copy, Camera, AlertTriangle, Smile, Upload, Pencil, Shield, UserMinus, Ban, GripVertical, ChevronLeft, ChevronRight, ImagePlus, Check } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { useUiStore } from '@/stores/uiStore'
import { guildApi, inviteApi, rolesApi, uploadApi, axiosInstance, searchApi } from '@/api/client'
import type { DtoGuild, DtoGuildInvite, DtoMember } from '@/types'
import type { DtoChannel, DtoGuildBan, DtoGuildDiscoveryUpdateResponse, DtoGuildEmoji, DtoRole, GuildBanMemberRequest } from '@/client'
import { ModelChannelType } from '@/client'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { roleIsHoisted } from '@/lib/roleVisuals'
import { cn } from '@/lib/utils'
import ImageCropDialog from '@/components/modals/ImageCropDialog'
import { useEmojiStore } from '@/stores/emojiStore'
import { emojiUrl } from '@/lib/emoji'
import { getApiBaseUrl, getInviteUrl } from '@/lib/connectionConfig'
import { useClientMode } from '@/hooks/useClientMode'
import { createPermissionChecker } from '@/lib/permissionChecker'
import { useGuildPermissions } from '@/hooks/useGuildPermissions'

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Types ─────────────────────────────────────────────────────────────────────

type Section = 'overview' | 'members' | 'roles' | 'invites' | 'emojis' | 'bans' | 'danger'
type RoleSettingsTab = 'display' | 'permissions' | 'members'

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
const TAG_PATTERN = /^[a-z0-9_-]{2,32}$/
const MAX_DISCOVERY_TAGS = 10

/** Sort real roles by position (lower value = higher priority, shown first). */
function sortRoles(roles: DtoRole[]): DtoRole[] {
  return [...roles].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
}

function normalizeTagsInput(value: string): { tags: string[]; invalid: string[] } {
  const seen = new Set<string>()
  const tags: string[] = []
  const invalid: string[] = []

  for (const raw of value.split(/[\n,]+/)) {
    const tag = raw.trim().toLowerCase()
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    if (!TAG_PATTERN.test(tag)) {
      invalid.push(tag)
      continue
    }
    if (tags.length < MAX_DISCOVERY_TAGS) tags.push(tag)
  }

  return { tags, invalid }
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase()
}

function sameTags(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((tag, index) => tag === right[index])
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resize a static image to fit within 128×128 px (aspect-ratio preserved).
 *  GIFs are returned unchanged to preserve animation. */
async function resizeEmojiIfNeeded(file: File): Promise<File> {
  if (file.type === 'image/gif') return file

  const MAX = 128
  const bitmap = await createImageBitmap(file)
  const { width, height } = bitmap

  if (width <= MAX && height <= MAX) {
    bitmap.close()
    return file
  }

  const scale = Math.min(MAX / width, MAX / height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  return new Promise<File>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error('Canvas toBlob failed')); return }
      resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.png'), { type: 'image/png' }))
    }, 'image/png')
  })
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ServerSettingsModal() {
  const { t } = useTranslation()
  const guildId = useUiStore((s) => s.serverSettingsGuildId)
  const close = useUiStore((s) => s.closeServerSettings)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const open = guildId !== null
  const permissions = useGuildPermissions(guildId)

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
    {
      category: t('serverSettings.permCategoryExpressions'),
      perms: [
        { bit: 27, label: t('serverSettings.permCreateExpressions'), desc: t('serverSettings.permCreateExpressionsDesc') },
        { bit: 28, label: t('serverSettings.permManageExpressions'), desc: t('serverSettings.permManageExpressionsDesc') },
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
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState('')
  const [tagInputFocused, setTagInputFocused] = useState(false)
  const [systemChannelId, setSystemChannelId] = useState('')
  const [savingOverview, setSavingOverview] = useState(false)

  // Roles — two-panel layout (list + editor); on mobile uses two-screen nav
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  const [mobileRoleShowList, setMobileRoleShowList] = useState(true)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('#5865f2')
  const [editPermissions, setEditPermissions] = useState(0)
  const [editHoist, setEditHoist] = useState(false)
  const [roleSettingsTab, setRoleSettingsTab] = useState<RoleSettingsTab>('permissions')
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
  const [emojiPreviewUrl, setEmojiPreviewUrl] = useState<string | null>(null)
  const [uploadingEmoji, setUploadingEmoji] = useState(false)
  const [editingEmojiId, setEditingEmojiId] = useState<string | null>(null)
  const [editingEmojiName, setEditingEmojiName] = useState('')
  const [savingEmojiId, setSavingEmojiId] = useState<string | null>(null)
  const [deletingEmojiId, setDeletingEmojiId] = useState<string | null>(null)

  async function handleEmojiFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.files?.[0] ?? null
    setEmojiPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null })
    if (!raw) { setEmojiFile(null); return }
    const file = await resizeEmojiIfNeeded(raw)
    if (file.size > 256 * 1024) {
      toast.error(t('serverSettings.emojiFileTooLarge'))
      setEmojiFile(null)
      if (emojiFileRef.current) emojiFileRef.current.value = ''
      return
    }
    setEmojiFile(file)
    setEmojiPreviewUrl(URL.createObjectURL(file))
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  const { data: guild } = useQuery<DtoGuild>({
    queryKey: ['guild', guildId],
    queryFn: () =>
      guildApi
        .guildGuildIdGet({ guildId: guildId! as unknown as number })
        .then((r) => r.data as DtoGuild),
    enabled: open && !!guildId,
    staleTime: 30_000,
  })

  const ownerIdStr = guild?.owner != null ? String(guild.owner) : null
  const isOwner = permissions.isOwner

  const { data: discoverySettings } = useQuery<DtoGuildDiscoveryUpdateResponse>({
    queryKey: ['guildDiscoverySettings', guildId],
    queryFn: () =>
      axiosInstance
        .get<DtoGuildDiscoveryUpdateResponse>(`${getApiBaseUrl()}/guild/${guildId}/discovery`)
        .then((r) => r.data),
    enabled: open && !!guildId && isOwner,
    staleTime: 30_000,
  })
  const discoveryGuild = discoverySettings?.guild
  const normalizedTagDraft = normalizeTag(tagDraft)
  const tagDraftInvalid = normalizedTagDraft !== '' && !TAG_PATTERN.test(normalizedTagDraft)
  const canAutocompleteTag = TAG_PATTERN.test(normalizedTagDraft)

  const { data: tagSuggestions = [] } = useQuery<string[]>({
    queryKey: ['guildTagSuggestions', normalizedTagDraft],
    queryFn: () =>
      searchApi
        .searchGuildTagsGet({ q: normalizedTagDraft || undefined, limit: 8 })
        .then((r) => r.data ?? []),
    enabled: open && isPublic && isOwner && tagInputFocused && canAutocompleteTag,
    staleTime: 30_000,
  })
  const availableTagSuggestions = tagSuggestions
    .map(normalizeTag)
    .filter((suggestion) => suggestion && !tags.includes(suggestion))
    .slice(0, 8)

  // Redirect away from danger section if not owner
  useEffect(() => {
    if (section === 'danger' && !isOwner) {
      setSection('overview')
    }
  }, [section, isOwner])

  const { data: members = [] } = useQuery<DtoMember[]>({
    queryKey: ['members', guildId],
    queryFn: () => guildApi.guildGuildIdMembersGet({ guildId: guildId! }).then((r) => r.data ?? []),
    enabled: open && !!guildId && (section === 'roles' || section === 'members' || section === 'bans'),
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

  const canKick = permissions.canKickMembers
  const canBan = permissions.canBanMembers
  const canUploadEmoji = permissions.canCreateExpressions
  const canManageEmoji = permissions.canManageExpressions

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

  const { data: allChannels = [] } = useQuery<DtoChannel[]>({
    queryKey: ['channels', guildId],
    queryFn: () => guildApi.guildGuildIdChannelGet({ guildId: guildId! }).then((r) => r.data ?? []),
    enabled: open && !!guildId && section === 'overview',
    staleTime: 60_000,
  })
  const textChannels = allChannels.filter((c) => c.type === ModelChannelType.ChannelTypeGuild)

  const roleMap = new Map<string, DtoRole>(roles.map((r) => [String(r.id), r]))

  // ── Effects ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (open && guild) {
      setName(guild.name ?? '')
      setIsPublic(guild.public ?? false)
      setDescription(discoveryGuild?.description ?? '')
      setTags(normalizeTagsInput((discoveryGuild?.tags ?? []).join(', ')).tags)
      setTagDraft('')
      setSystemChannelId(guild.system_channel_id ? String(guild.system_channel_id) : '')
    }
  }, [open, guild, discoveryGuild])

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
    setEditHoist(false)
    setRoleSettingsTab('permissions')
    setCreatingRole(false)
    if (isMobile) setMobileRoleShowList(false)
  }

  function selectRole(role: DtoRole) {
    setSelectedRoleId(String(role.id))
    setEditName(role.name ?? '')
    setEditColor(colorToHex(role.color ?? 0))
    setEditPermissions(Number(role.permissions ?? 0))
    setEditHoist(roleIsHoisted(role))
    setRoleSettingsTab('display')
    setMemberFilter('')
    setCreatingRole(false)
    if (isMobile) setMobileRoleShowList(false)
  }

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const serverInitials = (guild?.name ?? '?').charAt(0).toUpperCase()
  const currentDescription = discoveryGuild?.description ?? ''
  const currentTags = normalizeTagsInput((discoveryGuild?.tags ?? []).join(', ')).tags
  const nextDiscoveryTags = { tags, invalid: [] as string[] }
  const hasPendingValidTag = normalizedTagDraft !== '' && TAG_PATTERN.test(normalizedTagDraft) && !tags.includes(normalizedTagDraft)
  const discoveryChanged =
    isPublic !== (guild?.public ?? false) ||
    description.trim() !== currentDescription ||
    !sameTags(nextDiscoveryTags.tags, currentTags) ||
    hasPendingValidTag
  const overviewChanged =
    (name.trim() !== '' && name.trim() !== guild?.name) ||
    (isOwner && nextDiscoveryTags.invalid.length === 0 && discoveryChanged) ||
    systemChannelId !== (guild?.system_channel_id ? String(guild.system_channel_id) : '')

  function addDiscoveryTag(value: string): boolean {
    const parsed = normalizeTagsInput(value)
    const nextTags = parsed.tags.filter((tag) => !tags.includes(tag))
    const invalidTags = parsed.invalid

    if (invalidTags.length > 0) {
      toast.error(t('serverSettings.tagsInvalid', { tags: invalidTags.join(', ') }))
      return false
    }
    if (nextTags.length === 0) {
      setTagDraft('')
      return false
    }
    setTags((prev) => [...prev, ...nextTags].slice(0, MAX_DISCOVERY_TAGS))
    setTagDraft('')
    return true
  }

  function removeDiscoveryTag(tag: string) {
    setTags((prev) => prev.filter((item) => item !== tag))
  }

  function handleTagDraftChange(value: string) {
    if (value.includes(',') || value.includes('\n')) {
      const parts = value.split(/[\n,]+/)
      const last = parts.pop() ?? ''
      const bulk = parts.join(',')
      if (bulk.trim()) {
        addDiscoveryTag(bulk)
      }
      setTagDraft(last)
      return
    }
    setTagDraft(value)
  }

  function handleTagDraftKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === 'Tab' || event.key === ',') {
      if (tagDraft.trim()) {
        event.preventDefault()
        addDiscoveryTag(tagDraft)
      }
      return
    }
    if (event.key === 'Backspace' && !tagDraft && tags.length > 0) {
      setTags((prev) => prev.slice(0, -1))
    }
  }

  async function handleSaveOverview() {
    if (!guildId || !name.trim()) return
    let finalDiscoveryTags = tags
    if (tagDraft.trim()) {
      const parsed = normalizeTagsInput(tagDraft)
      if (parsed.invalid.length > 0) {
        toast.error(t('serverSettings.tagsInvalid', { tags: parsed.invalid.join(', ') }))
        return
      }
      finalDiscoveryTags = [...tags, ...parsed.tags.filter((tag) => !tags.includes(tag))].slice(0, MAX_DISCOVERY_TAGS)
      setTags(finalDiscoveryTags)
      setTagDraft('')
    }
    setSavingOverview(true)
    try {
      const calls: Promise<unknown>[] = []

      const nameChanged = name.trim() !== guild?.name
      if (nameChanged) {
        calls.push(guildApi.guildGuildIdPatch({
          guildId: guildId as unknown as number,
          request: { name: name.trim() },
        }))
      }

      if (isOwner && discoveryChanged) {
        calls.push(guildApi.guildGuildIdDiscoveryPatch({
          guildId: guildId as unknown as number,
          request: {
            public: isPublic,
            description: description.trim(),
            tags: finalDiscoveryTags,
          },
        }))
      }

      const systemChannelChanged = systemChannelId !== (guild?.system_channel_id ? String(guild.system_channel_id) : '')
      if (systemChannelChanged) {
        calls.push(guildApi.guildGuildIdSystemchPatch({
          guildId,
          request: { channel_id: (systemChannelId || null) as unknown as number },
        }))
      }

      await Promise.all(calls)
      await queryClient.invalidateQueries({ queryKey: ['guilds'] })
      await queryClient.invalidateQueries({ queryKey: ['guild', guildId] })
      await queryClient.invalidateQueries({ queryKey: ['guildDiscoverySettings', guildId] })
      await queryClient.invalidateQueries({ queryKey: ['guildDiscovery'] })
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
        req: { name: newRoleName.trim(), color: hexToColor(newRoleColor), permissions: guild?.permissions ?? 0, hoist: false },
      })
      if (res.data) {
        queryClient.setQueryData<DtoRole[]>(['roles', guildId], (old = []) => sortRoles([...old, res.data]))
      }
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
        const res = await rolesApi.guildGuildIdRolesRoleIdPatch({
          guildId,
          roleId: selectedRoleId,
          req: { name: editName.trim(), color: hexToColor(editColor), permissions: editPermissions, hoist: editHoist },
        })
        if (res.data) {
          queryClient.setQueryData<DtoRole[]>(['roles', guildId], (old = []) =>
            old.map((role) => (String(role.id) === selectedRoleId ? res.data : role)),
          )
          setOrderedRoles((old) => old.map((role) => (String(role.id) === selectedRoleId ? res.data : role)))
        }
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
      queryClient.setQueryData<DtoRole[]>(['roles', guildId], (old = []) =>
        old.filter((role) => String(role.id) !== roleId),
      )
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
        request: { expires_in_sec: sec },
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
      setEmojiPreviewUrl(null)
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
            : 'flex shrink-0 w-44 lg:w-[35%] lg:justify-end border-r border-sidebar-border',
        )}>
          <div className={cn('shrink-0', isMobile ? 'w-full py-4 px-3' : 'w-full py-16 px-3 lg:w-52')}>
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
              'flex-1 h-full min-h-0',
              isMobile
                ? section === 'roles' ? 'py-4 px-4 overflow-hidden' : 'py-4 px-4 overflow-y-auto'
                : section === 'roles' ? 'py-16 px-6 max-w-5xl overflow-hidden' : 'py-16 px-8 max-w-3xl overflow-y-auto',
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
                    aria-label={t('serverSettings.changeIcon')}
                  >
                    <div
                      className={cn(
                        'w-16 h-16 rounded-2xl overflow-hidden flex items-center justify-center text-2xl font-bold select-none',
                        (localIconUrl ?? guild?.icon?.url)
                          ? 'bg-muted/30'
                          : 'bg-primary text-primary-foreground',
                      )}
                    >
                      {(localIconUrl ?? guild?.icon?.url) ? (
                        <img
                          src={localIconUrl ?? guild!.icon!.url}
                          alt={guild?.name ?? ''}
                          className="w-full h-full object-contain"
                        />
                      ) : serverInitials}
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
                  <Toggle
                    value={isPublic}
                    onToggle={() => setIsPublic((v) => !v)}
                    disabled={!isOwner}
                  />
                </div>

                {isPublic && (
                  <div className="space-y-2 rounded-lg border bg-muted/20 p-4">
                    <div>
                      <p className="text-sm font-medium">{t('serverSettings.discoveryTitle')}</p>
                      <p className="text-xs text-muted-foreground">
                        {isOwner
                          ? t('serverSettings.discoveryDesc')
                          : t('serverSettings.discoveryOwnerOnly')}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="server-description">{t('serverSettings.descriptionLabel')}</Label>
                      <Textarea
                        id="server-description"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        maxLength={500}
                        disabled={!isOwner}
                        placeholder={t('serverSettings.descriptionPlaceholder')}
                        className="min-h-24 resize-none"
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('serverSettings.descriptionHint', { count: description.trim().length })}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="server-tags">{t('serverSettings.tagsLabel')}</Label>
                      <div className="relative">
                        <div
                          className={cn(
                            'flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-sm ring-offset-background focus-within:ring-1 focus-within:ring-ring',
                            !isOwner && 'opacity-50',
                          )}
                        >
                          {tags.map((tag) => (
                            <span
                              key={tag}
                              className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary px-2 py-1 text-xs text-secondary-foreground"
                            >
                              <span className="truncate">{tag}</span>
                              {isOwner && (
                                <button
                                  type="button"
                                  onClick={() => removeDiscoveryTag(tag)}
                                  className="rounded-full text-muted-foreground hover:text-foreground"
                                  aria-label={`Remove ${tag}`}
                                >
                                  <X className="size-3" />
                                </button>
                              )}
                            </span>
                          ))}
                          <input
                            id="server-tags"
                            value={tagDraft}
                            onChange={(e) => handleTagDraftChange(e.target.value)}
                            onKeyDown={handleTagDraftKeyDown}
                            onFocus={() => setTagInputFocused(true)}
                            onBlur={() => window.setTimeout(() => setTagInputFocused(false), 120)}
                            disabled={!isOwner || tags.length >= MAX_DISCOVERY_TAGS}
                            placeholder={tags.length === 0 ? t('serverSettings.tagsPlaceholder') : ''}
                            className="min-w-32 flex-1 bg-transparent px-1 py-0.5 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
                          />
                        </div>
                        {tagInputFocused && canAutocompleteTag && availableTagSuggestions.length > 0 && (
                          <div className="absolute z-20 mt-1 max-h-44 w-full overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
                            {availableTagSuggestions.map((suggestion) => (
                              <button
                                key={suggestion}
                                type="button"
                                className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                                onMouseDown={(event) => {
                                  event.preventDefault()
                                  addDiscoveryTag(suggestion)
                                }}
                              >
                                {suggestion}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <p className={cn(
                        'text-xs',
                        tagDraftInvalid ? 'text-destructive' : 'text-muted-foreground',
                      )}>
                        {tagDraftInvalid
                          ? t('serverSettings.tagsInvalid', { tags: normalizedTagDraft })
                          : t('serverSettings.tagsHint')}
                      </p>
                    </div>
                  </div>
                )}

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

                <div className="space-y-2">
                  <Label>{t('serverSettings.systemChannelLabel')}</Label>
                  <p className="text-xs text-muted-foreground">{t('serverSettings.systemChannelDesc')}</p>
                  <Select
                    value={systemChannelId || '__none__'}
                    onValueChange={(v) => setSystemChannelId(v === '__none__' ? '' : v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{t('serverSettings.systemChannelNone')}</SelectItem>
                      {textChannels.map((ch) => (
                        <SelectItem key={String(ch.id)} value={String(ch.id)}>
                          # {ch.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex justify-end pt-2">
                  <Button
                    onClick={() => void handleSaveOverview()}
                    disabled={savingOverview || !overviewChanged || nextDiscoveryTags.invalid.length > 0}
                  >
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
                    const targetPermissions = createPermissionChecker({
                      currentUser: member.user,
                      guild,
                      currentMember: member,
                      roles,
                    })
                    const isTargetAdmin = targetPermissions.isAdmin
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
                  'flex-1 min-w-0 flex flex-col overflow-hidden',
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
                    const selectedRoleMembers = isEveryoneSelected
                      ? []
                      : members.filter((member) => (member.roles ?? []).map(String).includes(selectedRoleId))
                    const normalizedMemberFilter = memberFilter.trim().toLowerCase()
                    const filteredRoleMembers = normalizedMemberFilter
                      ? selectedRoleMembers.filter((member) => {
                        const display = `${member.username ?? ''} ${member.user?.name ?? ''}`.toLowerCase()
                        return display.includes(normalizedMemberFilter)
                      })
                      : selectedRoleMembers
                    const tabs: { key: RoleSettingsTab; label: string; count?: number }[] = isEveryoneSelected
                      ? [{ key: 'permissions', label: t('serverSettings.roleTabPermissions') }]
                      : [
                        { key: 'display', label: t('serverSettings.roleTabDisplay') },
                        { key: 'permissions', label: t('serverSettings.roleTabPermissions') },
                        { key: 'members', label: t('serverSettings.roleTabMembers'), count: selectedRoleMembers.length },
                      ]
                    return (
                      <div className="flex h-full min-h-0 flex-col gap-6">
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

                        <div className="flex gap-2 border-b border-border">
                          {tabs.map((tab) => (
                            <button
                              key={tab.key}
                              type="button"
                              onClick={() => setRoleSettingsTab(tab.key)}
                              className={cn(
                                'px-1 pb-2 text-sm font-medium transition-colors border-b-2 -mb-px',
                                roleSettingsTab === tab.key
                                  ? 'border-primary text-foreground'
                                  : 'border-transparent text-muted-foreground hover:text-foreground',
                              )}
                            >
                              {tab.label}{tab.count !== undefined ? ` (${tab.count})` : ''}
                            </button>
                          ))}
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto pr-2 space-y-6">
                          {roleSettingsTab === 'display' && !isEveryoneSelected && (
                            <div className="space-y-6">
                              <div className="space-y-2">
                                <Label htmlFor="edit-role-name">{t('serverSettings.roleNameLabel')}</Label>
                                <Input
                                  id="edit-role-name"
                                  value={editName}
                                  onChange={(e) => setEditName(e.target.value)}
                                  placeholder={t('serverSettings.roleNamePlaceholder')}
                                />
                              </div>
                              <div className="space-y-2">
                                <Label>{t('serverSettings.colorLabel')}</Label>
                                <div className="flex items-center gap-3">
                                  <input
                                    type="color"
                                    value={editColor}
                                    onChange={(e) => setEditColor(e.target.value)}
                                    className="w-16 h-12 rounded border border-input cursor-pointer p-0.5 bg-background block"
                                    aria-label={t('serverSettings.roleColorTitle')}
                                  />
                                  <div className="rounded-lg border border-border bg-accent/20 px-4 py-3 flex-1 min-w-0">
                                    <p className="text-sm font-semibold truncate" style={{ color: editColor }}>
                                      {editName || t('serverSettings.roleNamePlaceholder')}
                                    </p>
                                    <p className="text-xs text-muted-foreground mt-0.5">{t('serverSettings.rolePreview')}</p>
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
                                <div>
                                  <p className="text-sm font-semibold">{t('serverSettings.roleHoistLabel')}</p>
                                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                                    {t('serverSettings.roleHoistDesc')}
                                  </p>
                                </div>
                                <Toggle value={editHoist} onToggle={() => setEditHoist((prev) => !prev)} />
                              </div>
                            </div>
                          )}

                          {roleSettingsTab === 'permissions' && (
                            <>
                              {isAdmin && (
                                <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-500">
                                  <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
                                  <p className="text-xs leading-relaxed">
                                    <strong>{t('serverSettings.adminWarningTitle')}</strong> {t('serverSettings.adminWarningDesc')}
                                  </p>
                                </div>
                              )}
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
                            </>
                          )}

                          {roleSettingsTab === 'members' && !isEveryoneSelected && (
                            <div className="space-y-4">
                              <Input
                                value={memberFilter}
                                onChange={(e) => setMemberFilter(e.target.value)}
                                placeholder={t('serverSettings.searchMembers')}
                              />
                              <div className="space-y-1">
                                {filteredRoleMembers.map((member) => {
                                  const userId = String(member.user?.id ?? '')
                                  const displayName = member.username ?? member.user?.name ?? 'Unknown'
                                  const isSaving = savingMemberRole === `${userId}:${selectedRoleId}`
                                  return (
                                    <div
                                      key={userId}
                                      className="flex items-center gap-3 rounded-md bg-accent/20 px-3 py-2"
                                    >
                                      <Avatar className="w-8 h-8">
                                        <AvatarImage src={member.user?.avatar?.url} alt={displayName} className="object-cover" />
                                        <AvatarFallback className="text-xs">{displayName.charAt(0).toUpperCase()}</AvatarFallback>
                                      </Avatar>
                                      <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-semibold">{displayName}</p>
                                        <p className="truncate text-xs text-muted-foreground">
                                          {member.user?.name ?? userId}
                                        </p>
                                      </div>
                                      <button
                                        type="button"
                                        disabled={isSaving}
                                        onClick={() => void toggleMemberRole(userId, selectedRoleId, true)}
                                        className="rounded-full p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-50"
                                        aria-label={t('serverSettings.removeRoleMember')}
                                      >
                                        <X className="w-4 h-4" />
                                      </button>
                                    </div>
                                  )
                                })}
                                {filteredRoleMembers.length === 0 && (
                                  <p className="text-sm text-muted-foreground text-center py-10">
                                    {t('serverSettings.noRoleMembers')}
                                  </p>
                                )}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Save row */}
                        <div className="shrink-0 flex items-center justify-between pt-4 border-t border-border bg-background">
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
                    const oneYearFromNow = new Date(); oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1)
                    const isNever = !expiresDate || expiresDate > oneYearFromNow
                    const expiresLabel = isNever
                      ? t('serverSettings.inviteNeverExpires')
                      : isExpired ? t('serverSettings.inviteExpired') : expiresDate.toLocaleDateString()
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
                            {t('serverSettings.inviteCreatedAt')} {createdAt} · {isExpired ? t('serverSettings.inviteExpired') : isNever ? expiresLabel : `${t('serverSettings.inviteExpires')} ${expiresLabel}`}
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
                          aria-label={t('serverSettings.copyInviteLink')}
                        >
                          <Copy className="w-4 h-4" />
                        </button>
                        {/* Revoke */}
                        <button
                          onClick={() => void handleRevokeInvite(inviteId)}
                          className="p-1.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors shrink-0"
                          aria-label={t('serverSettings.revokeInvite')}
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
                <div>
                  <h2 className="text-xl font-bold flex items-center gap-2">
                    <Smile className="w-5 h-5" />
                    {t('serverSettings.emojiTitle')}
                  </h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t('serverSettings.emojiDesc')}
                  </p>
                </div>

                {/* Upload form */}
                {canUploadEmoji && (
                  <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                    <div>
                      <p className="text-sm font-semibold">{t('serverSettings.uploadEmoji')}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{t('serverSettings.emojiLimits')}</p>
                    </div>

                    <div className="flex gap-4 items-start">
                      {/* Clickable file preview zone */}
                      <button
                        type="button"
                        onClick={() => emojiFileRef.current?.click()}
                        className={cn(
                          'w-20 h-20 rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-1 transition-all shrink-0 overflow-hidden',
                          emojiPreviewUrl
                            ? 'border-primary/40 bg-muted/20 hover:brightness-90'
                            : 'border-border hover:border-primary/50 bg-muted/30 hover:bg-muted/50',
                        )}
                        aria-label={t('serverSettings.emojiSelectFile')}
                      >
                        {emojiPreviewUrl ? (
                          <img src={emojiPreviewUrl} className="w-full h-full object-contain" alt="" />
                        ) : (
                          <>
                            <ImagePlus className="w-6 h-6 text-muted-foreground" />
                            <span className="text-[10px] text-muted-foreground leading-tight text-center px-1">
                              {t('serverSettings.emojiSelectFile')}
                            </span>
                          </>
                        )}
                      </button>

                      {/* Name + upload button */}
                      <div className="flex-1 space-y-3">
                        <div className="space-y-1">
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
                        <Button
                          size="sm"
                          className="gap-2"
                          onClick={() => void handleUploadEmoji()}
                          disabled={uploadingEmoji || !emojiName.trim() || !emojiFile}
                        >
                          <Upload className="w-3.5 h-3.5" />
                          {uploadingEmoji ? t('serverSettings.uploading') : t('serverSettings.upload')}
                        </Button>
                      </div>
                    </div>

                    {/* Hidden file input */}
                    <input
                      ref={emojiFileRef}
                      type="file"
                      accept="image/png,image/gif,image/webp,image/jpeg"
                      className="hidden"
                      onChange={(e) => void handleEmojiFileChange(e)}
                    />
                  </div>
                )}

                {/* Emoji list — Static & Animated */}
                {(() => {
                  const staticEmojis = guildEmojis.filter((e) => !e.animated)
                  const animatedEmojis = guildEmojis.filter((e) => e.animated)

                  const renderEmojiCard = (emoji: DtoGuildEmoji) => {
                    const eid = String(emoji.id)
                    const isEditing = editingEmojiId === eid
                    const isDeleting = deletingEmojiId === eid
                    const isSaving = savingEmojiId === eid
                    return (
                      <div
                        key={eid}
                        className={cn(
                          isEditing
                            ? 'relative col-span-full sm:col-span-2 lg:col-span-3 flex items-center gap-3 rounded-lg border border-primary/40 bg-accent/30 p-3 shadow-sm'
                            : 'relative group flex min-w-0 flex-col items-center gap-2 rounded-lg border border-transparent bg-card/20 p-2.5 transition-all hover:border-border hover:bg-accent/40',
                          isDeleting && 'opacity-40 pointer-events-none',
                        )}
                      >
                        <div className={cn(
                          'flex shrink-0 items-center justify-center rounded-md bg-background/70 ring-1 ring-border/70',
                          isEditing ? 'h-16 w-16' : 'h-12 w-12',
                        )}>
                          <img
                            src={emojiUrl(eid, 96)}
                            alt={emoji.name}
                            className={cn('object-contain', isEditing ? 'h-12 w-12' : 'h-9 w-9')}
                          />
                        </div>
                        {isEditing ? (
                          <>
                            <div className="min-w-0 flex-1 space-y-1">
                              <Label className="text-xs text-muted-foreground">{t('serverSettings.emojiNameLabel')}</Label>
                              <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
                                <span className="pl-3 text-sm font-mono text-muted-foreground">:</span>
                                <input
                                  value={editingEmojiName}
                                  onChange={(e) => setEditingEmojiName(e.target.value.replace(/[^A-Za-z0-9-]/g, ''))}
                                  className="h-9 min-w-0 flex-1 bg-transparent px-0 text-sm font-mono outline-none"
                                  maxLength={32}
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') void handleRenameEmoji(eid)
                                    if (e.key === 'Escape') setEditingEmojiId(null)
                                  }}
                                />
                                <span className="pr-3 text-sm font-mono text-muted-foreground">:</span>
                              </div>
                              <p className="text-[11px] text-muted-foreground truncate">:{emoji.name}:</p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                size="sm"
                                className="h-8 w-8 p-0"
                                onClick={() => void handleRenameEmoji(eid)}
                                disabled={isSaving || !editingEmojiName.trim()}
                                aria-label={t('common.save')}
                              >
                                <Check className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 w-8 p-0"
                                onClick={() => setEditingEmojiId(null)}
                                aria-label={t('common.cancel')}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          </>
                        ) : (
                          <span className="w-full truncate text-center font-mono text-[11px] leading-tight text-muted-foreground">
                            :{emoji.name}:
                          </span>
                        )}
                        {canManageEmoji && !isEditing && (
                          <div className="absolute -bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 overflow-hidden rounded-lg border border-white/[0.1] bg-[#0f1015] shadow-sm opacity-0 transition-opacity group-hover:opacity-100">
                            <button
                              onClick={() => { setEditingEmojiId(eid); setEditingEmojiName(emoji.name ?? '') }}
                              className="flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-foreground"
                              aria-label={t('serverSettings.emojiRename')}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <div className="h-3.5 w-px bg-border" />
                            <button
                              onClick={() => void handleDeleteEmoji(eid)}
                              disabled={isDeleting}
                              className="flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                              aria-label={t('serverSettings.emojiDeleteBtn')}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  }

                  const renderEmptyState = (label: string, hint: string) => (
                    <div className="flex flex-col items-center justify-center py-10 rounded-xl border border-dashed border-border text-muted-foreground gap-2">
                      <Smile className="w-8 h-8 opacity-20" />
                      <p className="text-sm">{label}</p>
                      {canUploadEmoji && <p className="text-xs opacity-60">{hint}</p>}
                    </div>
                  )

                  return (
                    <div className="space-y-6">
                      {/* Static */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-semibold">{t('serverSettings.emojiStaticSection', { count: staticEmojis.length })}</p>
                        </div>
                        {staticEmojis.length === 0
                          ? renderEmptyState(t('serverSettings.emojiNoStatic'), t('serverSettings.emojiUploadHintStatic'))
                          : <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">{staticEmojis.map(renderEmojiCard)}</div>
                        }
                      </div>

                      {/* Animated */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-semibold">{t('serverSettings.emojiAnimatedSection', { count: animatedEmojis.length })}</p>
                        </div>
                        {animatedEmojis.length === 0
                          ? renderEmptyState(t('serverSettings.emojiNoAnimated'), t('serverSettings.emojiUploadHintAnimated'))
                          : <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">{animatedEmojis.map(renderEmojiCard)}</div>
                        }
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
