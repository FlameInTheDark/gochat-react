import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Users, PlusCircle, Hash, MessageSquare } from 'lucide-react'
import { userApi } from '@/api/client'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { useUiStore } from '@/stores/uiStore'
import { useUnreadStore } from '@/stores/unreadStore'
import { useMentionStore } from '@/stores/mentionStore'
import { cn } from '@/lib/utils'
import type { DtoGuild } from '@/types'

export default function MobileServerList() {
  const navigate = useNavigate()
  const openCreateServer = useUiStore((s) => s.openCreateServer)
  const openJoinServer = useUiStore((s) => s.openJoinServer)
  const isGuildUnread = useUnreadStore((s) => s.isGuildUnread)
  const hasGuildMentions = useMentionStore((s) => s.hasGuildMentions)
  const getGuildMentionCount = useMentionStore((s) => s.getGuildMentionCount)

  const { data: guilds = [] } = useQuery({
    queryKey: ['guilds'],
    queryFn: () => userApi.userMeGuildsGet().then((r) => r.data ?? []),
  })

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
              <div className="font-semibold text-foreground">Friends &amp; DMs</div>
              <div className="text-sm text-muted-foreground">Direct Messages</div>
            </div>
          </button>

          {guilds.length > 0 && (
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest px-3 pt-3 pb-1">
              Servers
            </p>
          )}

          {guilds.map((guild: DtoGuild) => {
            const guildId = String(guild.id)
            const name = guild.name ?? 'Server'
            const initials = name
              .split(' ')
              .map((w) => w[0])
              .join('')
              .slice(0, 2)
              .toUpperCase()
            const unread = isGuildUnread(guildId)
            const mention = hasGuildMentions(guildId)
            const mentionCount = getGuildMentionCount(guildId)

            return (
              <button
                key={guildId}
                onClick={() => navigate(`/app/${guildId}`)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent/50 active:bg-accent transition-colors"
              >
                <div className="relative shrink-0">
                  <Avatar className="w-12 h-12 rounded-2xl">
                    {guild.icon?.url ? <AvatarImage src={guild.icon.url} alt={name} /> : null}
                    <AvatarFallback className="rounded-2xl text-sm font-bold bg-muted">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  {mention && (
                    <span className="absolute -bottom-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center border-2 border-sidebar">
                      {mentionCount > 9 ? '9+' : mentionCount}
                    </span>
                  )}
                  {!mention && unread && (
                    <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-foreground border-2 border-sidebar" />
                  )}
                </div>
                <div className="flex-1 text-left min-w-0">
                  <div
                    className={cn(
                      'font-medium truncate',
                      unread || mention ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {name}
                  </div>
                </div>
                <Hash className="w-4 h-4 text-muted-foreground/50 shrink-0" />
              </button>
            )
          })}
        </div>
      </ScrollArea>

      {/* Bottom action buttons */}
      <div className="p-4 flex gap-2 border-t border-sidebar-border shrink-0">
        <Button variant="outline" className="flex-1" onClick={openJoinServer}>
          Join Server
        </Button>
        <Button className="flex-1" onClick={openCreateServer}>
          <PlusCircle className="w-4 h-4 mr-1.5" />
          Create
        </Button>
      </div>
    </div>
  )
}
