import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  LogOut,
  Settings,
  Copy,
  Pencil,
  FolderX,
  FolderMinus,
  FolderPlus,
  Folder,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
  type Active,
  type ClientRect,
  type CollisionDetection,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTranslation } from 'react-i18next'
import { userApi, guildApi, rolesApi } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
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
import { useUiStore } from '@/stores/uiStore'
import { useFolderStore, type GuildFolder } from '@/stores/folderStore'
import { useUnreadStore } from '@/stores/unreadStore'
import { useMentionStore } from '@/stores/mentionStore'
import { cn } from '@/lib/utils'
import type { DtoGuild } from '@/types'
import { hasPermission, calculateEffectivePermissions, PermissionBits } from '@/lib/permissions'
import type { DtoRole, DtoMember } from '@/client'

// ── Detect if a dragged guild is overlapping an icon enough to "merge" ────────
// Returns true when the dragged item's centre is within ±20% of the target's
// height from the target's centre.  This covers the central 40% of the icon,
// leaving a generous 30% reorder zone at the top and bottom edges so the user
// can easily drop above/below without triggering a merge.
function isCenterOver(active: Active, overRect: ClientRect): boolean {
  const translated = active.rect.current.translated
  if (!translated) return false
  const activeCY = translated.top + translated.height / 2
  const mid = overRect.top + overRect.height / 2
  return Math.abs(activeCY - mid) < overRect.height * 0.20
}

// ── Parse an 'ifguild:folderId:guildId' item id ───────────────────────────────
function parseIfGuild(id: string): { folderId: string; guildId: string } | null {
  if (!id.startsWith('ifguild:')) return null
  const rest = id.slice(8)
  const colonIdx = rest.indexOf(':')
  if (colonIdx === -1) return null
  return { folderId: rest.slice(0, colonIdx), guildId: rest.slice(colonIdx + 1) }
}

// ── Drop indicator type ───────────────────────────────────────────────────────
interface DropIndicator {
  /** ID of the item that the indicator sits next to */
  itemId: string
  /** Whether the bar is above or below the target item */
  edge: 'before' | 'after'
}

// ── Reusable drop-indicator bar ──────────────────────────────────────────────
function DropBar({ position }: { position: 'before' | 'after' }) {
  return (
    <div
      className={cn(
        'absolute left-1/2 -translate-x-1/2 w-10 h-0.5 bg-primary rounded-full pointer-events-none z-20',
        position === 'before' ? '-top-1.5' : '-bottom-1.5',
      )}
    />
  )
}

// ── Custom collision detection for folder extraction ─────────────────────────
// Wraps closestCenter to allow "drop on empty space" when dragging a guild out
// of a folder.  Without this, closestCenter always finds the nearest droppable
// (even when the pointer is far away), making it impossible to extract a guild
// when all guilds live inside one folder and there are no other top-level items.
const folderExtractionCollision: CollisionDetection = (args) => {
  const activeId = String(args.active.id)
  const parsed = parseIfGuild(activeId)

  if (parsed && args.pointerCoordinates) {
    const { y } = args.pointerCoordinates

    // Compute the vertical bounding box of all items in the source folder
    // (the folder icon + every ifguild item belonging to the same folder).
    let minTop = Infinity
    let maxBottom = -Infinity
    for (const container of args.droppableContainers) {
      const id = String(container.id)
      const p = parseIfGuild(id)
      if (
        (p && p.folderId === parsed.folderId) ||
        id === `folder:${parsed.folderId}`
      ) {
        const rect = container.rect.current
        if (rect) {
          if (rect.top < minTop) minTop = rect.top
          if (rect.bottom > maxBottom) maxBottom = rect.bottom
        }
      }
    }

    // If the pointer is far enough outside the folder panel, check whether the
    // closest target belongs to a *different* group.  If the closest is still
    // from the same folder (i.e. there is nothing else to land on), return no
    // collisions so `over` becomes null and the extraction code path fires.
    if (minTop !== Infinity) {
      const margin = 50 // ~1 icon height beyond the folder panel
      if (y < minTop - margin || y > maxBottom + margin) {
        const collisions = closestCenter(args)
        if (collisions.length > 0) {
          const closestId = String(collisions[0].id)
          const closestParsed = parseIfGuild(closestId)
          const isInSameFolder =
            (closestParsed && closestParsed.folderId === parsed.folderId) ||
            closestId === `folder:${parsed.folderId}`
          if (!isInSameFolder) {
            return collisions // Target is outside this folder — use it normally
          }
        }
        return [] // Only same-folder items nearby → extract from folder
      }
    }
  }

  return closestCenter(args)
}

// ── Folder colour palette ─────────────────────────────────────────────────────
const FOLDER_COLORS: { label: string; value: number }[] = [
  { label: 'Default', value: 0 },
  { label: 'Red', value: 0xf04747 },
  { label: 'Orange', value: 0xfaa61a },
  { label: 'Yellow', value: 0xffd83d },
  { label: 'Green', value: 0x43b581 },
  { label: 'Teal', value: 0x1abc9c },
  { label: 'Blue', value: 0x7289da },
  { label: 'Indigo', value: 0x5865f2 },
  { label: 'Purple', value: 0xb3a3e5 },
  { label: 'Pink', value: 0xe91e8c },
]

function colorToHex(color: number): string {
  return color ? `#${color.toString(16).padStart(6, '0')}` : ''
}

/**
 * CSS custom-property tokens for a folder's colour scheme,
 * computed with color-mix() so they blend with the sidebar background.
 */
