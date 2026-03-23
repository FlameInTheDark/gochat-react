import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Users, MessageSquare, X, XCircle, ChevronLeft, UserPlus, UserMinus, Check, MessageCircle } from 'lucide-react'
import { toast } from 'sonner'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import StatusDot from '@/components/ui/StatusDot'
import { userApi } from '@/api/client'
import { ChannelType } from '@/types'
import type { DtoChannel, DtoUser } from '@/types'
import { cn } from '@/lib/utils'
import { usePresenceStore } from '@/stores/presenceStore'
import { addPresenceSubscription } from '@/services/wsService'
import UserArea from './UserArea'
import { useTranslation } from 'react-i18next'
import { useClientMode } from '@/hooks/useClientMode'

type MobileTab = 'messages' | 'friends' | 'pending' | 'add'

export default function DmSidebar() {
  const navigate = useNavigate()
  const { userId: activeChannelId } = useParams<{ userId?: string }>()
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const isMobile = useClientMode() === 'mobile'
  const [mobileTab, setMobileTab] = useState<MobileTab>('messages')

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
      if (String(channel.id) === activeChannelId) {
        navigate('/app/@me')
      }
      queryClient.setQueryData<DtoChannel[]>(['dm-channels'], (old) =>
        old?.filter((c) => String(c.id) !== String(channel.id)) ?? [],
      )
    } catch {
      toast.error(t('dm.closeDmFailed'))
      await queryClient.invalidateQueries({ queryKey: ['dm-channels'] })
    }
  }

  // ── Mobile tabs ─────────────────────────────────────────────────────────────

  const MOBILE_TABS: { key: MobileTab; label: string }[] = [
    { key: 'messages', label: t('dm.tabMessages') },
    { key: 'friends', label: t('friends.tabAll') },
    { key: 'pending', label: t('friends.tabPending') },
    { key: 'add', label: t('friends.tabAdd') },
  ]

  return (
    <div className={cn('flex flex-col bg-sidebar border-r border-sidebar-border', isMobile ? 'w-full flex-1 min-h-0' : 'w-60 shrink-0')}>
      {/* Mobile: back to server list */}
      {isMobile && (
        <button
          onClick={() => navigate('/app')}
          className="flex items-center gap-2 px-3 h-10 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0 border-b border-sidebar-border"
        >
          <ChevronLeft className="w-4 h-4" />
          {t('dm.allServers')}
        </button>
      )}

      {/* Mobile tab bar */}
      {isMobile ? (
        <div className="flex border-b border-sidebar-border shrink-0">
          {MOBILE_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setMobileTab(tab.key)}
              className={cn(
                'flex-1 py-2.5 text-xs font-medium transition-colors border-b-2',
                mobileTab === tab.key
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : (
        /* Desktop header */
        <div className="h-12 flex items-center px-3 font-semibold border-b border-sidebar-border shrink-0">
          <span className="text-sm">{t('dm.title')}</span>
        </div>
      )}

      {/* ── Content ─────────────────────────────────────────────────────────── */}

      {/* Messages tab (desktop always, mobile when tab === 'messages') */}
      {(!isMobile || mobileTab === 'messages') && (
        <ScrollArea className="flex-1">
          <div className="p-2">
            {/* Friends link — desktop only (mobile has tabs) */}
            {!isMobile && (
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
            )}

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
              .sort((a, b) => {
                const aId = a.last_message_id ? BigInt(String(a.last_message_id)) : 0n
                const bId = b.last_message_id ? BigInt(String(b.last_message_id)) : 0n
                return bId > aId ? 1 : bId < aId ? -1 : 0
              })
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
      )}

      {/* Friends tab — mobile only */}
      {isMobile && mobileTab === 'friends' && <MobileFriendList />}

      {/* Pending tab — mobile only */}
      {isMobile && mobileTab === 'pending' && <MobilePendingRequests />}

      {/* Add friend tab — mobile only */}
      {isMobile && mobileTab === 'add' && <MobileAddFriend />}

      <Separator />
      <div className="p-2 shrink-0">
        <UserArea />
      </div>
    </div>
  )
}

// ── Mobile Friends List ────────────────────────────────────────────────────────

function MobileFriendList() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { t } = useTranslation()

  const { data: friends = [], isLoading } = useQuery({
    queryKey: ['friends'],
    queryFn: () => userApi.userMeFriendsGet().then((r) => r.data ?? []),
  })

  useEffect(() => {
    if (friends.length > 0) {
      addPresenceSubscription(friends.map((f) => String(f.id)))
    }
  }, [friends])

  async function openDm(user: DtoUser) {
    try {
      const res = await userApi.userMeFriendsUserIdGet({ userId: String(user.id) })
      const channel = res.data
      await queryClient.invalidateQueries({ queryKey: ['dm-channels'] })
      if (channel.id !== undefined) {
        navigate(`/app/@me/${String(channel.id)}`)
      }
    } catch {
      toast.error(t('friends.dmFailed'))
    }
  }

  async function unfriend(user: DtoUser) {
    try {
      await userApi.userMeFriendsDelete({ request: { user_id: user.id as number } })
      await queryClient.invalidateQueries({ queryKey: ['friends'] })
      toast.success(t('friends.unfriended', { name: user.name ?? 'user' }))
    } catch {
      toast.error(t('friends.unfriendFailed'))
    }
  }

  if (isLoading) {
    return (
      <div className="flex-1 p-4 space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    )
  }

  if (friends.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2 p-8">
        <UserPlus className="w-12 h-12 opacity-30" />
        <p className="text-sm">{t('friends.noFriends')}</p>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div className="p-3">
        <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-2 px-1">
          {t('friends.allFriends', { count: friends.length })}
        </p>
        <div className="space-y-0.5">
          {friends.map((user) => (
            <MobileFriendRow
              key={String(user.id)}
              user={user}
              onOpenDm={() => void openDm(user)}
              onUnfriend={() => void unfriend(user)}
            />
          ))}
        </div>
      </div>
    </ScrollArea>
  )
}

function MobileFriendRow({ user, onOpenDm, onUnfriend }: { user: DtoUser; onOpenDm: () => void; onUnfriend: () => void }) {
  const { t } = useTranslation()
  const userId = String(user.id)
  const status = usePresenceStore((s) => s.statuses[userId] ?? 'offline')
  const customStatus = usePresenceStore((s) => s.customStatuses[userId] ?? '')
  const initials = (user.name ?? '?').charAt(0).toUpperCase()

  return (
    <div className="flex items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-accent/50">
      <div className="relative shrink-0">
        <Avatar className="w-10 h-10">
          <AvatarImage src={user.avatar?.url} alt={user.name ?? ''} className="object-cover" />
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <StatusDot status={status} className="absolute -bottom-0.5 -right-0.5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{user.name}</p>
        {customStatus ? (
          <p className="text-xs text-muted-foreground truncate italic">{customStatus}</p>
        ) : (
          <p className="text-xs text-muted-foreground capitalize">
            {status === 'dnd' ? t('friends.doNotDisturb') : status}
          </p>
        )}
      </div>
      <div className="flex gap-1 shrink-0">
        <Button size="icon" variant="ghost" className="w-8 h-8" onClick={onOpenDm} title={t('friends.message')}>
          <MessageCircle className="w-4 h-4" />
        </Button>
        <Button size="icon" variant="ghost" className="w-8 h-8 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={onUnfriend} title={t('friends.removeFriend')}>
          <UserMinus className="w-4 h-4" />
        </Button>
      </div>
    </div>
  )
}

// ── Mobile Pending Requests ────────────────────────────────────────────────────

function MobilePendingRequests() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ['friend-requests'],
    queryFn: () => userApi.userMeFriendsRequestsGet().then((r) => r.data ?? []),
  })

  async function accept(user: DtoUser) {
    try {
      await userApi.userMeFriendsRequestsPost({ request: { user_id: user.id as number } })
      await queryClient.invalidateQueries({ queryKey: ['friend-requests'] })
      await queryClient.invalidateQueries({ queryKey: ['friends'] })
      toast.success(t('friends.accepted', { name: user.name ?? 'user' }))
    } catch {
      toast.error(t('friends.acceptFailed'))
    }
  }

  async function decline(user: DtoUser) {
    try {
      await userApi.userMeFriendsRequestsDelete({ request: { user_id: user.id as number } })
      await queryClient.invalidateQueries({ queryKey: ['friend-requests'] })
      toast.success(t('friends.declined'))
    } catch {
      toast.error(t('friends.declineFailed'))
    }
  }

  if (isLoading) {
    return (
      <div className="flex-1 p-4 space-y-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    )
  }

  if (requests.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2 p-8">
        <Check className="w-12 h-12 opacity-30" />
        <p className="text-sm">{t('friends.noPending')}</p>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div className="p-3">
        <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-2 px-1">
          {t('friends.incoming', { count: requests.length })}
        </p>
        <div className="space-y-0.5">
          {requests.map((user) => {
            const initials = (user.name ?? '?').charAt(0).toUpperCase()
            return (
              <div key={String(user.id)} className="flex items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-accent/50">
                <Avatar className="w-10 h-10 shrink-0">
                  <AvatarImage src={user.avatar?.url} alt={user.name ?? ''} className="object-cover" />
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{user.name}</p>
                  {user.discriminator && (
                    <p className="text-xs text-muted-foreground truncate">@{user.discriminator}</p>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button size="icon" variant="ghost" className="w-8 h-8 text-green-500 hover:text-green-400 hover:bg-green-500/10" onClick={() => void accept(user)} title={t('friends.accept')}>
                    <Check className="w-4 h-4" />
                  </Button>
                  <Button size="icon" variant="ghost" className="w-8 h-8 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => void decline(user)} title={t('friends.decline')}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </ScrollArea>
  )
}

// ── Mobile Add Friend ──────────────────────────────────────────────────────────

function MobileAddFriend() {
  const [discriminator, setDiscriminator] = useState('')
  const [loading, setLoading] = useState(false)
  const { t } = useTranslation()

  async function sendRequest() {
    const trimmed = discriminator.trim()
    if (!trimmed) return
    setLoading(true)
    try {
      await userApi.userMeFriendsPost({ request: { discriminator: trimmed } })
      setDiscriminator('')
      toast.success(t('friends.requestSent'))
    } catch {
      toast.error(t('friends.requestFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 p-4">
      <h3 className="font-semibold mb-1">{t('friends.addFriendTitle')}</h3>
      <p className="text-sm text-muted-foreground mb-4">{t('friends.addFriendDesc')}</p>
      <div className="flex flex-col gap-2">
        <Input
          value={discriminator}
          onChange={(e) => setDiscriminator(e.target.value)}
          placeholder={t('friends.usernamePlaceholder')}
          onKeyDown={(e) => e.key === 'Enter' && void sendRequest()}
        />
        <Button onClick={() => void sendRequest()} disabled={loading || !discriminator.trim()}>
          {t('friends.sendRequest')}
        </Button>
      </div>
    </div>
  )
}

// ── DM Item ───────────────────────────────────────────────────────────────────

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

  const displayName = isGroup
    ? (channel.name ?? t('dm.groupDm'))
    : (participantUser?.name ?? channel.name ?? `User ${String(channel.participant_id ?? '')}`)
  const initials = (participantUser?.name ?? displayName).charAt(0).toUpperCase()

  const status = usePresenceStore((s) =>
    participantId ? (s.statuses[participantId] ?? 'offline') : null,
  )
  const customStatus = usePresenceStore((s) =>
    participantId ? (s.customStatuses[participantId] ?? '') : '',
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={onNavigate}
          className={cn(
            'w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors group text-left',
            isActive
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
          )}
        >
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
      </ContextMenuTrigger>
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
