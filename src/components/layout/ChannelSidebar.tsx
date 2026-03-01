import { useState, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Hash, Volume2, Trash2, UserPlus, FolderPlus, Plus, GripVertical, Copy, Settings } from 'lucide-react'
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
import { useUiStore } from '@/stores/uiStore'
import { useUnreadStore } from '@/stores/unreadStore'
import { guildApi } from '@/api/client'
import { ChannelType } from '@/types'
import type { DtoChannel, DtoGuild } from '@/types'
import { cn } from '@/lib/utils'
import VoicePanel from '@/components/voice/VoicePanel'
import { joinVoice } from '@/services/voiceService'
import UserArea from './UserArea'

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

  const openCreateChannel   = useUiStore((s) => s.openCreateChannel)
  const openCreateCategory  = useUiStore((s) => s.openCreateCategory)
  const openInviteModal     = useUiStore((s) => s.openInviteModal)
  const openServerSettings  = useUiStore((s) => s.openServerSettings)
  const openChannelSettings = useUiStore((s) => s.openChannelSettings)

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [deletingChannel, setDeletingChannel] = useState<DtoChannel | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

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

  const categoryIds = new Set(channels.filter(isCat).map((c) => String(c.id)))
  const categories = sorted(channels.filter(isCat))
  const allRegular = channels.filter(isRegular)
  const uncategorized = sorted(
    allRegular.filter((c) => !c.parent_id || !categoryIds.has(String(c.parent_id))),
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
      toast.error('Failed to rename')
    }
  }

  function cancelEdit() {
    setEditingId(null)
  }

  async function handleVoiceJoin(channel: DtoChannel) {
    const channelId = String(channel.id)
    try {
      const res = await guildApi.guildGuildIdVoiceChannelIdJoinPost({
        guildId: serverId,
        channelId,
      })
      if (res.data.sfu_url && res.data.sfu_token) {
        await joinVoice(serverId, channelId, channel.name ?? channelId, res.data.sfu_url, res.data.sfu_token)
      }
    } catch {
      toast.error('Failed to join voice channel')
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
    if (isCat(dragged)) {
      // ── Category reorder ──────────────────────────────────────────────────
      const catsWithout = categories.filter((c) => String(c.id) !== String(dragged.id))
      const tIdx = catsWithout.findIndex((c) => String(c.id) === String(target.id))
      if (tIdx === -1) return
      catsWithout.splice(insertBefore ? tIdx : tIdx + 1, 0, dragged)

      // Rebuild: uncategorized → reordered categories (children follow their parent)
      const globalOrder: DtoChannel[] = [...uncategorized]
      for (const cat of catsWithout) {
        globalOrder.push(cat)
        globalOrder.push(...sorted(allRegular.filter((c) => String(c.parent_id) === String(cat.id))))
      }
      await commitOrder(globalOrder)
      return
    }

    // ── Channel reorder (same-section OR cross-section) ───────────────────
    // Build the flat visual order without the dragged channel
    const flat: DtoChannel[] = [
      ...uncategorized.filter((c) => String(c.id) !== String(dragged.id)),
    ]
    for (const cat of categories) {
      flat.push(cat)
      flat.push(
        ...sorted(
          allRegular.filter(
            (c) => String(c.parent_id) === String(cat.id) && String(c.id) !== String(dragged.id),
          ),
        ),
      )
    }

    // Locate target and insert
    const tIdx = flat.findIndex((c) => String(c.id) === String(target.id))
    if (tIdx === -1) return
    const insertIdx = insertBefore ? tIdx : tIdx + 1
    flat.splice(insertIdx, 0, dragged)

    // Determine new parent: last category seen before insertion point
    let newParentId: number | undefined = undefined
    for (let i = insertIdx - 1; i >= 0; i--) {
      if (isCat(flat[i])) {
        newParentId = flat[i].id as unknown as number
        break
      }
    }

    // Apply updated parent to the dragged channel in the flat list
    flat[insertIdx] = { ...dragged, parent_id: newParentId }

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
      toast.error('Failed to reorder channels')
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
              <DropdownMenuItem onClick={() => openServerSettings(serverId)} className="gap-2">
                <Settings className="w-4 h-4" />
                Server Settings
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openInviteModal(serverId)} className="gap-2">
                <UserPlus className="w-4 h-4" />
                Invite People
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => openCreateChannel(undefined, serverId)} className="gap-2">
                <Hash className="w-4 h-4" />
                New Channel
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openCreateCategory(serverId)} className="gap-2">
                <FolderPlus className="w-4 h-4" />
                New Category
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { void navigator.clipboard.writeText(serverId) }} className="gap-2">
                <Copy className="w-4 h-4" />
                Copy Server ID
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <ContextMenuContent className="w-56">
            <ContextMenuItem onClick={() => openServerSettings(serverId)} className="gap-2">
              <Settings className="w-4 h-4" />
              Server Settings
            </ContextMenuItem>
            <ContextMenuItem onClick={() => openInviteModal(serverId)} className="gap-2">
              <UserPlus className="w-4 h-4" />
              Invite People
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => openCreateChannel(undefined, serverId)} className="gap-2">
              <Hash className="w-4 h-4" />
              New Channel
            </ContextMenuItem>
            <ContextMenuItem onClick={() => openCreateCategory(serverId)} className="gap-2">
              <FolderPlus className="w-4 h-4" />
              New Category
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => { void navigator.clipboard.writeText(serverId) }} className="gap-2">
              <Copy className="w-4 h-4" />
              Copy Server ID
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
                {/* Uncategorized channels */}
                {uncategorized.map((ch) => (
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
                  />
                ))}

                {/* Categories with their children */}
                {categories.map((cat) => {
                  const catId = String(cat.id)
                  const isCollapsed = collapsed.has(catId)
                  const children = sorted(allRegular.filter((c) => String(c.parent_id) === catId))
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
                          <ContextMenuItem
                            onClick={() => openChannelSettings(serverId, catId)}
                            className="gap-2"
                          >
                            <Settings className="w-4 h-4" />
                            Edit Category
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() => openCreateChannel(catId, serverId)}
                            className="gap-2"
                          >
                            <Plus className="w-4 h-4" />
                            Add Channel
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onClick={() => { void navigator.clipboard.writeText(catId) }}
                            className="gap-2"
                          >
                            <Copy className="w-4 h-4" />
                            Copy Category ID
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onClick={() => setDeletingChannel(cat)}
                            className="text-destructive focus:text-destructive gap-2"
                          >
                            <Trash2 className="w-4 h-4" />
                            Delete Category
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>

                      {/* Category children */}
                      {!isCollapsed && children.map((ch) => (
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
                        />
                      ))}
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => openCreateChannel(undefined, serverId)} className="gap-2">
              <Hash className="w-4 h-4" />
              New Channel
            </ContextMenuItem>
            <ContextMenuItem onClick={() => openCreateCategory(serverId)} className="gap-2">
              <FolderPlus className="w-4 h-4" />
              New Category
            </ContextMenuItem>
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
            <DialogTitle>{isDeletingCategory ? 'Delete Category' : 'Delete Channel'}</DialogTitle>
            <DialogDescription>
              {isDeletingCategory
                ? <>Are you sure you want to delete the category <strong>{deletingChannel?.name}</strong>? Channels inside it will not be deleted.</>
                : <>Are you sure you want to delete <strong>#{deletingChannel?.name}</strong>? This action cannot be undone.</>
              }
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingChannel(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteChannel} disabled={deleteLoading}>
              {isDeletingCategory ? 'Delete Category' : 'Delete Channel'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// Thin wrapper that reads the unread state from Zustand so ChannelItem can be pure
function ChannelItemWithUnread(props: Omit<ChannelItemProps, 'isUnread'>) {
  const isUnread = useUnreadStore((s) => s.channels.has(String(props.channel.id)))
  return <ChannelItem {...props} isUnread={isUnread} />
}

interface ChannelItemProps {
  channel: DtoChannel
  serverId: string
  isActive: boolean
  isUnread: boolean
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
}

function ChannelItem({
  channel,
  serverId,
  isActive,
  isUnread,
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
}: ChannelItemProps) {
  const isVoice = channel.type === ChannelType.ChannelTypeGuildVoice
  const Icon = isVoice ? Volume2 : Hash

  function handleClick() {
    if (isEditing) return
    if (isVoice) {
      void onVoiceJoin(channel)
    } else {
      navigate(`/app/${serverId}/${String(channel.id)}`)
    }
  }

  return (
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
          <Icon className="w-4 h-4 shrink-0 opacity-70" />
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
              {/* Unread dot — only visible when unread and not active */}
              {isUnread && !isActive && (
                <span className="ml-auto shrink-0 w-2 h-2 rounded-full bg-foreground" />
              )}
            </>
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onOpenSettings} className="gap-2">
          <Settings className="w-4 h-4" />
          Edit Channel
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => { void navigator.clipboard.writeText(String(channel.id)) }}
          className="gap-2"
        >
          <Copy className="w-4 h-4" />
          Copy Channel ID
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => onDelete(channel)}
          className="text-destructive focus:text-destructive gap-2"
        >
          <Trash2 className="w-4 h-4" />
          Delete Channel
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