function computeFolderTokens(color: number): React.CSSProperties {
  const hex = color ? colorToHex(color) : null
  return {
    '--fc-collapsed-border': hex
      ? `color-mix(in srgb, ${hex} 65%, transparent)`
      : 'var(--color-sidebar-border)',
    '--fc-collapsed-bg': hex
      ? `color-mix(in srgb, var(--color-sidebar) 75%, ${hex} 25%)`
      : 'color-mix(in srgb, var(--color-sidebar) 82%, var(--color-sidebar-foreground) 18%)',
    '--fc-expanded-border': hex
      ? `color-mix(in srgb, ${hex} 45%, transparent)`
      : 'var(--color-sidebar-border)',
    '--fc-expanded-bg': hex
      ? `color-mix(in srgb, var(--color-sidebar) 85%, ${hex} 15%)`
      : 'color-mix(in srgb, var(--color-sidebar) 94%, var(--color-sidebar-foreground) 6%)',
  } as React.CSSProperties
}

// ── Left-edge unread pill (shared by guild icons and folder buttons) ──────────
// Pill is centred on the left edge of its parent: left-0 -translate-x-1/2.
// Pass leftClass to override 'left-0' when the parent is offset from the
// sidebar wall (e.g. guild icons inside a folder panel).
function UnreadPill({
  isActive,
  isUnread,
  groupClass = 'group/guild',
  leftClass = 'left-0',
}: {
  isActive: boolean
  isUnread: boolean
  groupClass?: string
  leftClass?: string
}) {
  return (
    <span
      className={cn(
        'pointer-events-none absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2',
        leftClass,
        'w-1 rounded-full bg-white shadow-[0_0_0_2px_var(--color-sidebar)]',
        'transition-all duration-150',
        isActive
          ? 'h-9 opacity-100'
          : isUnread
            ? `h-2 opacity-100 ${groupClass}:h-5`
            : `h-0 opacity-0 ${groupClass}:h-5 ${groupClass}:opacity-100`,
      )}
    />
  )
}

// ── Mini guild icon (2×2 grid inside collapsed folder) ───────────────────────
function MiniGuildIcon({ guild }: { guild: DtoGuild }) {
  return (
    <div
      className={cn(
        'w-4 h-4 squircle overflow-hidden flex items-center justify-center text-[7px] font-bold text-white shrink-0 border',
        'border-transparent bg-black/20',
      )}
    >
      {guild.icon?.url ? (
        <img src={guild.icon.url} alt="" className="w-full h-full object-cover" />
      ) : (
        <span>{(guild.name ?? '?').charAt(0).toUpperCase()}</span>
      )}
    </div>
  )
}

// ── DragOverlay previews ──────────────────────────────────────────────────────
function GuildDragPreview({ guild }: { guild?: DtoGuild }) {
  if (!guild) return null
  return (
    <div className="w-12 h-12 squircle overflow-hidden opacity-90 shadow-xl">
      <Avatar className="w-12 h-12 squircle rounded-none">
        <AvatarImage src={guild.icon?.url} alt={guild.name ?? ''} className="object-cover" />
        <AvatarFallback className="rounded-none">{(guild.name ?? '?').charAt(0).toUpperCase()}</AvatarFallback>
      </Avatar>
    </div>
  )
}

function FolderDragPreview({ folder, guilds }: { folder?: GuildFolder; guilds: DtoGuild[] }) {
  if (!folder) return null
  const tokens = computeFolderTokens(folder.color)
  return (
    <div
      className="w-12 h-12 squircle flex items-center justify-center opacity-90 shadow-2xl"
      style={{ ...tokens, backgroundColor: 'var(--fc-collapsed-bg)' }}
    >
      <div className="grid grid-cols-2 gap-[3px]">
        {guilds.slice(0, 4).map((g) => (
          <MiniGuildIcon key={String(g.id)} guild={g} />
        ))}
        {Array.from({ length: Math.max(0, 4 - guilds.length) }).map((_, i) => (
          <div key={i} className="w-4 h-4 squircle bg-black/20" />
        ))}
      </div>
    </div>
  )
}

// ── Folder create/edit dialog ─────────────────────────────────────────────────
interface FolderDialogProps {
  open: boolean
  folder: GuildFolder | null
  onClose: () => void
  onSave: (name: string, color: number) => void
}

