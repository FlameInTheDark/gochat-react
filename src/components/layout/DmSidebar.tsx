import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Users, MessageSquare, X, XCircle, ChevronLeft } from 'lucide-react'
import { toast } from 'sonner'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import StatusDot from '@/components/ui/StatusDot'
import { userApi } from '@/api/client'
import { ChannelType } from '@/types'
import type { DtoChannel } from '@/types'
import { cn } from '@/lib/utils'
import { usePresenceStore } from '@/stores/presenceStore'
import { addPresenceSubscription } from '@/services/wsService'
import UserArea from './UserArea'
import { useTranslation } from 'react-i18next'
import { useClientMode } from '@/hooks/useClientMode'

export default function DmSidebar() {
  const navigate = useNavigate()
  const { userId: activeChannelId } = useParams<{ userId?: string }>()
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const isMobile = useClientMode() === 'mobile'

  const { data: dmChannels = [] } = useQuery({
    queryKey: ['dm-channels'],
    queryFn: () => userApi.userMeChannelsGet().then((r) => r.data ?? []),
  })

  // Subscribe to presence for all DM participants (1-on-1 DMs have participant_id)
  useEffect(() => {
    const participantIds = dmChannels
      .filter((ch) => ch.type === ChannelType.ChannelTypeDM && ch.participant_id !== undefined)
      .map((ch) => String(ch.participant_id))
    if (participantIds.length > 0) {
      addPresenceSubscription(participantIds)
    }
  }, [dmChannels])

  async function handleCloseDm(channel: DtoChannel, e: React.MouseEvent) {
    e.stopPropagation()
    try {
      // Navigate away first if this DM is active
      if (String(channel.id) === activeChannelId) {
        navigate('/app/@me')
      }
      // Optimistic removal
      queryClient.setQueryData<DtoChannel[]>(['dm-channels'], (old) =>
        old?.filter((c) => String(c.id) !== String(channel.id)) ?? [],
      )
    } catch {
      toast.error(t('dm.closeDmFailed'))
      await queryClient.invalidateQueries({ queryKey: ['dm-channels'] })
    }
  }

  return (
    <div className={cn('flex flex-col bg-sidebar border-r border-sidebar-border', isMobile ? 'w-full flex-1 min-h-0' : 'w-60 shrink-0')}>
      {/* Mobile: back to server list */}
      {isMobile && (
        <button
          onClick={() => navigate('/app')}
          className="flex items-center gap-2 px-3 h-10 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0 border-b border-sidebar-border"
        >
          <ChevronLeft className="w-4 h-4" />
          All Servers
        </button>
      )}
      {/* Header */}
      <div className="h-12 flex items-center px-3 font-semibold border-b border-sidebar-border shrink-0">
        <span className="text-sm">{t('dm.title')}</span>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2">
          {/* Friends link */}
          <button
            onClick={() => navigate('/app/@me')}
            className={cn(
              'w-full flex items-center gap-3 px-2 py-2 rounded text-sm transition-colors mb-1',
              !activeChannelId
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
            )}
          >
            <Users className="w-4 h-4 shrink-0" />
            <span className="font-medium">{t('dm.friends')}</span>
          </button>

          {/* DM section header */}
          {dmChannels.length > 0 && (
            <p className="px-2 pt-3 pb-1 text-xs font-semibold uppercase text-muted-foreground tracking-wider">
              {t('dm.directMessages')}
            </p>
          )}

          {/* DM channel list */}
          {dmChannels
            .filter(
              (ch) =>
                ch.type === ChannelType.ChannelTypeDM ||
                ch.type === ChannelType.ChannelTypeGroupDM,
            )
            .map((ch) => (
              <DmItem
                key={String(ch.id)}
                channel={ch}
                isActive={String(ch.id) === activeChannelId}
                onNavigate={() => navigate(`/app/@me/${String(ch.id)}`)}
                onClose={(e) => void handleCloseDm(ch, e)}
              />
            ))}
        </div>
      </ScrollArea>

      <Separator />
      <div className="p-2 shrink-0">
        <UserArea />
      </div>
    </div>
  )
}

