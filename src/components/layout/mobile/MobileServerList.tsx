import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Users, PlusCircle, MessageSquare, ChevronRight, ChevronDown, Folder, Settings, Copy, LogOut, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { userApi } from '@/api/client'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { useUiStore } from '@/stores/uiStore'
import { useUnreadStore } from '@/stores/unreadStore'
import { useMentionStore } from '@/stores/mentionStore'
import { useFolderStore, type GuildFolder } from '@/stores/folderStore'
import { cn } from '@/lib/utils'
import type { DtoGuild } from '@/types'
import { useTranslation } from 'react-i18next'
import UserArea from '@/components/layout/UserArea'

function colorToHex(color: number): string {
  return color ? `#${color.toString(16).padStart(6, '0')}` : ''
}

// ── Single guild row ──────────────────────────────────────────────────────────

function GuildRow({
  guild,
  onClick,
  indent,
  onSettings,
  onLeave,
}: {
  guild: DtoGuild
  onClick: () => void
  indent?: boolean
  onSettings: () => void
  onLeave: () => void
}) {
  const { t } = useTranslation()
  const guildId = String(guild.id)
  const isUnread = useUnreadStore((s) => s.isGuildUnread(guildId))
  const mentionCount = useMentionStore((s) => s.getGuildMentionCount(guildId))
  const hasMention = mentionCount > 0
  const name = guild.name ?? 'Server'
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent/50 active:bg-accent transition-colors',
            indent && 'pl-4',
          )}
        >
          <div className="relative shrink-0">
            <Avatar className="w-10 h-10 rounded-xl">
              {guild.icon?.url ? <AvatarImage src={guild.icon.url} alt={name} /> : null}
              <AvatarFallback className="rounded-xl text-xs font-bold bg-muted">{initials}</AvatarFallback>
            </Avatar>
            {hasMention && (
              <span className="absolute -bottom-1 -right-1 min-w-[16px] h-[16px] px-0.5 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center border-2 border-sidebar">
                {mentionCount > 9 ? '9+' : mentionCount}
              </span>
            )}
            {!hasMention && isUnread && (
              <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-foreground border-2 border-sidebar" />
            )}
          </div>
          <div className="flex-1 text-left min-w-0">
            <div className={cn('text-sm font-medium truncate', isUnread || hasMention ? 'text-foreground' : 'text-muted-foreground')}>
              {name}
            </div>
          </div>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onSettings} className="gap-2">
          <Settings className="w-4 h-4" />
          {t('serverSidebar.serverSettings')}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            void navigator.clipboard.writeText(guildId)
            toast.success(t('serverSettings.copied'))
          }}
          className="gap-2"
        >
          <Copy className="w-4 h-4" />
          {t('serverSidebar.copyServerId')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onLeave} className="gap-2 text-destructive focus:text-destructive">
          <LogOut className="w-4 h-4" />
          {t('serverSidebar.leaveServer')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// ── Folder section ────────────────────────────────────────────────────────────

function FolderSection({
  folder,
  guilds,
  onNavigate,
  onSettings,
  onLeaveGuild,
  onEdit,
  onDissolve,
}: {
  folder: GuildFolder
  guilds: DtoGuild[]
  onNavigate: (guildId: string) => void
  onSettings: (guildId: string) => void
  onLeaveGuild: (guild: DtoGuild) => void
  onEdit: (folder: GuildFolder) => void
  onDissolve: (folder: GuildFolder) => void
}) {
  const { toggleCollapse } = useFolderStore()
  const { t } = useTranslation()
  const isUnread = useUnreadStore((s) => guilds.some((g) => s.isGuildUnread(String(g.id))))
  const hasMentions = useMentionStore((s) => guilds.some((g) => s.hasGuildMentions(String(g.id))))
  const colorHex = folder.color ? colorToHex(folder.color) : null

  return (
    <div>
      {/* Folder header row */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={() => toggleCollapse(folder.id)}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent/50 active:bg-accent transition-colors"
          >
            {/* Mini 2×2 icon grid */}
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0"
              style={colorHex ? { backgroundColor: `${colorHex}28` } : undefined}
            >
              {guilds.length === 0 ? (
                <Folder
                  className="w-6 h-6"
                  style={colorHex ? { color: colorHex } : undefined}
                />
              ) : (
                <div className="grid grid-cols-2 gap-[3px] p-2">
                  {guilds.slice(0, 4).map((g) => {
                    const gi = (g.name ?? 'S').split(' ').map((w) => w[0]).join('').slice(0, 1).toUpperCase()
                    return (
                      <div key={String(g.id)} className="w-4 h-4 rounded-[3px] overflow-hidden bg-muted flex items-center justify-center">
                        {g.icon?.url
                          ? <img src={g.icon.url} alt="" className="w-full h-full object-cover" />
                          : <span className="text-[7px] font-bold leading-none text-muted-foreground">{gi}</span>}
                      </div>
                    )
                  })}
                  {Array.from({ length: Math.max(0, 4 - guilds.length) }).map((_, i) => (
                    <div key={i} className="w-4 h-4 rounded-[3px] bg-black/10" />
                  ))}
                </div>
              )}
            </div>

            <div className="flex-1 text-left min-w-0">
              <div
                className={cn('font-semibold truncate', isUnread || hasMentions ? 'text-foreground' : 'text-muted-foreground')}
                style={colorHex ? { color: colorHex } : undefined}
              >
                {folder.name || t('serverSidebar.folderNameDefault')}
              </div>
              <div className="text-xs text-muted-foreground">
                {guilds.length} {t('dm.servers').toLowerCase()}
              </div>
            </div>

            {folder.collapsed
              ? <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onEdit(folder)} className="gap-2">
            <Pencil className="w-4 h-4" />
            {t('serverSidebar.editFolder')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onDissolve(folder)} className="gap-2 text-destructive focus:text-destructive">
            <Trash2 className="w-4 h-4" />
            {t('serverSidebar.dissolveFolder')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Expanded guild list */}
      {!folder.collapsed && (
        <div className="ml-3 pl-3 border-l-2 space-y-0.5 mb-1" style={colorHex ? { borderColor: `${colorHex}50` } : { borderColor: 'hsl(var(--border))' }}>
          {guilds.map((guild) => (
            <GuildRow
              key={String(guild.id)}
              guild={guild}
              indent
              onClick={() => onNavigate(String(guild.id))}
              onSettings={() => onSettings(String(guild.id))}
              onLeave={() => onLeaveGuild(guild)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MobileServerList() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const openCreateServer = useUiStore((s) => s.openCreateServer)
  const openJoinServer = useUiStore((s) => s.openJoinServer)
  const openServerSettings = useUiStore((s) => s.openServerSettings)
  const { folders, itemOrder, deleteFolder, updateFolder } = useFolderStore()

  // ── Leave guild dialog ───────────────────────────────────────────────────
  const [leavingGuild, setLeavingGuild] = useState<DtoGuild | null>(null)
  const [leaveLoading, setLeaveLoading] = useState(false)

  async function handleLeaveGuild() {
    if (!leavingGuild) return
    setLeaveLoading(true)
    try {
      await userApi.userMeGuildsGuildIdDelete({ guildId: String(leavingGuild.id) })
      await queryClient.invalidateQueries({ queryKey: ['guilds'] })
      setLeavingGuild(null)
      navigate('/app')
    } catch {
      toast.error(t('serverSidebar.leaveServer'))
    } finally {
      setLeaveLoading(false)
    }
  }

  // ── Edit folder dialog ───────────────────────────────────────────────────
  const [editingFolder, setEditingFolder] = useState<GuildFolder | null>(null)
  const [folderName, setFolderName] = useState('')

  function openEditFolder(folder: GuildFolder) {
    setEditingFolder(folder)
    setFolderName(folder.name)
  }

  function handleSaveFolder() {
    if (!editingFolder) return
    updateFolder(editingFolder.id, folderName, editingFolder.color)
    setEditingFolder(null)
  }

  // ── Guild query ──────────────────────────────────────────────────────────
  const { data: guilds = [] } = useQuery({
    queryKey: ['guilds'],
    queryFn: () => userApi.userMeGuildsGet().then((r) => r.data ?? []),
  })

  const guildMap = new Map<string, DtoGuild>(guilds.map((g) => [String(g.id), g]))

  type Item =
    | { kind: 'guild'; guild: DtoGuild }
    | { kind: 'folder'; folder: GuildFolder; guilds: DtoGuild[] }

  const orderedItems: Item[] = itemOrder
    .map((entry): Item | null => {
      if (entry.startsWith('folder:')) {
        const folder = folders.find((f) => f.id === entry.slice(7))
        if (!folder) return null
        const folderGuilds = folder.guildIds.map((id) => guildMap.get(id)).filter((g): g is DtoGuild => !!g)
        return { kind: 'folder', folder, guilds: folderGuilds }
      }
      if (entry.startsWith('guild:')) {
        const guild = guildMap.get(entry.slice(6))
        if (!guild) return null
        return { kind: 'guild', guild }
      }
      return null
    })
    .filter((item): item is Item => item !== null)

  return (
    <div className="flex flex-col h-full bg-sidebar">
      {/* App header */}
      <div className="h-14 flex items-center px-5 border-b border-sidebar-border shrink-0">
        <MessageSquare className="w-5 h-5 mr-2 text-primary" />
        <span className="font-bold text-lg tracking-tight">GoChat</span>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-3 py-3 space-y-1">
          {/* Friends / DMs shortcut */}
          <button
            onClick={() => navigate('/app/@me')}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent/50 active:bg-accent transition-colors"
          >
            <div className="w-12 h-12 rounded-2xl bg-primary/15 flex items-center justify-center shrink-0">
              <Users className="w-6 h-6 text-primary" />
            </div>
            <div className="flex-1 text-left min-w-0">
              <div className="font-semibold text-foreground">{t('dm.friends')}</div>
              <div className="text-sm text-muted-foreground">{t('dm.directMessages')}</div>
            </div>
          </button>

          {orderedItems.length > 0 && (
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest px-3 pt-3 pb-1">
              {t('dm.servers')}
            </p>
          )}

          {orderedItems.map((item) =>
            item.kind === 'folder' ? (
              <FolderSection
                key={item.folder.id}
                folder={item.folder}
                guilds={item.guilds}
                onNavigate={(guildId) => navigate(`/app/${guildId}`)}
                onSettings={(guildId) => openServerSettings(guildId)}
                onLeaveGuild={(guild) => setLeavingGuild(guild)}
                onEdit={openEditFolder}
                onDissolve={(folder) => deleteFolder(folder.id)}
              />
            ) : (
              <GuildRow
                key={String(item.guild.id)}
                guild={item.guild}
                onClick={() => navigate(`/app/${String(item.guild.id)}`)}
                onSettings={() => openServerSettings(String(item.guild.id))}
                onLeave={() => setLeavingGuild(item.guild)}
              />
            ),
          )}
        </div>
      </ScrollArea>

      {/* Bottom action buttons */}
      <div className="p-4 flex gap-2 border-t border-sidebar-border shrink-0">
        <Button variant="outline" className="flex-1" onClick={openJoinServer}>
          {t('modals.joinServer')}
        </Button>
        <Button className="flex-1" onClick={openCreateServer}>
          <PlusCircle className="w-4 h-4 mr-1.5" />
          {t('common.create')}
        </Button>
      </div>

      {/* User area */}
      <div className="px-2 pb-2 shrink-0">
        <UserArea />
      </div>

      {/* Leave guild confirmation dialog */}
      <Dialog open={!!leavingGuild} onOpenChange={(open) => { if (!open) setLeavingGuild(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('serverSidebar.leaveServer')}</DialogTitle>
            <DialogDescription>
              {t('serverSidebar.leaveServerConfirm', { name: leavingGuild?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLeavingGuild(null)} disabled={leaveLoading}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void handleLeaveGuild()} disabled={leaveLoading}>
              {t('serverSidebar.leaveServer')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit folder dialog */}
      <Dialog open={!!editingFolder} onOpenChange={(open) => { if (!open) setEditingFolder(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('serverSidebar.editFolderTitle')}</DialogTitle>
            <DialogDescription>{t('serverSidebar.editFolderDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('serverSidebar.folderName')}</label>
            <Input
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder={t('serverSidebar.folderNameDefault')}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveFolder() }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingFolder(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSaveFolder}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
