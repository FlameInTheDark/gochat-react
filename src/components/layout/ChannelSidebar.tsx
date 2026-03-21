import { useState, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Hash, Volume2, MicOff, HeadphoneOff, Trash2, UserPlus, FolderPlus, Plus, GripVertical, Copy, Settings, User, MessageSquare, Eye } from 'lucide-react'
import { toast } from 'sonner'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { useUiStore } from '@/stores/uiStore'
import { useUnreadStore } from '@/stores/unreadStore'
import { useMentionStore } from '@/stores/mentionStore'
import { useAuthStore } from '@/stores/authStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { usePresenceStore } from '@/stores/presenceStore'
import { guildApi, rolesApi, userApi } from '@/api/client'
import { setPeerVolume } from '@/services/voiceService'
import { ChannelType } from '@/types'
import type { DtoChannel, DtoGuild } from '@/types'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import VoicePanel from '@/components/voice/VoicePanel'
import { joinVoice } from '@/services/voiceService'
import UserArea from './UserArea'
import { hasPermission, calculateEffectivePermissions, PermissionBits } from '@/lib/permissions'
import type { DtoRole, DtoMember } from '@/client'

interface Props {
  channels: DtoChannel[]
  serverId: string
}

export default function ChannelSidebar({ channels, serverId }: Props) {
  const navigate = useNavigate()
  const { channelId: activeChannelId } = useParams<{ channelId?: string }>()
  const queryClient = useQueryClient()

  // Resolve server name from the already-cached guilds list (no extra request)
  const serverName =
    queryClient.getQueryData<DtoGuild[]>(['guilds'])?.find((g) => String(g.id) === serverId)?.name
    ?? 'Server'

  const { t } = useTranslation()

  const openCreateChannel = useUiStore((s) => s.openCreateChannel)
  const openCreateCategory = useUiStore((s) => s.openCreateCategory)
  const openInviteModal = useUiStore((s) => s.openInviteModal)
  const openServerSettings = useUiStore((s) => s.openServerSettings)
  const openChannelSettings = useUiStore((s) => s.openChannelSettings)

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [deletingChannel, setDeletingChannel] = useState<DtoChannel | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  // Current user and permissions
  const currentUser = useAuthStore((s) => s.user)
  const { data: members } = useQuery({
    queryKey: ['members', serverId],
    queryFn: () => guildApi.guildGuildIdMembersGet({ guildId: serverId }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: 30_000,
  })
  const { data: roles } = useQuery({
    queryKey: ['roles', serverId],
    queryFn: () => rolesApi.guildGuildIdRolesGet({ guildId: serverId }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: 60_000,
  })

  // Resolve guild data for owner check
  const guild = queryClient.getQueryData<DtoGuild[]>(['guilds'])?.find((g) => String(g.id) === serverId)
  const isOwner = guild?.owner != null && currentUser?.id !== undefined && String(guild.owner) === String(currentUser.id)

  const currentMember = members?.find((m) => m.user?.id === currentUser?.id)
  const effectivePermissions = currentMember && roles
    ? calculateEffectivePermissions(currentMember as DtoMember, roles as DtoRole[])
    : 0
  const isAdmin = hasPermission(effectivePermissions, PermissionBits.ADMINISTRATOR)
  const canManageServer = isOwner || hasPermission(effectivePermissions, PermissionBits.MANAGE_SERVER) || isAdmin
  const canManageChannels = isOwner || hasPermission(effectivePermissions, PermissionBits.MANAGE_CHANNELS) || isAdmin
  const canCreateInvites = isOwner || hasPermission(effectivePermissions, PermissionBits.CREATE_INVITES) || isAdmin

  // Inline rename state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  // Drag state
  const dragRef = useRef<{ channel: DtoChannel } | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropIndicator, setDropIndicator] = useState<{ id: string; before: boolean } | null>(null)

  // Derived channel groups (re-computed each render from prop)
  const isCat = (ch: DtoChannel) => ch.type === ChannelType.ChannelTypeGuildCategory
  const isRegular = (ch: DtoChannel) =>
    ch.type === ChannelType.ChannelTypeGuild || ch.type === ChannelType.ChannelTypeGuildVoice
  const sorted = (arr: DtoChannel[]) => [...arr].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))

  // Channel visibility: owners and admins see everything; for private channels,
  // the user must have at least one role listed in channel.roles.
  const memberRoleIds = new Set((currentMember?.roles ?? []).map(String))
  function canViewChannel(ch: DtoChannel): boolean {
    if (isOwner || isAdmin) return true
    if (!ch.private) return true
    return (ch.roles ?? []).some((r) => memberRoleIds.has(String(r)))
  }

  const categoryIds = new Set(channels.filter(isCat).map((c) => String(c.id)))
  const allCategories = sorted(channels.filter(isCat))
  // Visible categories: only those the user can see
  const categories = allCategories.filter(canViewChannel)
  const visibleCategoryIds = new Set(categories.map((c) => String(c.id)))

  const allRegular = channels.filter(isRegular)
  // Visible regular channels: must pass own access check, and if inside a category,
  // that category must also be visible (a private inaccessible category hides its children).
  const visibleRegular = allRegular.filter((ch) => {
    if (!canViewChannel(ch)) return false
    const parentId = ch.parent_id ? String(ch.parent_id) : null
    if (parentId && categoryIds.has(parentId) && !visibleCategoryIds.has(parentId)) return false
    return true
  })

  const uncategorized = sorted(
    visibleRegular.filter((c) => !c.parent_id || !categoryIds.has(String(c.parent_id))),
  )


  const isDeletingCategory = deletingChannel?.type === ChannelType.ChannelTypeGuildCategory

  function toggleCategory(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleDeleteChannel() {
    if (!deletingChannel) return
    setDeleteLoading(true)
    try {
      await guildApi.guildGuildIdChannelChannelIdDelete({
        guildId: serverId,
        channelId: String(deletingChannel.id),
      })
      await queryClient.invalidateQueries({ queryKey: ['channels', serverId] })
      if (String(deletingChannel.id) === activeChannelId) {
        navigate(`/app/${serverId}`)
      }
    } finally {
      setDeleteLoading(false)
      setDeletingChannel(null)
    }
  }

  async function saveEdit(channel: DtoChannel) {
    const name = editingName.trim()
    setEditingId(null)
    if (!name || name === channel.name) return
    try {
      await guildApi.guildGuildIdChannelChannelIdPatch({
        guildId: serverId,
        channelId: String(channel.id),
        req: { name },
      })
      await queryClient.invalidateQueries({ queryKey: ['channels', serverId] })
    } catch {
      toast.error(t('channelSidebar.renameFailed'))
    }
  }

  function cancelEdit() {
    setEditingId(null)
  }

  // Check if already connected to a voice channel
  const currentVoiceChannelId = useVoiceStore((s) => s.channelId)

  async function handleVoiceJoin(channel: DtoChannel) {
    const channelId = String(channel.id)

    // If already connected to this channel, just navigate without rejoining
    if (currentVoiceChannelId === channelId) {
      navigate(`/app/${serverId}/${channelId}`)
      return
    }

    try {
      const res = await guildApi.guildGuildIdVoiceChannelIdJoinPost({
        guildId: serverId,
        channelId,
      })
      if (res.data.sfu_url && res.data.sfu_token) {
        await joinVoice(serverId, channelId, channel.name ?? channelId, res.data.sfu_url, res.data.sfu_token)
      }
    } catch {
      toast.error(t('channelSidebar.joinVoiceFailed'))
    }
    navigate(`/app/${serverId}/${channelId}`)
  }

  // ── Drag & drop ─────────────────────────────────────────────────────────────

  function onDragStart(e: React.DragEvent, channel: DtoChannel) {
    dragRef.current = { channel }
    setDraggingId(String(channel.id))
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(channel.id))
  }

  function onDragOver(e: React.DragEvent, target: DtoChannel) {
    const drag = dragRef.current
    if (!drag) return
    if (String(drag.channel.id) === String(target.id)) return

    if (isCat(drag.channel)) {
      if (isCat(target)) {
        // ── Hovering over a category header ──────────────────────────────────
        const catId = String(target.id)
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const topHalf = e.clientY < rect.top + rect.height / 2

        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'

        if (topHalf) {
          // Before this category
          setDropIndicator((prev) =>
            prev?.id === catId && prev.before ? prev : { id: catId, before: true },
          )
        } else {
          // After this entire category block — pin indicator to last visible child
          // (or to the category header itself if collapsed / no children)
          const isCollapsedCat = collapsed.has(catId)
          const children = sorted(allRegular.filter((c) => String(c.parent_id) === catId))
          if (!isCollapsedCat && children.length > 0) {
            const lastId = String(children[children.length - 1].id)
            setDropIndicator((prev) =>
              prev?.id === lastId && !prev.before ? prev : { id: lastId, before: false },
            )
          } else {
            setDropIndicator((prev) =>
              prev?.id === catId && !prev.before ? prev : { id: catId, before: false },
            )
          }
        }
      } else {
        // ── Hovering over a child channel ─────────────────────────────────────
        // Always redirect to the last child of that category (bottom indicator).
        const parentId = target.parent_id ? String(target.parent_id) : null
        if (!parentId || !categoryIds.has(parentId)) return   // uncategorized — block
        if (parentId === String(drag.channel.id)) return       // own children — block

        const children = sorted(allRegular.filter((c) => String(c.parent_id) === parentId))
        const lastChild = children[children.length - 1]
        if (!lastChild) return

        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const lastId = String(lastChild.id)
        setDropIndicator((prev) =>
          prev?.id === lastId && !prev.before ? prev : { id: lastId, before: false },
        )
      }
      return
    }

    // ── Regular channel drag ─────────────────────────────────────────────────
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2
    const id = String(target.id)
    setDropIndicator((prev) => (prev?.id === id && prev.before === before ? prev : { id, before }))
  }

  function onDragEnd() {
    dragRef.current = null
    setDraggingId(null)
    setDropIndicator(null)
  }

  function onDrop(e: React.DragEvent, target: DtoChannel) {
    e.preventDefault()
    const drag = dragRef.current
    if (!drag) return
    if (String(drag.channel.id) === String(target.id)) { onDragEnd(); return }

    if (isCat(drag.channel)) {
      // For category drops, dropIndicator is the source of truth (it's what the user saw).
      const indicator = dropIndicator
      if (!indicator) { onDragEnd(); return }

      const indicatorItem = channels.find((c) => String(c.id) === indicator.id)
      if (!indicatorItem) { onDragEnd(); return }

      const dragged = drag.channel
      onDragEnd()

      if (isCat(indicatorItem)) {
        // Top or bottom of a category header
        void applyDrop(dragged, indicatorItem, indicator.before)
      } else {
        // Bottom of the last child → "after its parent category"
        const parentId = String(indicatorItem.parent_id)
        const parentCat = channels.find((c) => String(c.id) === parentId)
        if (parentCat) void applyDrop(dragged, parentCat, false)
      }
      return
    }

    // ── Regular channel drop ────────────────────────────────────────────────
    const before = dropIndicator?.before ?? false
    const dragged = drag.channel
    onDragEnd()
    void applyDrop(dragged, target, before)
  }

  /**
   * Unified drop handler — builds the new full flat visual order, updates
   * the query cache optimistically, then fires the order API.
   *
   * Rule for new parent_id of a moved channel:
   *   Walk backward from the insertion point in the flat list.
   *   The first category header found = new parent.
   *   No category above = uncategorized (parent_id = undefined).
   */
  async function applyDrop(dragged: DtoChannel, target: DtoChannel, insertBefore: boolean) {
    // Build flat list in exact position order (matches render), without the dragged channel
    const flat = sorted([...allRegular, ...allCategories])
      .filter((c) => String(c.id) !== String(dragged.id))

    const tIdx = flat.findIndex((c) => String(c.id) === String(target.id))
    if (tIdx === -1) return

    // When inserting after a category header, skip past all its children so the
    // dragged item lands after the entire category block.
    let insertIdx: number
    if (!insertBefore && isCat(target)) {
      const catId = String(target.id)
      let lastIdx = tIdx
      for (let i = tIdx + 1; i < flat.length; i++) {
        if (flat[i].parent_id && String(flat[i].parent_id) === catId) lastIdx = i
      }
      insertIdx = lastIdx + 1
    } else {
      insertIdx = insertBefore ? tIdx : tIdx + 1
    }

    flat.splice(insertIdx, 0, dragged)

    // For regular channels: determine new parent from nearest preceding category header
    if (!isCat(dragged)) {
      let newParentId: number | undefined = undefined
      for (let i = insertIdx - 1; i >= 0; i--) {
        if (isCat(flat[i])) {
          newParentId = flat[i].id as unknown as number
          break
        }
      }
      flat[insertIdx] = { ...dragged, parent_id: newParentId }
    }

    await commitOrder(flat)
  }

  async function commitOrder(globalOrder: DtoChannel[]) {
    const channelUpdates = globalOrder.map((ch, idx) => ({
      id: ch.id as unknown as number,
      position: idx,
    }))

    // Optimistic: update positions (and parent_ids) immediately in the cache
    queryClient.setQueryData(
      ['channels', serverId],
      () => globalOrder.map((ch, idx) => ({ ...ch, position: idx })),
    )

    try {
      await guildApi.guildGuildIdChannelOrderPatch({
        guildId: serverId,
        request: { channels: channelUpdates },
      })
    } catch {
      toast.error(t('channelSidebar.reorderFailed'))
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['channels', serverId] })
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="flex flex-col w-60 bg-sidebar border-r border-sidebar-border shrink-0">
        {/* Server name header — left-click opens dropdown, right-click opens context menu */}
        <ContextMenu>
          <DropdownMenu>
            <ContextMenuTrigger asChild>
              <DropdownMenuTrigger asChild>
                <div className="h-12 flex items-center px-4 font-semibold border-b border-sidebar-border shrink-0 cursor-pointer select-none hover:bg-accent/30 transition-colors group">
                  <span className="flex-1 truncate">{serverName}</span>
                  <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                </div>
              </DropdownMenuTrigger>
            </ContextMenuTrigger>

            <DropdownMenuContent className="w-56">
              {canManageServer && (
                <DropdownMenuItem onClick={() => openServerSettings(serverId)} className="gap-2">
                  <Settings className="w-4 h-4" />
                  {t('channelSidebar.serverSettings')}
                </DropdownMenuItem>
              )}
              {canCreateInvites && (
                <DropdownMenuItem onClick={() => openInviteModal(serverId)} className="gap-2">
                  <UserPlus className="w-4 h-4" />
                  {t('channelSidebar.invitePeople')}
                </DropdownMenuItem>
              )}
              {(canManageServer || canManageChannels || canCreateInvites) && <DropdownMenuSeparator />}
              {canManageChannels && (
                <>
                  <DropdownMenuItem onClick={() => openCreateChannel(undefined, serverId)} className="gap-2">
                    <Hash className="w-4 h-4" />
                    {t('channelSidebar.newChannel')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openCreateCategory(serverId)} className="gap-2">
                    <FolderPlus className="w-4 h-4" />
                    {t('channelSidebar.newCategory')}
                  </DropdownMenuItem>
                </>
              )}
              {!canManageServer && !canManageChannels && !canCreateInvites && (
                <DropdownMenuItem onClick={() => { void navigator.clipboard.writeText(serverId) }} className="gap-2">
                  <Copy className="w-4 h-4" />
                  {t('channelSidebar.copyServerId')}
                </DropdownMenuItem>
              )}
              {(canManageServer || canManageChannels || canCreateInvites) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => { void navigator.clipboard.writeText(serverId) }} className="gap-2">
                    <Copy className="w-4 h-4" />
                    {t('channelSidebar.copyServerId')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <ContextMenuContent className="w-56">
            {canManageServer && (
              <>
                <ContextMenuItem onClick={() => openServerSettings(serverId)} className="gap-2">
                  <Settings className="w-4 h-4" />
                  {t('channelSidebar.serverSettings')}
                </ContextMenuItem>
              </>
            )}
            {canCreateInvites && (
              <ContextMenuItem onClick={() => openInviteModal(serverId)} className="gap-2">
                <UserPlus className="w-4 h-4" />
                {t('channelSidebar.invitePeople')}
              </ContextMenuItem>
            )}
            {(canManageServer || canCreateInvites) && <ContextMenuSeparator />}
            {canManageChannels && (
              <>
                <ContextMenuItem onClick={() => openCreateChannel(undefined, serverId)} className="gap-2">
                  <Hash className="w-4 h-4" />
                  {t('channelSidebar.newChannel')}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => openCreateCategory(serverId)} className="gap-2">
                  <FolderPlus className="w-4 h-4" />
                  {t('channelSidebar.newCategory')}
                </ContextMenuItem>
              </>
            )}
            {(canManageServer || canManageChannels || canCreateInvites) && <ContextMenuSeparator />}
            <ContextMenuItem onClick={() => { void navigator.clipboard.writeText(serverId) }} className="gap-2">
              <Copy className="w-4 h-4" />
              {t('channelSidebar.copyServerId')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {/* Channel list */}
        <ContextMenu>
          <ContextMenuTrigger
            className="flex-1 overflow-hidden flex flex-col"
            onDrop={(e) => e.preventDefault()}
          >
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-0.5">
                {/* All channels in exact API position order */}
                {sorted([...visibleRegular, ...categories]).map((item) => {
                  if (!isCat(item)) {
                    const ch = item
                    const parentId = ch.parent_id ? String(ch.parent_id) : null
                    if (parentId && categoryIds.has(parentId) && collapsed.has(parentId)) return null
                    return (
                      <ChannelItemWithUnread
                        key={String(ch.id)}
                        channel={ch}
                        serverId={serverId}
                        isActive={String(ch.id) === activeChannelId}
                        navigate={navigate}
                        onDelete={setDeletingChannel}
                        onVoiceJoin={handleVoiceJoin}
                        onOpenSettings={() => openChannelSettings(serverId, String(ch.id))}
                        isDragging={draggingId === String(ch.id)}
                        dropIndicator={
                          dropIndicator?.id === String(ch.id)
                            ? dropIndicator.before ? 'top' : 'bottom'
                            : null
                        }
                        onDragStart={(e) => onDragStart(e, ch)}
                        onDragOver={(e) => onDragOver(e, ch)}
                        onDrop={(e) => onDrop(e, ch)}
                        onDragEnd={onDragEnd}
                        isEditing={editingId === String(ch.id)}
                        editName={editingName}
                        onEditChange={setEditingName}
                        onEditSave={() => saveEdit(ch)}
                        onEditCancel={cancelEdit}
                        canManageChannels={canManageChannels}
                        members={members}
                      />
                    )
                  }

                  const cat = item
                  const catId = String(cat.id)
                  const isCollapsed = collapsed.has(catId)
                  const catIndicator =
                    dropIndicator?.id === catId
                      ? dropIndicator.before ? 'top' : 'bottom'
                      : null
                  const isCatEditing = editingId === catId

                  return (
                    <div key={catId}>
                      {/* Category header */}
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <button
                            draggable={!isCatEditing}
                            onDragStart={(e) => onDragStart(e, cat)}
                            onDragOver={(e) => onDragOver(e, cat)}
                            onDrop={(e) => onDrop(e, cat)}
                            onDragEnd={onDragEnd}
                            onClick={() => !isCatEditing && toggleCategory(catId)}
                            className={cn(
                              'w-full flex items-center gap-1 px-1 pt-4 pb-0.5 text-xs font-semibold uppercase text-muted-foreground hover:text-foreground tracking-wider group/cat cursor-pointer select-none',
                              draggingId === catId && 'opacity-40',
                              catIndicator === 'top' && 'border-t-2 border-primary',
                              catIndicator === 'bottom' && 'border-b-2 border-primary',
                            )}
                          >
                            <span className="cursor-grab active:cursor-grabbing shrink-0">
                              <GripVertical className="w-3 h-3 opacity-0 group-hover/cat:opacity-40 -ml-1" />
                            </span>
                            {isCollapsed
                              ? <ChevronRight className="w-3 h-3 shrink-0" />
                              : <ChevronDown className="w-3 h-3 shrink-0" />}
                            {isCatEditing ? (
                              <input
                                autoFocus
                                value={editingName}
                                onChange={(e) => setEditingName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') void saveEdit(cat)
                                  if (e.key === 'Escape') cancelEdit()
                                }}
                                onBlur={() => void saveEdit(cat)}
                                onClick={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                                className="flex-1 min-w-0 bg-background border border-primary rounded-sm px-1 outline-none text-foreground normal-case tracking-normal font-medium cursor-text"
                              />
                            ) : (
                              <span className="truncate flex-1 text-left">{cat.name}</span>
                            )}
                          </button>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          {canManageChannels && (
                            <>
                              <ContextMenuItem
                                onClick={() => openChannelSettings(serverId, catId)}
                                className="gap-2"
                              >
                                <Settings className="w-4 h-4" />
                                {t('channelSidebar.editCategory')}
                              </ContextMenuItem>
                              <ContextMenuItem
                                onClick={() => openCreateChannel(catId, serverId)}
                                className="gap-2"
                              >
                                <Plus className="w-4 h-4" />
                                {t('channelSidebar.addChannel')}
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                            </>
                          )}
                          <ContextMenuItem
                            onClick={() => { void navigator.clipboard.writeText(catId) }}
                            className="gap-2"
                          >
                            <Copy className="w-4 h-4" />
                            {t('channelSidebar.copyCategoryId')}
                          </ContextMenuItem>
                          {canManageChannels && (
                            <>
                              <ContextMenuSeparator />
                              <ContextMenuItem
                                onClick={() => setDeletingChannel(cat)}
                                className="text-destructive focus:text-destructive gap-2"
                              >
                                <Trash2 className="w-4 h-4" />
                                {t('channelSidebar.deleteCategory')}
                              </ContextMenuItem>
                            </>
                          )}
                        </ContextMenuContent>
                      </ContextMenu>

                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          </ContextMenuTrigger>
          <ContextMenuContent>
            {canManageChannels && (
              <>
                <ContextMenuItem onClick={() => openCreateChannel(undefined, serverId)} className="gap-2">
                  <Hash className="w-4 h-4" />
                  {t('channelSidebar.newChannel')}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => openCreateCategory(serverId)} className="gap-2">
                  <FolderPlus className="w-4 h-4" />
                  {t('channelSidebar.newCategory')}
                </ContextMenuItem>
              </>
            )}
            {!canManageChannels && (
              <ContextMenuItem onClick={() => { void navigator.clipboard.writeText(serverId) }} className="gap-2">
                <Copy className="w-4 h-4" />
                {t('channelSidebar.copyServerId')}
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        </ContextMenu>

        {/* Voice status panel (visible when connected to voice) */}
        <VoicePanel />

        <Separator />
        <div className="px-2 py-2">
          <UserArea />
        </div>
      </div>

      {/* Delete channel / category confirmation dialog */}
      <Dialog open={!!deletingChannel} onOpenChange={(o) => !o && setDeletingChannel(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isDeletingCategory ? t('channelSidebar.deleteCategoryTitle') : t('channelSidebar.deleteChannelTitle')}</DialogTitle>
            <DialogDescription>
              {isDeletingCategory
                ? <>{t('channelSidebar.deleteCategoryDesc', { name: deletingChannel?.name })}</>
                : <>{t('channelSidebar.deleteChannelDesc', { name: deletingChannel?.name })}</>
              }
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingChannel(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDeleteChannel} disabled={deleteLoading}>
              {isDeletingCategory ? t('channelSidebar.deleteCategory') : t('channelSidebar.deleteChannel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// Thin wrapper that reads the unread state, mention count, and voice channel users from Zustand
function ChannelItemWithUnread(props: Omit<ChannelItemProps, 'isUnread' | 'mentionCount' | 'voiceUsers'>) {
  const isUnread = useUnreadStore((s) => s.channels.has(String(props.channel.id)))
  const mentionCount = useMentionStore((s) => s.getChannelMentionCount(String(props.channel.id)))
  const isVoice = props.channel.type === ChannelType.ChannelTypeGuildVoice
  const channelId = String(props.channel.id)
  // Get the raw array reference from store
  const voiceUsers = usePresenceStore((s) =>
    isVoice ? s.voiceChannelUsers[channelId] : undefined,
  )
  return <ChannelItem {...props} isUnread={isUnread} mentionCount={mentionCount} voiceUsers={voiceUsers} />
}

interface ChannelItemProps {
  channel: DtoChannel
  serverId: string
  isActive: boolean
  isUnread: boolean
  mentionCount: number
  navigate: (path: string) => void
  onDelete: (ch: DtoChannel) => void
  onVoiceJoin: (ch: DtoChannel) => void
  onOpenSettings: () => void
  isDragging: boolean
  dropIndicator: 'top' | 'bottom' | null
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
  isEditing: boolean
  editName: string
  onEditChange: (value: string) => void
  onEditSave: () => void
  onEditCancel: () => void
  canManageChannels: boolean
  voiceUsers?: { userId: string; username: string; avatarUrl?: string; muted?: boolean; deafened?: boolean }[]
  members?: { user?: { id?: string | number; name?: string; avatar?: { url?: string } }; username?: string }[] | undefined
}

function ChannelItem({
  channel,
  serverId,
  isActive,
  isUnread,
  mentionCount,
  navigate,
  onDelete,
  onVoiceJoin,
  onOpenSettings,
  isDragging,
  dropIndicator,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isEditing,
  editName,
  onEditChange,
  onEditSave,
  onEditCancel,
  canManageChannels,
  voiceUsers,
  members,
}: ChannelItemProps) {
  const { t } = useTranslation()
  const isVoice = channel.type === ChannelType.ChannelTypeGuildVoice
  const Icon = isVoice ? Volume2 : Hash
  const hasVoiceUsers = isVoice && voiceUsers && voiceUsers.length > 0

  // Resolve voice user display info from members data
  const resolvedVoiceUsers: {
    userId: string
    username: string
    avatarUrl?: string
    muted?: boolean
    deafened?: boolean
  }[] | undefined = voiceUsers?.map((voiceUser) => {
    const member = members?.find((m) => String(m.user?.id) === voiceUser.userId)
    return {
      userId: voiceUser.userId,
      username: member?.username ?? member?.user?.name ?? voiceUser.username,
      avatarUrl: member?.user?.avatar?.url ?? voiceUser.avatarUrl,
      muted: voiceUser.muted,
      deafened: voiceUser.deafened,
    }
  })

  function handleClick() {
    if (isEditing) return
    if (isVoice) {
      void onVoiceJoin(channel)
    } else {
      navigate(`/app/${serverId}/${String(channel.id)}`)
    }
  }

  return (
    <div className="w-full">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            draggable={!isEditing}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
            onClick={handleClick}
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1 rounded text-sm transition-colors text-left cursor-pointer select-none group/item',
              isActive
                ? 'bg-accent text-foreground'
                : isUnread
                  ? 'text-foreground font-medium hover:bg-accent/50'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
              isDragging && 'opacity-40',
              dropIndicator === 'top' && 'border-t-2 border-primary',
              dropIndicator === 'bottom' && 'border-b-2 border-primary',
            )}
          >
            <span className="cursor-grab active:cursor-grabbing shrink-0">
              <GripVertical className="w-3.5 h-3.5 opacity-0 group-hover/item:opacity-40 -ml-1" />
            </span>
            <Icon className={cn('w-4 h-4 shrink-0', hasVoiceUsers ? 'text-green-500 opacity-100' : 'opacity-70')} />
            {isEditing ? (
              <input
                autoFocus
                value={editName}
                onChange={(e) => onEditChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onEditSave()
                  if (e.key === 'Escape') onEditCancel()
                }}
                onBlur={onEditSave}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                className="flex-1 min-w-0 bg-background border border-primary rounded-sm px-1 outline-none text-sm cursor-text"
              />
            ) : (
              <>
                <span className="truncate flex-1">{channel.name}</span>
                {/* Mention badge (red, with count) takes priority over unread dot */}
                {mentionCount > 0 && !isActive && (
                  <span className="ml-auto shrink-0 min-w-[1.125rem] h-[1.125rem] rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center px-1 leading-none">
                    {mentionCount > 99 ? '99+' : mentionCount}
                  </span>
                )}
                {/* Unread dot — only when unread and no pending mentions */}
                {mentionCount === 0 && isUnread && !isActive && (
                  <span className="ml-auto shrink-0 w-2 h-2 rounded-full bg-foreground" />
                )}
              </>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {isVoice && (
            <>
              <ContextMenuItem
                onClick={() => navigate(`/app/${serverId}/${String(channel.id)}`)}
                className="gap-2"
              >
                <Eye className="w-4 h-4" />
                {t('channelSidebar.viewChannel')}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          {canManageChannels && (
            <>
              <ContextMenuItem onClick={onOpenSettings} className="gap-2">
                <Settings className="w-4 h-4" />
                {t('channelSidebar.editChannel')}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem
            onClick={() => { void navigator.clipboard.writeText(String(channel.id)) }}
            className="gap-2"
          >
            <Copy className="w-4 h-4" />
            {t('channelSidebar.copyChannelId')}
          </ContextMenuItem>
          {canManageChannels && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onDelete(channel)}
                className="text-destructive focus:text-destructive gap-2"
              >
                <Trash2 className="w-4 h-4" />
                {t('channelSidebar.deleteChannel')}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* Voice channel users */}
      {hasVoiceUsers && resolvedVoiceUsers && (
        <div className="ml-6 mt-0.5 space-y-0.5">
          {resolvedVoiceUsers.map((user) => (
            <VoiceChannelUserItem
              key={user.userId}
              user={user}
              serverId={serverId}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// Separate component for voice channel user with context menu
function VoiceChannelUserItem({
  user,
  serverId,
}: {
  user: { userId: string; username: string; avatarUrl?: string; muted?: boolean; deafened?: boolean }
  serverId: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const openUserProfile = useUiStore((s) => s.openUserProfile)
  const currentUser = useAuthStore((s) => s.user)
  const peerVolume = useVoiceStore((s) => s.peers[user.userId]?.volume ?? 100)
  const peerSpeaking = useVoiceStore((s) => s.peers[user.userId]?.speaking ?? false)
  const localSpeaking = useVoiceStore((s) => s.localSpeaking)
  const lastPosRef = useRef({ x: 0, y: 0 })
  const isCurrentUser = currentUser?.id !== undefined && String(currentUser.id) === user.userId
  const isSpeaking = isCurrentUser ? localSpeaking : peerSpeaking

  async function handleMessage() {
    try {
      const res = await userApi.userMeFriendsUserIdGet({ userId: user.userId })
      await queryClient.invalidateQueries({ queryKey: ['dm-channels'] })
      if (res.data.id !== undefined) navigate(`/app/@me/${String(res.data.id)}`)
    } catch {
      toast.error(t('memberList.dmFailed'))
    }
  }

  function handleVolumeChange(value: number[]) {
    const newVolume = value[0]
    setPeerVolume(user.userId, newVolume)
  }

  function handleContextMenu(e: React.MouseEvent) {
    lastPosRef.current = { x: e.clientX, y: e.clientY }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onContextMenu={handleContextMenu}
          className="flex items-center gap-2 px-2 py-1 rounded text-sm text-muted-foreground hover:text-foreground hover:bg-accent/30 cursor-pointer"
        >
          {/* Avatar wrapper — ring is outside overflow-hidden */}
          <div className={cn(
            'relative shrink-0 rounded-full transition-colors',
            isSpeaking && 'ring-2 ring-green-500 ring-offset-1 ring-offset-sidebar',
          )}>
            <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center overflow-hidden">
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt={user.username} className="w-full h-full object-cover" />
              ) : (
                <span className="text-[10px] font-medium">{user.username.charAt(0).toUpperCase()}</span>
              )}
            </div>
          </div>
          <span className="truncate text-xs flex-1">
            {user.username}
          </span>
          {/* Mute/Deafen icons on the right side */}
          <div className="flex items-center gap-1 shrink-0">
            {user.muted && <MicOff className="w-3 h-3 text-destructive" />}
            {user.deafened && <HeadphoneOff className="w-3 h-3 text-destructive" />}
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        {/* View Profile */}
        <ContextMenuItem
          onClick={() => openUserProfile(
            user.userId,
            serverId,
            lastPosRef.current.x,
            lastPosRef.current.y,
            user.username,
          )}
          className="gap-2"
        >
          <User className="w-4 h-4" />
          {t('memberList.viewProfile')}
        </ContextMenuItem>

        {/* Message - only show for other users */}
        {!isCurrentUser && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => void handleMessage()} className="gap-2">
              <MessageSquare className="w-4 h-4" />
              {t('memberList.message')}
            </ContextMenuItem>
          </>
        )}

        {/* Volume slider - only show for other users */}
        {!isCurrentUser && (
          <>
            <ContextMenuSeparator />
            <div className="px-2 py-1.5 min-w-[160px]">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-muted-foreground">{t('channelSidebar.volume')}</span>
                <span className="text-xs font-medium">{peerVolume}%</span>
              </div>
              <Slider
                value={[peerVolume]}
                onValueChange={handleVolumeChange}
                min={0}
                max={200}
                step={5}
                className="w-full"
              />
            </div>
          </>
        )}

        <ContextMenuItem
          onClick={() => { void navigator.clipboard.writeText(user.userId) }}
          className="gap-2"
        >
          <Copy className="w-4 h-4" />
          {t('memberList.copyUserId')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