function DmItem({
  channel,
  isActive,
  onNavigate,
  onClose,
}: {
  channel: DtoChannel
  isActive: boolean
  onNavigate: () => void
  onClose: (e: React.MouseEvent) => void
}) {
  const { t } = useTranslation()
  const isGroup = channel.type === ChannelType.ChannelTypeGroupDM

  // For 1-on-1 DMs, fetch participant user data
  const participantId = !isGroup && channel.participant_id !== undefined
    ? String(channel.participant_id)
    : null

  const { data: participantUser } = useQuery({
    queryKey: ['user', participantId],
    queryFn: async () => {
      if (!participantId) return null
      try {
        const res = await userApi.userUserIdGet({ userId: participantId })
        return res.data ?? null
      } catch (err) {
        console.error('Failed to fetch user:', err)
        return null
      }
    },
    enabled: !!participantId,
    staleTime: 5 * 60 * 1000,
  })

  // For 1-on-1 DMs, always prefer participant's name; for group DMs use channel name or fallback
  const displayName = isGroup 
    ? (channel.name ?? t('dm.groupDm'))
    : (participantUser?.name ?? channel.name ?? `User ${String(channel.participant_id ?? '')}`)
  const initials = (participantUser?.name ?? displayName).charAt(0).toUpperCase()

  // For 1-on-1 DMs, show participant presence + custom status
  const status = usePresenceStore((s) =>
    participantId ? (s.statuses[participantId] ?? 'offline') : null,
  )
  const customStatus = usePresenceStore((s) =>
    participantId ? (s.customStatuses[participantId] ?? '') : '',
  )

  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              onClick={onNavigate}
              className={cn(
                'w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors group text-left',
                isActive
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
              )}
            >
              {/* Avatar with optional status dot */}
              <div className="relative shrink-0">
              <Avatar className="w-8 h-8">
                  {!isGroup && participantUser?.avatar?.url ? (
                    <AvatarImage src={participantUser.avatar.url} alt={displayName} className="object-cover" />
                  ) : null}
                  <AvatarFallback className="text-xs">
                    {isGroup ? <MessageSquare className="w-4 h-4" /> : initials}
                  </AvatarFallback>
                </Avatar>
                {status !== null && (
                  <StatusDot status={status} className="absolute -bottom-0.5 -right-0.5 w-3 h-3" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <span className="block truncate">{displayName}</span>
                {customStatus && (
                  <span className="block text-xs text-muted-foreground italic truncate">
                    {customStatus}
                  </span>
                )}
              </div>
              <span
                role="button"
                tabIndex={-1}
                onClick={onClose}
                onKeyDown={(e) => e.key === 'Enter' && onClose(e as unknown as React.MouseEvent)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent/80 hover:text-foreground transition-opacity shrink-0"
              >
                <X className="w-3 h-3" />
              </span>
            </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="right">
          <p>{displayName}</p>
          {customStatus && <p className="text-xs italic">{customStatus}</p>}
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={(e) => onClose(e as unknown as React.MouseEvent)}
          className="gap-2"
        >
          <XCircle className="w-4 h-4" />
          {t('dm.closeConversation')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function useDmChannels() {
  return useQuery({
    queryKey: ['dm-channels'],
    queryFn: () => userApi.userMeChannelsGet().then((r) => r.data ?? []),
  })
}

export function useOpenDm() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  return async (userId: string) => {
    try {
      const res = await userApi.userMeFriendsUserIdGet({ userId })
      const channel = res.data
      await queryClient.invalidateQueries({ queryKey: ['dm-channels'] })
      if (channel.id !== undefined) {
        navigate(`/app/@me/${String(channel.id)}`)
      }
    } catch {
      toast.error('Failed to open DM')
    }
  }
}