function FolderDialog({ open, folder, onClose, onSave }: FolderDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [color, setColor] = useState(0)

  useEffect(() => {
    if (open) {
      setName(folder?.name ?? '')
      setColor(folder?.color ?? 0)
    }
  }, [open, folder])

  function handleSave() {
    onSave(name.trim() || t('serverSidebar.folderNameDefault'), color)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{folder ? t('serverSidebar.editFolderTitle') : t('serverSidebar.createFolderTitle')}</DialogTitle>
          <DialogDescription>
            {folder
              ? t('serverSidebar.editFolderDesc')
              : t('serverSidebar.createFolderDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('serverSidebar.folderName')}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            autoFocus
          />
          <div className="flex flex-wrap gap-2">
            {FOLDER_COLORS.map((c) => (
              <button
                key={c.value}
                title={c.label}
                onClick={() => setColor(c.value)}
                className={cn(
                  'w-6 h-6 rounded-full border-2 transition-all',
                  color === c.value
                    ? 'border-foreground scale-110'
                    : 'border-transparent opacity-70 hover:opacity-100',
                )}
                style={{ backgroundColor: c.value ? colorToHex(c.value) : 'hsl(var(--muted))' }}
              />
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave}>{folder ? t('common.save') : t('serverSidebar.createFolderTitle')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Shared context-menu items for a folder (edit / dissolve) ─────────────────
function FolderContextItems({
  onEdit,
  onDissolve,
}: {
  onEdit: () => void
  onDissolve: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <ContextMenuItem onClick={onEdit} className="gap-2">
        <Pencil className="w-4 h-4" />
        {t('serverSidebar.editFolder')}
      </ContextMenuItem>
      <ContextMenuItem
        onClick={onDissolve}
        className="text-destructive focus:text-destructive gap-2"
      >
        <FolderX className="w-4 h-4" />
        {t('serverSidebar.dissolveFolder')}
      </ContextMenuItem>
    </>
  )
}

// ── Sortable guild icon (ungrouped, top-level) ────────────────────────────────
interface SortableGuildIconProps {
  itemId: string
  guild: DtoGuild
  isActive: boolean
  isMergeTarget: boolean
  dropBefore: boolean
  dropAfter: boolean
  onNavigate: () => void
  onOpenSettings: () => void
  onLeave: () => void
  onNewFolder: () => void
  onAddToFolder: (folderId: string) => void
  folders: GuildFolder[]
  canManageServer: boolean
  isOwner: boolean
}

function SortableGuildIcon({
  itemId,
  guild,
  isActive,
  isMergeTarget,
  dropBefore,
  dropAfter,
  onNavigate,
  onOpenSettings,
  onLeave,
  onNewFolder,
  onAddToFolder,
  folders,
  canManageServer,
  isOwner,
}: SortableGuildIconProps) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: itemId,
  })
  const guildId = String(guild.id)
  const isUnread = useUnreadStore((s) => s.isGuildUnread(guildId))
  const mentionCount = useMentionStore((s) => s.getGuildMentionCount(guildId))

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className="relative flex items-center justify-center group/guild w-full">
      {dropBefore && <DropBar position="before" />}
      {dropAfter && <DropBar position="after" />}
      <UnreadPill isActive={isActive} isUnread={isUnread} groupClass="group/guild" />
      <ContextMenu>
        <Tooltip>
          <ContextMenuTrigger asChild>
            <TooltipTrigger asChild>
              <div className="relative w-12 h-12 shrink-0">
                <button
                  {...attributes}
                  {...listeners}
                  onClick={onNavigate}
                  className={cn(
                    'w-12 h-12 transition-all squircle overflow-hidden',
                    isMergeTarget && 'scale-110 shadow-[inset_0_0_0_3px_hsl(var(--primary))]',
                  )}
                >
                  {guild.icon?.url ? (
                    <img src={guild.icon.url} alt={guild.name ?? ''} className="w-full h-full object-cover" />
                  ) : (
                    <span className="w-full h-full flex items-center justify-center font-bold text-muted-foreground bg-muted">
                      {(guild.name ?? '?').charAt(0).toUpperCase()}
                    </span>
                  )}
                </button>
                {/* Badge — outside the squircle mask so it isn't clipped */}
                {mentionCount > 0 ? (
                  <span className="absolute -bottom-1 -right-1 z-10 min-w-[1.125rem] h-[1.125rem] rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center px-1 leading-none ring-2 ring-sidebar pointer-events-none">
                    {mentionCount > 99 ? '99+' : mentionCount}
                  </span>
                ) : isUnread ? (
                  <span className="absolute -bottom-0.5 -right-0.5 z-10 w-3 h-3 rounded-full bg-white ring-2 ring-sidebar pointer-events-none" />
                ) : null}
              </div>
            </TooltipTrigger>
          </ContextMenuTrigger>
          <TooltipContent side="right">{guild.name}</TooltipContent>
        </Tooltip>

        <ContextMenuContent>
          {canManageServer && (
            <ContextMenuItem onClick={onOpenSettings} className="gap-2">
              <Settings className="w-4 h-4" />
              {t('serverSidebar.serverSettings')}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onClick={() => { void navigator.clipboard.writeText(String(guild.id)) }}
            className="gap-2"
          >
            <Copy className="w-4 h-4" />
            {t('serverSidebar.copyServerId')}
          </ContextMenuItem>
          {canManageServer && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onNewFolder} className="gap-2">
                <FolderPlus className="w-4 h-4" />
                {t('serverSidebar.newFolder')}
              </ContextMenuItem>
              {folders.length > 0 && (
                <ContextMenuSub>
                  <ContextMenuSubTrigger className="gap-2">
                    <FolderPlus className="w-4 h-4" />
                    {t('serverSidebar.addToFolder')}
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    {folders.map((f) => (
                      <ContextMenuItem key={f.id} onClick={() => onAddToFolder(f.id)}>
                        {f.name || t('serverSidebar.folderNameDefault')}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              )}
            </>
          )}
          {!isOwner && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={onLeave}
                className="text-destructive focus:text-destructive gap-2"
              >
                <LogOut className="w-4 h-4" />
                {t('serverSidebar.leaveServer')}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}

// ── Guild inside expanded folder panel ───────────────────────────────────────
interface SortableGuildInPanelProps {
  itemId: string
  guild: DtoGuild
  isActive: boolean
  dropBefore: boolean
  dropAfter: boolean
  onNavigate: () => void
  onServerSettings: () => void
  onLeave: () => void
  onRemoveFromFolder: () => void
  canManageServer: boolean
  isOwner: boolean
}

function SortableGuildInPanel({
  itemId,
  guild,
  isActive,
  dropBefore,
  dropAfter,
  onNavigate,
  onServerSettings,
  onLeave,
  onRemoveFromFolder,
  canManageServer,
  isOwner,
}: SortableGuildInPanelProps) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: itemId,
  })
  const isUnread = useUnreadStore((s) => s.isGuildUnread(String(guild.id)))
  const mentionCount = useMentionStore((s) => s.getGuildMentionCount(String(guild.id)))

  const dndStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.25 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={dndStyle}
      className="relative flex items-center justify-center group/guild w-full"
    >
      {dropBefore && <DropBar position="before" />}
      {dropAfter && <DropBar position="after" />}
      <UnreadPill isActive={isActive} isUnread={isUnread} groupClass="group/guild" leftClass="left-[-14px]" />
      <ContextMenu>
        <Tooltip>
          <ContextMenuTrigger asChild>
            <TooltipTrigger asChild>
              <div className="relative w-10 h-10 shrink-0">
                <button
                  {...attributes}
                  {...listeners}
                  onClick={onNavigate}
                  className="w-10 h-10 transition-all squircle overflow-hidden"
                >
                  {guild.icon?.url ? (
                    <img src={guild.icon.url} alt={guild.name ?? ''} className="w-full h-full object-cover" />
                  ) : (
                    <span className="w-full h-full flex items-center justify-center font-bold text-muted-foreground bg-muted text-sm">
                      {(guild.name ?? '?').charAt(0).toUpperCase()}
                    </span>
                  )}
                </button>
                {/* Badge — outside the squircle mask so it isn't clipped */}
                {mentionCount > 0 ? (
                  <span className="absolute -bottom-1 -right-1 z-10 min-w-[1.125rem] h-[1.125rem] rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center px-1 leading-none ring-2 ring-sidebar pointer-events-none">
                    {mentionCount > 99 ? '99+' : mentionCount}
                  </span>
                ) : isUnread ? (
                  <span className="absolute -bottom-0.5 -right-0.5 z-10 w-3 h-3 rounded-full bg-white ring-2 ring-sidebar pointer-events-none" />
                ) : null}
              </div>
            </TooltipTrigger>
          </ContextMenuTrigger>
          <TooltipContent side="right">{guild.name}</TooltipContent>
        </Tooltip>

        <ContextMenuContent>
          {canManageServer && (
            <ContextMenuItem onClick={onServerSettings} className="gap-2">
              <Settings className="w-4 h-4" />
              {t('serverSidebar.serverSettings')}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onClick={() => { void navigator.clipboard.writeText(String(guild.id)) }}
            className="gap-2"
          >
            <Copy className="w-4 h-4" />
            {t('serverSidebar.copyServerId')}
          </ContextMenuItem>
          {canManageServer && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onRemoveFromFolder} className="gap-2">
                <FolderMinus className="w-4 h-4" />
                {t('serverSidebar.removeFromFolder')}
              </ContextMenuItem>
            </>
          )}
          {!isOwner && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={onLeave}
                className="text-destructive focus:text-destructive gap-2"
              >
                <LogOut className="w-4 h-4" />
                {t('serverSidebar.leaveServer')}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}

// ── Sortable folder item ──────────────────────────────────────────────────────
interface SortableFolderItemProps {
  itemId: string
  folder: GuildFolder
  guildsInFolder: DtoGuild[]
  activeServerId?: string
  isDragTarget: boolean
  dropBefore: boolean
  dropAfter: boolean
  dropIndicator: DropIndicator | null
  onEditFolder: () => void
  onDissolveFolder: () => void
  onNavigateGuild: (guildId: string) => void
  onGuildSettings: (guildId: string) => void
  onLeaveGuild: (guild: DtoGuild) => void
  onRemoveGuildFromFolder: (guildId: string) => void
  canManageServerMap: Map<string, boolean>
  isOwnerMap: Map<string, boolean>
}

function SortableFolderItem({
  itemId,
  folder,
  guildsInFolder,
  activeServerId,
  isDragTarget,
  dropBefore,
  dropAfter,
  dropIndicator,
  onEditFolder,
  onDissolveFolder,
  onNavigateGuild,
  onGuildSettings,
  onLeaveGuild,
  onRemoveGuildFromFolder,
  canManageServerMap,
  isOwnerMap,
}: SortableFolderItemProps) {
  const { t } = useTranslation()
  const { toggleCollapse } = useFolderStore()
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: itemId })

  const dndStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.25 : 1,
  }

  const tokens = computeFolderTokens(folder.color)
  const isActiveInFolder = guildsInFolder.some((g) => String(g.id) === activeServerId)
  const isUnread = useUnreadStore((s) =>
    guildsInFolder.some((g) => s.isGuildUnread(String(g.id))),
  )

  // Build ifguild: IDs for the inner SortableContext
  const folderGuildItemIds = guildsInFolder.map((g) => `ifguild:${folder.id}:${String(g.id)}`)

  // ── Collapsed ──────────────────────────────────────────────────────────────
  if (folder.collapsed) {
    return (
      <div
        ref={setNodeRef}
        style={{ ...dndStyle, ...tokens }}
        className="relative flex items-center justify-center group/folder w-full"
      >
        {dropBefore && <DropBar position="before" />}
        {dropAfter && <DropBar position="after" />}
        <UnreadPill isActive={isActiveInFolder} isUnread={isUnread} groupClass="group/folder" />
        <ContextMenu>
          <Tooltip>
            <ContextMenuTrigger asChild>
              <TooltipTrigger asChild>
                <button
                  {...attributes}
                  {...listeners}
                  onClick={() => toggleCollapse(folder.id)}
                  className={cn(
                    'w-12 h-12 squircle flex items-center justify-center',
                    'transition-all shrink-0 hover:brightness-110 active:scale-95',
                    isDragTarget && 'scale-110 shadow-[inset_0_0_0_3px_hsl(var(--primary))]',
                  )}
                  style={{ backgroundColor: 'var(--fc-collapsed-bg)' }}
                >
                  {/* 2×2 mini icon grid */}
                  <div className="grid grid-cols-2 gap-[3px]">
                    {guildsInFolder.slice(0, 4).map((g) => (
                      <MiniGuildIconWithUnread key={String(g.id)} guild={g} />
                    ))}
                    {Array.from({ length: Math.max(0, 4 - guildsInFolder.length) }).map((_, i) => (
                      <div key={i} className="w-4 h-4 rounded-[3px] bg-black/20" />
                    ))}
                  </div>
                </button>
              </TooltipTrigger>
            </ContextMenuTrigger>
            <TooltipContent side="right">{folder.name || t('serverSidebar.folderNameDefault')}</TooltipContent>
          </Tooltip>
          <ContextMenuContent>
            <FolderContextItems onEdit={onEditFolder} onDissolve={onDissolveFolder} />
          </ContextMenuContent>
        </ContextMenu>
      </div>
    )
  }

  // ── Expanded ───────────────────────────────────────────────────────────────
  return (
    <div
      ref={setNodeRef}
      style={{ ...dndStyle, ...tokens }}
      className="relative flex flex-col items-center gap-1.5 group/folder w-full"
    >
      {dropBefore && <DropBar position="before" />}
      {dropAfter && <DropBar position="after" />}
      {/* Folder header button — draggable even when expanded */}
      {/* Single background card: folder icon + guild icons */}
      <div
        className="flex flex-col items-center gap-2 rounded-2xl p-2"
        style={{ backgroundColor: 'var(--fc-expanded-bg)' }}
      >
        {/* Folder header — drag handle + collapse toggle */}
        <div className="relative">
          <UnreadPill isActive={false} isUnread={isUnread} groupClass="group/folder" leftClass="left-[-14px]" />
          <ContextMenu>
            <Tooltip>
              <ContextMenuTrigger asChild>
                <TooltipTrigger asChild>
                  <button
                    {...attributes}
                    {...listeners}
                    onClick={() => toggleCollapse(folder.id)}
                    aria-label={`Collapse ${folder.name || 'folder'}`}
                    className={cn(
                      'w-10 h-10 squircle flex items-center justify-center',
                      'transition-all shrink-0 hover:brightness-110 active:scale-95',
                      isDragTarget && 'shadow-[inset_0_0_0_3px_hsl(var(--primary))]',
                    )}
                  >
                    <Folder className="w-5 h-5 opacity-70 text-white" />
                  </button>
                </TooltipTrigger>
              </ContextMenuTrigger>
              <TooltipContent side="right">{folder.name || t('serverSidebar.folderNameDefault')}</TooltipContent>
            </Tooltip>
            <ContextMenuContent>
              <FolderContextItems onEdit={onEditFolder} onDissolve={onDissolveFolder} />
            </ContextMenuContent>
          </ContextMenu>
        </div>

        <SortableContext items={folderGuildItemIds} strategy={verticalListSortingStrategy}>
          {guildsInFolder.map((guild) => {
            const guildId = String(guild.id)
            const panelItemId = `ifguild:${folder.id}:${guildId}`
            return (
              <SortableGuildInPanel
                key={panelItemId}
                itemId={panelItemId}
                guild={guild}
                isActive={guildId === activeServerId}
                dropBefore={dropIndicator?.itemId === panelItemId && dropIndicator.edge === 'before'}
                dropAfter={dropIndicator?.itemId === panelItemId && dropIndicator.edge === 'after'}
                onNavigate={() => onNavigateGuild(guildId)}
                onServerSettings={() => onGuildSettings(guildId)}
                onLeave={() => onLeaveGuild(guild)}
                onRemoveFromFolder={() => onRemoveGuildFromFolder(guildId)}
                canManageServer={canManageServerMap.get(guildId) ?? false}
                isOwner={isOwnerMap.get(guildId) ?? false}
              />
            )
          })}
        </SortableContext>
      </div>
    </div>
  )
}

/**
 * Wrapper around MiniGuildIcon that reads Zustand so we can use hooks.
 * (Can't call hooks inside SortableFolderItem's array.map directly)
 */
function MiniGuildIconWithUnread({ guild }: { guild: DtoGuild }) {
  return <MiniGuildIcon guild={guild} />
}

// ── Main ServerSidebar ────────────────────────────────────────────────────────
export default function ServerSidebar() {
  const navigate = useNavigate()
  const { serverId } = useParams<{ serverId?: string }>()
  const queryClient = useQueryClient()
  const openCreateServer = useUiStore((s) => s.openCreateServer)
  const openJoinServer = useUiStore((s) => s.openJoinServer)
  const openServerSettings = useUiStore((s) => s.openServerSettings)

  const {
    folders,
    itemOrder,
    settingsVersion,
    syncGuilds,
    reorderItems,
    reorderFolderGuilds,
    createFolder,
    updateFolder,
    deleteFolder,
    addGuildToFolder,
    removeGuildFromFolder,
  } = useFolderStore()

  const [leavingGuild, setLeavingGuild] = useState<DtoGuild | null>(null)
  const [leaveLoading, setLeaveLoading] = useState(false)
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [editingFolder, setEditingFolder] = useState<GuildFolder | null>(null)
  const [pendingFolderGuildId, setPendingFolderGuildId] = useState<string | null>(null)

  // DnD state
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overMergeId, setOverMergeId] = useState<string | null>(null)
  const overMergeRef = useRef<string | null>(null)
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  // ── Data ──────────────────────────────────────────────────────────────────

  const { data: guilds } = useQuery({
    queryKey: ['guilds'],
    queryFn: () => userApi.userMeGuildsGet().then((r) => r.data ?? []),
  })

  // Current user for permission checks
  const currentUser = useAuthStore((s) => s.user)

  // Fetch members and roles for each guild to check permissions
  const { data: membersMap } = useQuery({
    queryKey: ['members', 'all'],
    queryFn: async () => {
      if (!guilds) return new Map<string, DtoMember[]>()
      const results = new Map<string, DtoMember[]>()
      await Promise.all(
        guilds.map(async (g) => {
          try {
            const members = await guildApi.guildGuildIdMembersGet({ guildId: String(g.id) })
            results.set(String(g.id), members.data ?? [])
          } catch {
            results.set(String(g.id), [])
          }
        }),
      )
      return results
    },
    enabled: !!guilds && guilds.length > 0,
    staleTime: 30_000,
  })

  const { data: rolesMap } = useQuery({
    queryKey: ['roles', 'all'],
    queryFn: async () => {
      if (!guilds) return new Map<string, DtoRole[]>()
      const results = new Map<string, DtoRole[]>()
      await Promise.all(
        guilds.map(async (g) => {
          try {
            const roles = await rolesApi.guildGuildIdRolesGet({ guildId: String(g.id) })
            results.set(String(g.id), roles.data ?? [])
          } catch {
            results.set(String(g.id), [])
          }
        }),
      )
      return results
    },
    enabled: !!guilds && guilds.length > 0,
    staleTime: 60_000,
  })

  // Compute canManageServer for each guild
  const canManageServerMap = useMemo(() => {
    const map = new Map<string, boolean>()
    if (!guilds || !membersMap || !rolesMap || !currentUser) return map

    for (const guild of guilds) {
      const guildId = String(guild.id)
      const members = membersMap.get(guildId) ?? []
      const roles = rolesMap.get(guildId) ?? []
      const member = members.find((m) => m.user?.id === currentUser.id)
      
      // Check if user is the owner
      const isOwner = guild.owner != null && String(guild.owner) === String(currentUser.id)
      
      if (member && roles.length > 0) {
        const effectivePermissions = calculateEffectivePermissions(member as DtoMember, roles as DtoRole[])
        const isAdmin = hasPermission(effectivePermissions, PermissionBits.ADMINISTRATOR)
        map.set(
          guildId,
          isOwner || hasPermission(effectivePermissions, PermissionBits.MANAGE_SERVER) || isAdmin,
        )
      } else {
        // Owner always has permission even if not a member
        map.set(guildId, isOwner)
      }
    }
    return map
  }, [guilds, membersMap, rolesMap, currentUser])

  // Compute isOwner for each guild
  const isOwnerMap = useMemo(() => {
    const map = new Map<string, boolean>()
    if (!guilds || !currentUser) return map

    for (const guild of guilds) {
      const guildId = String(guild.id)
      const isOwner = guild.owner != null && String(guild.owner) === String(currentUser.id)
      map.set(guildId, isOwner)
    }
    return map
  }, [guilds, currentUser])

  // Sync itemOrder when guild list changes OR when settings have just been loaded.
  // The settingsVersion dep ensures syncGuilds re-fires after loadFromSettings
  // resets itemOrder to [] (fixes the race condition where guilds arrive before
  // settings and loadFromSettings wipes the already-populated itemOrder).
  useEffect(() => {
    if (guilds) {
      syncGuilds(guilds.map((g) => String(g.id)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guilds, syncGuilds, settingsVersion])

  // Navigate away from deleted server
  useEffect(() => {
    function onGuildDelete(e: Event) {
      const detail = (e as CustomEvent<{ guild_id?: string | number } | undefined>).detail
      const deletedId = detail?.guild_id !== undefined ? String(detail.guild_id) : undefined
      if (deletedId && deletedId === serverId) {
        navigate('/app/@me', { replace: true })
      }
    }
    window.addEventListener('ws:guild_delete', onGuildDelete)
    return () => window.removeEventListener('ws:guild_delete', onGuildDelete)
  }, [serverId, navigate])

  const guildById = useMemo(() => {
    const map = new Map<string, DtoGuild>()
    for (const g of guilds ?? []) map.set(String(g.id), g)
    return map
  }, [guilds])

  const existingFolderIds = useMemo(() => new Set(folders.map((f) => `folder:${f.id}`)), [folders])
  const existingGuildItemIds = useMemo(
    () => new Set((guilds ?? []).map((g) => `guild:${String(g.id)}`)),
    [guilds],
  )

  /**
   * Flat ordered list of top-level sidebar items.
   * Expanded folder guilds are now rendered INSIDE SortableFolderItem,
   * not as separate flat items here.
   */
  const displayItems = useMemo(() => {
    const result: string[] = []
    for (const itemId of itemOrder) {
      if (existingGuildItemIds.has(itemId)) {
        result.push(itemId)
      } else if (existingFolderIds.has(itemId)) {
        result.push(itemId)
      }
    }
    return result
  }, [itemOrder, existingGuildItemIds, existingFolderIds])

  // ── Folder dialog helpers ─────────────────────────────────────────────────

  function openCreateFolder(guildId: string) {
    setPendingFolderGuildId(guildId)
    setEditingFolder(null)
    setFolderDialogOpen(true)
  }

  function openEditFolder(folder: GuildFolder) {
    setEditingFolder(folder)
    setPendingFolderGuildId(null)
    setFolderDialogOpen(true)
  }

  function handleFolderSave(name: string, color: number) {
    if (editingFolder) {
      updateFolder(editingFolder.id, name, color)
    } else {
      createFolder(name, color, pendingFolderGuildId ? [pendingFolderGuildId] : [])
    }
    setFolderDialogOpen(false)
    setEditingFolder(null)
    setPendingFolderGuildId(null)
  }

  // ── Leave guild ───────────────────────────────────────────────────────────

  async function handleLeaveGuild() {
    if (!leavingGuild) return
    setLeaveLoading(true)
    try {
      await userApi.userMeGuildsGuildIdDelete({ guildId: String(leavingGuild.id) })
      await queryClient.invalidateQueries({ queryKey: ['guilds'] })
      if (String(leavingGuild.id) === serverId) navigate('/app/@me')
    } catch {
      toast.error('Failed to leave server')
    } finally {
      setLeaveLoading(false)
      setLeavingGuild(null)
    }
  }

  // ── DnD handlers ──────────────────────────────────────────────────────────

  function onDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id))
    setOverMergeId(null)
    overMergeRef.current = null
    setDropIndicator(null)
  }

  function onDragOver(event: DragOverEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) {
      setOverMergeId(null)
      overMergeRef.current = null
      setDropIndicator(null)
      return
    }

    const activeStr = String(active.id)
    const overStr = String(over.id)

    // ── Merge highlight ──────────────────────────────────────────────────────
    // Only top-level guilds and folders can be merge targets.
    // Guilds inside folders (ifguild:) are NOT merge targets — they only
    // support reorder within the folder or extraction by dragging outside.
    const isGuildDrag = activeStr.startsWith('guild:') || activeStr.startsWith('ifguild:')
    const overMergeable =
      overStr.startsWith('guild:') ||   // top-level guild → create folder
      overStr.startsWith('folder:')     // folder → add to folder

    const shouldHighlight =
      isGuildDrag && overMergeable && isCenterOver(active, over.rect)

    if (shouldHighlight) {
      if (overMergeRef.current !== overStr) {
        setOverMergeId(overStr)
        overMergeRef.current = overStr
      }
      setDropIndicator(null) // merge mode — no position bar
    } else {
      if (overMergeRef.current !== null) {
        setOverMergeId(null)
        overMergeRef.current = null
      }

      // ── Drop indicator bar ───────────────────────────────────────────────
      // Show a colored bar above or below the target item indicating where
      // the dragged item will land.
      const translated = active.rect.current.translated
      if (translated) {
        const activeCY = translated.top + translated.height / 2
        const overCY = over.rect.top + over.rect.height / 2
        const edge: 'before' | 'after' = activeCY < overCY ? 'before' : 'after'
        setDropIndicator((prev) =>
          prev?.itemId === overStr && prev.edge === edge
            ? prev
            : { itemId: overStr, edge },
        )
      }
    }
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    const activeStr = String(active.id)

    // Capture the merge highlight state from onDragOver BEFORE clearing.
    // This is the source of truth: if the user saw a merge highlight, we merge.
    // If not (edge zone), we do a positional reorder.
    const mergeTarget = overMergeRef.current

    setActiveId(null)
    setOverMergeId(null)
    overMergeRef.current = null
    setDropIndicator(null)

    const parsedActive = parseIfGuild(activeStr)

    // ── Dropped on nothing (empty sidebar space) ──────────────────────────────
    if (!over) {
      if (parsedActive) {
        removeGuildFromFolder(parsedActive.guildId)
      }
      return
    }

    if (activeStr === String(over.id)) return
    const overStr = String(over.id)
    const parsedOver = parseIfGuild(overStr)

    // Was the drop target highlighted for merge at the moment of drop?
    const wasMerging = mergeTarget === overStr

    // ── A: Guild dropped onto a FOLDER icon (centre = add, edge = reorder) ────
    if (activeStr.startsWith('guild:') && overStr.startsWith('folder:') && wasMerging) {
      addGuildToFolder(overStr.slice(7), activeStr.slice(6))
      return
    }

    // ── B: Guild dropped onto another top-level GUILD (centre = create folder) ─
    if (activeStr.startsWith('guild:') && overStr.startsWith('guild:') && wasMerging) {
      createFolder('', 0, [activeStr.slice(6), overStr.slice(6)])
      return
    }

    // ── C: Guild-in-folder dropped onto a FOLDER icon ──────────────────────────
    if (parsedActive && overStr.startsWith('folder:')) {
      const targetFolderId = overStr.slice(7)
      if (parsedActive.folderId === targetFolderId) return // dropped on own folder — no-op
      if (wasMerging) {
        // Centre zone → move to the target folder
        removeGuildFromFolder(parsedActive.guildId)
        addGuildToFolder(targetFolderId, parsedActive.guildId)
        return
      }
      // Edge zone → extract from folder, place next to this folder in top-level order
      removeGuildFromFolder(parsedActive.guildId)
      const updatedOrder = useFolderStore.getState().itemOrder
      const guildItem = `guild:${parsedActive.guildId}`
      const guildIdx = updatedOrder.indexOf(guildItem)
      const targetIdx = updatedOrder.indexOf(overStr)
      if (guildIdx !== -1 && targetIdx !== -1 && guildIdx !== targetIdx) {
        reorderItems(arrayMove(updatedOrder, guildIdx, targetIdx))
      }
      return
    }

    // ── D: Reorder guilds within the SAME folder ──────────────────────────────
    if (parsedActive && parsedOver && parsedActive.folderId === parsedOver.folderId) {
      const folder = folders.find((f) => f.id === parsedActive.folderId)
      if (!folder) return
      const oi = folder.guildIds.indexOf(parsedActive.guildId)
      const ni = folder.guildIds.indexOf(parsedOver.guildId)
      if (oi !== -1 && ni !== -1 && oi !== ni) {
        reorderFolderGuilds(parsedActive.folderId, arrayMove(folder.guildIds, oi, ni))
      }
      return
    }

    // ── E: Guild-in-folder dropped onto guild in DIFFERENT folder → extract ───
    if (parsedActive && parsedOver && parsedActive.folderId !== parsedOver.folderId) {
      removeGuildFromFolder(parsedActive.guildId)
      return
    }

    // ── F: Guild-in-folder dropped onto top-level guild → extract + reposition ─
    if (parsedActive && overStr.startsWith('guild:')) {
      if (wasMerging) {
        // Centre zone → create a folder with both guilds
        removeGuildFromFolder(parsedActive.guildId)
        createFolder('', 0, [parsedActive.guildId, overStr.slice(6)])
        return
      }
      removeGuildFromFolder(parsedActive.guildId)
      const updatedOrder = useFolderStore.getState().itemOrder
      const guildItem = `guild:${parsedActive.guildId}`
      const guildIdx = updatedOrder.indexOf(guildItem)
      const targetIdx = updatedOrder.indexOf(overStr)
      if (guildIdx !== -1 && targetIdx !== -1 && guildIdx !== targetIdx) {
        reorderItems(arrayMove(updatedOrder, guildIdx, targetIdx))
      }
      return
    }

    // ── G: Top-level positional reorder (guild ↔ guild, folder ↔ folder, etc.) ──
    if (
      (activeStr.startsWith('guild:') || activeStr.startsWith('folder:')) &&
      (overStr.startsWith('guild:') || overStr.startsWith('folder:'))
    ) {
      const oi = itemOrder.indexOf(activeStr)
      const ni = itemOrder.indexOf(overStr)
      if (oi !== -1 && ni !== -1 && oi !== ni) {
        reorderItems(arrayMove(itemOrder, oi, ni))
      }
      return
    }
  }

  // ── Active item data (for DragOverlay) ────────────────────────────────────

  const activeGuild = activeId?.startsWith('guild:')
    ? guildById.get(activeId.slice(6))
    : undefined
  const activeIfGuildParsed = activeId ? parseIfGuild(activeId) : null
  const activeGuildInFolder = activeIfGuildParsed
    ? guildById.get(activeIfGuildParsed.guildId)
    : undefined
  const draggedGuild = activeGuild ?? activeGuildInFolder

  const activeFolder = activeId?.startsWith('folder:')
    ? folders.find((f) => `folder:${f.id}` === activeId)
    : undefined
  const activeFolderGuilds = activeFolder
    ? activeFolder.guildIds.map((id) => guildById.get(id)).filter((g): g is DtoGuild => !!g)
    : []

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={folderExtractionCollision}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        <div className="flex flex-col w-[72px] bg-sidebar border-r border-sidebar-border items-center py-3 gap-3 shrink-0 overflow-y-auto overflow-x-hidden scrollbar-none">
          {/* DMs button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => navigate('/app/@me')}
                className="w-12 h-12 squircle transition-all bg-primary flex items-center justify-center text-primary-foreground font-bold text-lg shrink-0"
              >
                GC
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Direct Messages</TooltipContent>
          </Tooltip>

          <Separator className="w-8 shrink-0" />

          {/* Sortable guild + folder items */}
          <SortableContext items={displayItems} strategy={verticalListSortingStrategy}>
            {displayItems.map((itemId) => {
              // ── Ungrouped guild ──────────────────────────────────────────────
              if (itemId.startsWith('guild:')) {
                const guildId = itemId.slice(6)
                const guild = guildById.get(guildId)
                if (!guild) return null
                return (
                  <SortableGuildIcon
                    key={itemId}
                    itemId={itemId}
                    guild={guild}
                    isActive={guildId === serverId}
                    isMergeTarget={overMergeId === itemId}
                    dropBefore={dropIndicator?.itemId === itemId && dropIndicator.edge === 'before'}
                    dropAfter={dropIndicator?.itemId === itemId && dropIndicator.edge === 'after'}
                    onNavigate={() => navigate(`/app/${guildId}`)}
                    onOpenSettings={() => openServerSettings(guildId)}
                    onLeave={() => setLeavingGuild(guild)}
                    onNewFolder={() => openCreateFolder(guildId)}
                    onAddToFolder={(fid) => addGuildToFolder(fid, guildId)}
                    folders={folders}
                    canManageServer={canManageServerMap.get(guildId) ?? false}
                    isOwner={isOwnerMap.get(guildId) ?? false}
                  />
                )
              }

              // ── Folder (collapsed or expanded with inline panel) ──────────────
              if (itemId.startsWith('folder:')) {
                const folderId = itemId.slice(7)
                const folder = folders.find((f) => f.id === folderId)
                if (!folder) return null
                const guildsInFolder = folder.guildIds
                  .map((id) => guildById.get(id))
                  .filter((g): g is DtoGuild => !!g)
                return (
                  <SortableFolderItem
                    key={itemId}
                    itemId={itemId}
                    folder={folder}
                    guildsInFolder={guildsInFolder}
                    activeServerId={serverId}
                    isDragTarget={overMergeId === itemId}
                    dropBefore={dropIndicator?.itemId === itemId && dropIndicator.edge === 'before'}
                    dropAfter={dropIndicator?.itemId === itemId && dropIndicator.edge === 'after'}
                    dropIndicator={dropIndicator}
                    onEditFolder={() => openEditFolder(folder)}
                    onDissolveFolder={() => deleteFolder(folder.id)}
                    onNavigateGuild={(gid) => navigate(`/app/${gid}`)}
                    onGuildSettings={(gid) => openServerSettings(gid)}
                    onLeaveGuild={(g) => setLeavingGuild(g)}
                    onRemoveGuildFromFolder={(gid) => removeGuildFromFolder(gid)}
                    canManageServerMap={canManageServerMap}
                    isOwnerMap={isOwnerMap}
                  />
                )
              }

              return null
            })}
          </SortableContext>

          {/* Add / Join server buttons */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={openCreateServer}
                className="w-12 h-12 squircle transition-all bg-muted flex items-center justify-center text-2xl text-muted-foreground hover:text-foreground hover:bg-primary shrink-0"
              >
                +
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Create a Server</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={openJoinServer}
                className="w-12 h-12 squircle transition-all bg-muted flex items-center justify-center text-xl text-muted-foreground hover:text-foreground hover:bg-green-600 shrink-0"
              >
                ⇢
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Join a Server</TooltipContent>
          </Tooltip>

          <div className="mt-auto" />
        </div>

        {/* Floating drag preview */}
        <DragOverlay dropAnimation={null}>
          {draggedGuild && <GuildDragPreview guild={draggedGuild} />}
          {activeFolder && <FolderDragPreview folder={activeFolder} guilds={activeFolderGuilds} />}
        </DragOverlay>
      </DndContext>

      {/* Leave server confirmation */}
      <Dialog open={!!leavingGuild} onOpenChange={(o) => !o && setLeavingGuild(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave Server</DialogTitle>
            <DialogDescription>
              Are you sure you want to leave <strong>{leavingGuild?.name}</strong>? You won't be
              able to rejoin unless you are re-invited.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLeavingGuild(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleLeaveGuild()}
              disabled={leaveLoading}
            >
              Leave Server
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Folder create / edit dialog */}
      <FolderDialog
        open={folderDialogOpen}
        folder={editingFolder}
        onClose={() => {
          setFolderDialogOpen(false)
          setEditingFolder(null)
          setPendingFolderGuildId(null)
        }}
        onSave={handleFolderSave}
      />
    </>
  )
}
