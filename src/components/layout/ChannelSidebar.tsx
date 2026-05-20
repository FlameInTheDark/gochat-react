import { useEffect, useState, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import { Archive, ChevronDown, ChevronLeft, Hash, LogOut, Pencil, Volume2, MicOff, HeadphoneOff, Trash2, UserPlus, FolderPlus, Plus, GripVertical, Copy, Settings, User, MessageSquare, Eye, MoreVertical, CornerDownRight } from 'lucide-react'
import { toast } from 'sonner'
import { ScrollArea } from '@/components/ui/scroll-area'
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
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import { useUiStore } from '@/stores/uiStore'
import { useUnreadStore } from '@/stores/unreadStore'
import { useReadStateStore } from '@/stores/readStateStore'
import { useMentionStore } from '@/stores/mentionStore'
import { useAuthStore } from '@/stores/authStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { usePresenceStore } from '@/stores/presenceStore'
import { useStreamStore } from '@/stores/streamStore'
import { guildApi, userApi } from '@/api/client'
import { syncChannelStreams } from '@/services/streamService'
import { setPeerVolume } from '@/services/voiceService'
import { ChannelType } from '@/types'
import type { DtoChannel, DtoGuild } from '@/types'
import { cn } from '@/lib/utils'
import { sortThreadsByActivity } from '@/lib/threads'
import { useTranslation } from 'react-i18next'
import VoicePanel from '@/components/voice/VoicePanel'
import { joinVoice } from '@/services/voiceService'
import UserArea from './UserArea'
import { useClientMode } from '@/hooks/useClientMode'
import { useGuildPermissions } from '@/hooks/useGuildPermissions'
import { useNotificationSettings } from '@/hooks/useNotificationSettings'
import { NotificationsSubmenu, NotificationsDropdownSubmenu } from './NotificationsSubmenu'
import { removeThreadMember } from '@/lib/threadMembership'

interface Props {
  channels: DtoChannel[]
  serverId: string
}

export default function ChannelSidebar({ channels, serverId }: Props) {
  const navigate = useNavigate()
  const { channelId: activeChannelId } = useParams<{ channelId?: string }>()
  const queryClient = useQueryClient()
  const isMobile = useClientMode() === 'mobile'

  // Resolve server name from the already-cached guilds list (no extra request)
  const serverName =
    queryClient.getQueryData<DtoGuild[]>(['guilds'])?.find((g) => String(g.id) === serverId)?.name
    ?? 'Server'

  const { t } = useTranslation()

  const { getGuildNotifications, setGuildNotifications } = useNotificationSettings()
  const permissions = useGuildPermissions(serverId)

  const openCreateChannel = useUiStore((s) => s.openCreateChannel)
  const openCreateCategory = useUiStore((s) => s.openCreateCategory)
  const openInviteModal = useUiStore((s) => s.openInviteModal)
  const openServerSettings = useUiStore((s) => s.openServerSettings)
  const openChannelSettings = useUiStore((s) => s.openChannelSettings)

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [deletingChannel, setDeletingChannel] = useState<DtoChannel | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [editingThread, setEditingThread] = useState<DtoChannel | null>(null)
  const [threadEditName, setThreadEditName] = useState('')
  const [threadEditTopic, setThreadEditTopic] = useState('')
  const [threadSaving, setThreadSaving] = useState(false)
  const [deletingThread, setDeletingThread] = useState<DtoChannel | null>(null)
  const [threadDeleting, setThreadDeleting] = useState(false)

  // Current user and permissions
  const currentUser = useAuthStore((s) => s.user)
  const { data: members } = useQuery({
    queryKey: ['members', serverId],
    queryFn: () => guildApi.guildGuildIdMembersGet({ guildId: serverId }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: 30_000,
  })
  const {
    canManageServer,
    canManageChannels,
    canManageThreads,
    canCreateInvites,
    canViewChannel,
  } = permissions

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
  const isThread = (ch: DtoChannel) => ch.type === ChannelType.ChannelTypeThread
  const sorted = (arr: DtoChannel[]) => [...arr].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))

  const categoryIds = new Set(channels.filter(isCat).map((c) => String(c.id)))
  const allCategories = sorted(channels.filter(isCat))
  // Visible categories: only those the user can see
  const categories = allCategories.filter(canViewChannel)
  const visibleCategoryIds = new Set(categories.map((c) => String(c.id)))

  const allRegular = channels.filter(isRegular)
  const joinedThreads = channels.filter((ch) => {
    if (!isThread(ch)) return false
    if (!currentUser?.id) return false
    return (ch.member_ids ?? []).some((id) => String(id) === String(currentUser.id))
  })
  // Visible regular channels: must pass own access check, and if inside a category,
  // that category must also be visible (a private inaccessible category hides its children).
  const visibleRegular = allRegular.filter((ch) => {
    if (!canViewChannel(ch)) return false
    const parentId = ch.parent_id ? String(ch.parent_id) : null
    if (parentId && categoryIds.has(parentId) && !visibleCategoryIds.has(parentId)) return false
    return true
  })

  const threadsByParentId = joinedThreads.reduce<Record<string, DtoChannel[]>>((acc, thread) => {
    if (thread.parent_id == null) return acc
    const parentId = String(thread.parent_id)
    if (!acc[parentId]) acc[parentId] = []
    acc[parentId].push(thread)
    return acc
  }, {})

  useEffect(() => {
    if (!serverId || channels.length === 0) return

    const allowedUnreadChannelIds = new Set<string>()
    for (const channel of visibleRegular) {
      if (channel.id != null) {
        allowedUnreadChannelIds.add(String(channel.id))
      }
    }
    for (const thread of joinedThreads) {
      if (thread.id == null || thread.parent_id == null) continue
      if (allowedUnreadChannelIds.has(String(thread.parent_id))) {
        allowedUnreadChannelIds.add(String(thread.id))
      }
    }

    const unreadStore = useUnreadStore.getState()
    unreadStore.pruneGuildChannels(serverId, allowedUnreadChannelIds)

    const readStateStore = useReadStateStore.getState()
    for (const channelId of allowedUnreadChannelIds) {
      const entry = useUnreadStore.getState().channels.get(channelId)
      if (entry?.guildId === serverId && !readStateStore.isUnread(channelId)) {
        useUnreadStore.getState().markRead(channelId)
      }
    }
    for (const thread of joinedThreads) {
      if (thread.id == null || thread.parent_id == null) continue
      const threadId = String(thread.id)
      if (allowedUnreadChannelIds.has(threadId) && readStateStore.isUnread(threadId)) {
        unreadStore.markUnread(threadId, serverId)
      }
    }
  }, [serverId, channels, visibleRegular, joinedThreads])


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

  function patchThreadInCaches(threadId: string, updater: (thread: DtoChannel) => DtoChannel | null) {
    queryClient.setQueryData<DtoChannel[]>(['channels', serverId], (old) => {
      if (!old) return old
      return old.flatMap((item) => {
        if (String(item.id) !== threadId) return [item]
        const updated = updater(item)
        return updated ? [updated] : []
      })
    })

    const thread = channels.find((item) => String(item.id) === threadId)
    const parentId = thread?.parent_id != null ? String(thread.parent_id) : null
    if (parentId) {
      queryClient.setQueryData<DtoChannel[]>(['channel-threads', serverId, parentId], (old) => {
        if (!old) return old
        return old.flatMap((item) => {
          if (String(item.id) !== threadId) return [item]
          const updated = updater(item)
          return updated ? [updated] : []
        })
      })
    }

    queryClient.setQueryData<DtoChannel>(['thread-channel', serverId, threadId], (old) => {
      if (!old) return old
      return updater(old) ?? old
    })
  }

  async function refreshThreadQueries(thread: DtoChannel) {
    const parentId = thread.parent_id != null ? String(thread.parent_id) : null
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['channels', serverId] }),
      queryClient.invalidateQueries({ queryKey: ['thread-channel', serverId, String(thread.id)] }),
      queryClient.invalidateQueries({ queryKey: ['thread-preview', String(thread.id)] }),
      parentId
        ? queryClient.invalidateQueries({ queryKey: ['channel-threads', serverId, parentId] })
        : Promise.resolve(),
    ])
  }

  function openThreadEditor(thread: DtoChannel) {
    setEditingThread(thread)
    setThreadEditName(thread.name ?? '')
    setThreadEditTopic(thread.topic ?? '')
  }

  async function handleSaveThreadEdit() {
    if (!editingThread) return
    const threadId = String(editingThread.id)
    const nextName = threadEditName.trim() || editingThread.name
    setThreadSaving(true)
    try {
      patchThreadInCaches(threadId, (thread) => ({
        ...thread,
        name: nextName,
        topic: threadEditTopic,
      }))
      await guildApi.guildGuildIdChannelChannelIdPatch({
        guildId: serverId,
        channelId: threadId,
        req: { name: nextName, topic: threadEditTopic },
      })
      await refreshThreadQueries(editingThread)
      setEditingThread(null)
    } catch {
      toast.error(t('threads.updateFailed'))
      await refreshThreadQueries(editingThread)
    } finally {
      setThreadSaving(false)
    }
  }

  async function handleLeaveThread(thread: DtoChannel) {
    if (!currentUser?.id || thread.id == null) return
    const threadId = String(thread.id)
    const parentId = thread.parent_id != null ? String(thread.parent_id) : null
    patchThreadInCaches(threadId, (item) => removeThreadMember(item, String(currentUser.id)))
    queryClient.setQueryData<DtoChannel[]>(['channels', serverId], (old) =>
      old?.filter((item) => String(item.id) !== threadId),
    )
    if (activeChannelId === threadId) {
      navigate(parentId ? `/app/${serverId}/${parentId}` : `/app/${serverId}`)
    }
    try {
      await guildApi.guildGuildIdChannelChannelIdThreadMemberMeDelete({ guildId: serverId, channelId: threadId })
      await refreshThreadQueries(thread)
    } catch {
      toast.error(t('threads.leaveFailed'))
      await refreshThreadQueries(thread)
    }
  }

  async function handleArchiveThread(thread: DtoChannel) {
    if (thread.id == null) return
    const threadId = String(thread.id)
    const nextClosed = !thread.closed
    patchThreadInCaches(threadId, (item) => ({ ...item, closed: nextClosed }))
    try {
      await guildApi.guildGuildIdChannelChannelIdPatch({
        guildId: serverId,
        channelId: threadId,
        req: { closed: nextClosed },
      })
      await refreshThreadQueries(thread)
    } catch {
      toast.error(t('threads.updateFailed'))
      await refreshThreadQueries(thread)
    }
  }

  async function handleDeleteThread() {
    if (!deletingThread?.id) return
    const thread = deletingThread
    const threadId = String(thread.id)
    const parentId = thread.parent_id != null ? String(thread.parent_id) : null
    setThreadDeleting(true)
    try {
      await guildApi.guildGuildIdChannelChannelIdDelete({ guildId: serverId, channelId: threadId })
      patchThreadInCaches(threadId, () => null)
      await refreshThreadQueries(thread)
      if (activeChannelId === threadId) {
        navigate(parentId ? `/app/${serverId}/${parentId}` : `/app/${serverId}`)
      }
      setDeletingThread(null)
    } catch {
      toast.error(t('threads.deleteFailed'))
    } finally {
      setThreadDeleting(false)
    }
  }

  // Check if already connected to a voice channel
  const currentVoiceChannelId = useVoiceStore((s) => s.channelId)

  async function handleVoiceJoin(channel: DtoChannel) {
    const channelId = String(channel.id)

    // Second click on the same channel → open the voice channel view
    if (currentVoiceChannelId === channelId) {
      navigate(`/app/${serverId}/${channelId}`)
      return
    }

    // First click → join voice; VoicePanel appears at bottom, no navigation
    try {
      const res = await guildApi.guildGuildIdVoiceChannelIdJoinPost({
        guildId: serverId,
        channelId,
      })
      if (res.data.sfu_url && res.data.sfu_token) {
        let voiceRegion = res.data.region ?? channel.voice_region ?? undefined
        if (!voiceRegion) {
          voiceRegion = (await guildApi.guildGuildIdChannelChannelIdGet({
            guildId: serverId as unknown as number,
            channelId: channelId as unknown as number,
          }))
            .data.voice_region ?? undefined
        }
        await joinVoice(serverId, channelId, channel.name ?? channelId, res.data.sfu_url, res.data.sfu_token, serverName, voiceRegion)
        void syncChannelStreams(serverId, channelId)
      }
    } catch {
      toast.error(t('channelSidebar.joinVoiceFailed'))
    }
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
      <div className={cn('flex flex-col bg-sidebar', isMobile ? 'w-full flex-1 min-h-0 border-r border-sidebar-border' : 'min-w-0 flex-1')}>
        {/* Mobile: back button to server list */}
        {isMobile && (
          <button
            onClick={() => navigate('/app')}
            className="flex items-center gap-2 px-3 h-10 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0 border-b border-sidebar-border"
          >
            <ChevronLeft className="w-4 h-4" />
            {t('channelSidebar.allServers')}
          </button>
        )}
        {/* Server name header — left-click opens dropdown, right-click opens context menu */}
        <ContextMenu>
          <DropdownMenu>
            <ContextMenuTrigger asChild>
              <DropdownMenuTrigger asChild>
                <div className="mx-2 mt-3 mb-2 flex h-12 items-center rounded-xl border border-white/[0.08] bg-white/[0.035] px-3 text-sm font-semibold shrink-0 cursor-pointer select-none transition-colors hover:bg-white/[0.055] group">
                  <span className="flex-1 truncate">{serverName}</span>
                  <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180 group-data-[state=open]:text-foreground" />
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
            <NotificationsSubmenu
              current={getGuildNotifications(serverId)}
              onUpdate={(patch) => void setGuildNotifications(serverId, patch)}
            />
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => { void navigator.clipboard.writeText(serverId) }} className="gap-2">
              <Copy className="w-4 h-4" />
              {t('channelSidebar.copyServerId')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {/* Channel list */}
        <ContextMenu>
          <ContextMenuTrigger
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
            onDrop={(e) => e.preventDefault()}
          >
            <ScrollArea className="app-scrollbar flex-1">
              <div className="space-y-1 px-2 pt-2 pb-4">
                {/* Pre-group children by category for reliable group animation */}
                {sorted([...visibleRegular, ...categories]).map((item) => {
                  // Uncategorized regular channel — render directly
                  if (!isCat(item)) {
                    const ch = item
                    const parentId = ch.parent_id ? String(ch.parent_id) : null
                    if (parentId && categoryIds.has(parentId)) return null // handled in category block
                    const channelThreads = threadsByParentId[String(ch.id)] ?? []
                    return (
                      <div key={String(ch.id)}>
                        <ChannelItemWithUnread
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
                        {channelThreads.length > 0 && (
                          <ThreadNavItems
                            threads={sortThreadsByActivity(channelThreads)}
                            serverId={serverId}
                            activeChannelId={activeChannelId}
                            navigate={navigate}
                            canManageThreads={canManageThreads}
                            currentUserId={currentUser?.id != null ? String(currentUser.id) : undefined}
                            onLeaveThread={handleLeaveThread}
                            onEditThread={openThreadEditor}
                            onArchiveThread={handleArchiveThread}
                            onDeleteThread={setDeletingThread}
                          />
                        )}
                      </div>
                    )
                  }

                  const cat = item
                  const catId = String(cat.id)
                  // Pre-compute this category's children once
                  const catChildren = sorted(
                    visibleRegular.filter((ch) => ch.parent_id && String(ch.parent_id) === catId)
                  )
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
                              'relative w-full flex items-center gap-1 px-1 pt-4 pb-1.5 text-[11px] font-semibold uppercase text-muted-foreground hover:text-foreground tracking-wide group/cat cursor-pointer select-none',
                              draggingId === catId && 'opacity-40',
                            )}
                          >
                            {catIndicator && (
                              <span
                                className={cn(
                                  'pointer-events-none absolute left-2 right-2 z-20 h-1 rounded-full bg-emerald-400 shadow-[0_0_0_2px_var(--color-sidebar)]',
                                  catIndicator === 'top' ? 'top-0' : 'bottom-0',
                                )}
                              />
                            )}
                            <span className="cursor-grab active:cursor-grabbing shrink-0">
                              <GripVertical className="w-3 h-3 opacity-0 group-hover/cat:opacity-40 -ml-1" />
                            </span>
                            <motion.span
                              animate={{ rotate: isCollapsed ? -90 : 0 }}
                              transition={{ type: 'spring', damping: 20, stiffness: 260 }}
                              style={{ display: 'flex', transformOrigin: 'center' }}
                              className="shrink-0"
                            >
                              <ChevronDown className="w-3 h-3" />
                            </motion.span>
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

                      {/* Animate ALL children as one group — avoids per-item race conditions */}
                      <AnimatePresence initial={false}>
                        {!isCollapsed && catChildren.length > 0 && (
                          <motion.div
                            key={catId + '-children'}
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                            style={{ overflow: 'hidden' }}
                          >
                            {catChildren.map((ch) => {
                              const channelThreads = threadsByParentId[String(ch.id)] ?? []
                              return (
                                <div key={String(ch.id)}>
                                  <ChannelItemWithUnread
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
                                  {channelThreads.length > 0 && (
                                    <ThreadNavItems
                                      threads={sortThreadsByActivity(channelThreads)}
                                      serverId={serverId}
                                      activeChannelId={activeChannelId}
                                      navigate={navigate}
                                      canManageThreads={canManageThreads}
                                      currentUserId={currentUser?.id != null ? String(currentUser.id) : undefined}
                                      onLeaveThread={handleLeaveThread}
                                      onEditThread={openThreadEditor}
                                      onArchiveThread={handleArchiveThread}
                                      onDeleteThread={setDeletingThread}
                                    />
                                  )}
                                </div>
                              )
                            })}
                          </motion.div>
                        )}
                      </AnimatePresence>
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

        {isMobile && (
          <div className="relative z-20 shrink-0 space-y-2 px-2 pb-2 pt-1">
            <VoicePanel />
            <UserArea />
          </div>
        )}
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

      <Dialog open={!!editingThread} onOpenChange={(open) => !open && setEditingThread(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('threads.editTitle')}</DialogTitle>
            <DialogDescription>{t('threads.editDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('threads.threadName')}</label>
              <Input
                value={threadEditName}
                onChange={(e) => setThreadEditName(e.target.value)}
                placeholder={t('threads.threadNamePlaceholder')}
                maxLength={256}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('threads.topic')}</label>
              <Textarea
                value={threadEditTopic}
                onChange={(e) => setThreadEditTopic(e.target.value)}
                placeholder={t('threads.topicPlaceholder')}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingThread(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleSaveThreadEdit()} disabled={threadSaving}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deletingThread} onOpenChange={(open) => !open && setDeletingThread(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('threads.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('threads.deleteDescription', { name: deletingThread?.name ?? deletingThread?.id })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingThread(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void handleDeleteThread()} disabled={threadDeleting}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ThreadNavItems({
  threads,
  serverId,
  activeChannelId,
  navigate,
  canManageThreads,
  currentUserId,
  onLeaveThread,
  onEditThread,
  onArchiveThread,
  onDeleteThread,
}: {
  threads: DtoChannel[]
  serverId: string
  activeChannelId?: string
  navigate: (path: string) => void
  canManageThreads: boolean
  currentUserId?: string
  onLeaveThread: (thread: DtoChannel) => void
  onEditThread: (thread: DtoChannel) => void
  onArchiveThread: (thread: DtoChannel) => void
  onDeleteThread: (thread: DtoChannel) => void
}) {
  const { t } = useTranslation()
  const { getChannelNotifications, setChannelNotifications } = useNotificationSettings()

  return (
    <div className="ml-7 mt-0.5 space-y-0.5">
      {threads.map((thread) => {
        const threadId = String(thread.id)
        const canManageThisThread = canManageThreads ||
          (currentUserId != null && String(thread.creator_id) === currentUserId)
        return (
          <ContextMenu key={threadId}>
            <ContextMenuTrigger asChild>
              <ThreadNavButton
                threadId={threadId}
                name={thread.name}
                isActive={threadId === activeChannelId}
                onClick={() => navigate(`/app/${serverId}/${threadId}`)}
              />
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                onClick={() => navigate(`/app/${serverId}/${threadId}`)}
                className="gap-2"
              >
                <Eye className="w-4 h-4" />
                {t('threads.openThread')}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => onLeaveThread(thread)}
                className="gap-2"
              >
                <LogOut className="w-4 h-4" />
                {t('threads.leaveThread')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <NotificationsSubmenu
                current={getChannelNotifications(threadId)}
                onUpdate={(patch) => void setChannelNotifications(threadId, patch)}
              />
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => { void navigator.clipboard.writeText(threadId) }}
                className="gap-2"
              >
                <Copy className="w-4 h-4" />
                {t('threads.copyThreadId')}
              </ContextMenuItem>
              {canManageThisThread && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onEditThread(thread)} className="gap-2">
                    <Pencil className="w-4 h-4" />
                    {t('threads.editThread')}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => onArchiveThread(thread)} className="gap-2">
                    <Archive className="w-4 h-4" />
                    {thread.closed ? t('threads.reopenThread') : t('threads.archiveThread')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() => onDeleteThread(thread)}
                    className="text-destructive focus:text-destructive gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    {t('threads.deleteThread')}
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
    </div>
  )
}

function ThreadNavButton({
  threadId,
  name,
  isActive,
  onClick,
}: {
  threadId: string
  name?: string
  isActive: boolean
  onClick: () => void
}) {
  const isUnread = useUnreadStore((s) => s.channels.has(threadId))
  const mentionCount = useMentionStore((s) => s.getChannelMentionCount(threadId))

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group/thread flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
        isActive
          ? 'bg-white/[0.07] text-foreground font-medium'
          : isUnread
            ? 'text-foreground hover:bg-white/[0.045]'
            : 'text-muted-foreground hover:bg-white/[0.045] hover:text-foreground',
      )}
    >
      <CornerDownRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
      <span className={cn('min-w-0 flex-1 truncate', isUnread && 'font-medium')}>{name ?? threadId}</span>
      {mentionCount > 0 ? (
        <span className="ml-auto flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground">
          {mentionCount > 99 ? '99+' : mentionCount}
        </span>
      ) : isUnread ? (
        <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-white" />
      ) : null}
    </button>
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
  const streamCount = useStreamStore((s) =>
    isVoice ? (s.channelStreams[channelId]?.length ?? 0) : 0,
  )
  return <ChannelItem {...props} isUnread={isUnread} mentionCount={mentionCount} voiceUsers={voiceUsers} streamCount={streamCount} />
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
  streamCount?: number
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
  streamCount,
  voiceUsers,
  members,
}: ChannelItemProps) {
  const { t } = useTranslation()
  const { getChannelNotifications, setChannelNotifications } = useNotificationSettings()
  const isMobile = useClientMode() === 'mobile'
  const isVoice = channel.type === ChannelType.ChannelTypeGuildVoice
  const Icon = isVoice ? Volume2 : Hash
  const hasVoiceUsers = isVoice && voiceUsers && voiceUsers.length > 0
  const hasLiveStreams = isVoice && (streamCount ?? 0) > 0

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
          <div
            draggable={!isEditing}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
            onClick={handleClick}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick() }}
            role="button"
            tabIndex={0}
            className={cn(
              'relative w-full flex items-center gap-2.5 rounded-md px-3 text-sm transition-colors text-left cursor-pointer select-none group/item',
              isMobile ? 'py-2.5' : 'py-1.5',
              isActive
                ? 'bg-white/[0.08] text-foreground'
                : isUnread
                  ? 'text-foreground font-medium hover:bg-white/[0.055]'
                  : 'text-muted-foreground hover:text-foreground hover:bg-white/[0.045]',
              isDragging && 'opacity-40',
            )}
          >
            {dropIndicator && (
              <span
                className={cn(
                  'pointer-events-none absolute left-2 right-2 z-20 h-1 rounded-full bg-emerald-400 shadow-[0_0_0_2px_var(--color-sidebar)]',
                  dropIndicator === 'top' ? '-top-0.5' : '-bottom-0.5',
                )}
              />
            )}
            <span className="cursor-grab active:cursor-grabbing shrink-0">
              <GripVertical className="w-3.5 h-3.5 opacity-0 group-hover/item:opacity-40 -ml-1" />
            </span>
            <Icon className={cn('w-4 h-4 shrink-0', hasVoiceUsers ? 'text-emerald-400 opacity-100' : 'text-muted-foreground opacity-80 group-hover/item:text-foreground')} />
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
                className="flex-1 min-w-0 bg-background border border-primary rounded-md px-2 py-1 outline-none text-sm cursor-text"
              />
            ) : (
              <>
                <span className="truncate flex-1">{channel.name}</span>
                {hasLiveStreams && (
                  <span className="shrink-0 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-red-400">
                    {t('streams.liveCount', { count: streamCount })}
                  </span>
                )}
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
                {/* Mobile: three-dot menu button */}
                {isMobile && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60"
                      >
                        <MoreVertical className="w-4 h-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
                      {isVoice && (
                        <>
                          <DropdownMenuItem
                            onClick={() => navigate(`/app/${serverId}/${String(channel.id)}`)}
                            className="gap-2"
                          >
                            <Eye className="w-4 h-4" />
                            {t('channelSidebar.viewChannel')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </>
                      )}
                      {canManageChannels && (
                        <>
                          <DropdownMenuItem onClick={onOpenSettings} className="gap-2">
                            <Settings className="w-4 h-4" />
                            {t('channelSidebar.editChannel')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </>
                      )}
                      <NotificationsDropdownSubmenu
                        current={getChannelNotifications(String(channel.id))}
                        onUpdate={(patch) => void setChannelNotifications(String(channel.id), patch)}
                      />
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => { void navigator.clipboard.writeText(String(channel.id)) }}
                        className="gap-2"
                      >
                        <Copy className="w-4 h-4" />
                        {t('channelSidebar.copyChannelId')}
                      </DropdownMenuItem>
                      {canManageChannels && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => onDelete(channel)}
                            className="text-destructive focus:text-destructive gap-2"
                          >
                            <Trash2 className="w-4 h-4" />
                            {t('channelSidebar.deleteChannel')}
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </>
            )}
          </div>
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
          <NotificationsSubmenu
            current={getChannelNotifications(String(channel.id))}
            onUpdate={(patch) => void setChannelNotifications(String(channel.id), patch)}
          />
          <ContextMenuSeparator />
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
  const activeStream = usePresenceStore((s) => s.activeStreams[user.userId] ?? null)
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
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-white/[0.035] cursor-pointer"
        >
          {/* Avatar wrapper — ring is outside overflow-hidden */}
          <div className={cn(
            'relative shrink-0 rounded-full',
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
          <span className="truncate text-sm flex-1">
            {user.username}
          </span>
          {activeStream && (
            <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-red-400">
              {t('streams.liveBadge')}
            </span>
          )}
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
