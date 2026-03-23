import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { UserPlus, MessageSquare, UserMinus, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { motion, AnimatePresence } from 'motion/react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import StatusDot from '@/components/ui/StatusDot'
import { cn } from '@/lib/utils'
import { userApi } from '@/api/client'
import { usePresenceStore } from '@/stores/presenceStore'
import { addPresenceSubscription } from '@/services/wsService'
import type { DtoUser } from '@/types'
import { useTranslation } from 'react-i18next'

type Tab = 'all' | 'pending' | 'add'

export default function MePage() {
  const [tab, setTab] = useState<Tab>('all')
  const { t } = useTranslation()

  useEffect(() => {
    document.title = 'Friends — GoChat'
    return () => { document.title = 'GoChat' }
  }, [])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="h-12 flex items-center gap-4 px-4 border-b border-border shrink-0">
        <span className="font-semibold text-sm">{t('friends.title')}</span>
        <Separator orientation="vertical" className="h-5" />
        <nav className="flex gap-1">
          {(['all', 'pending', 'add'] as const).map((tabKey) => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={cn(
                'relative px-3 py-1 rounded text-sm transition-colors z-10',
                tabKey === tab
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tabKey === tab && (
                <motion.div
                  layoutId="friends-tab-bg"
                  className="absolute inset-0 bg-accent rounded"
                  transition={{ type: 'spring', damping: 22, stiffness: 300 }}
                />
              )}
              <span className="relative z-10">
                {tabKey === 'add' ? t('friends.tabAdd') : tabKey === 'all' ? t('friends.tabAll') : t('friends.tabPending')}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto relative">
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
          >
            {tab === 'all' && <FriendList />}
            {tab === 'pending' && <PendingRequests />}
            {tab === 'add' && <AddFriend />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

function FriendList() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { t } = useTranslation()

  const { data: friends = [], isLoading } = useQuery({
    queryKey: ['friends'],
    queryFn: () => userApi.userMeFriendsGet().then((r) => r.data ?? []),
  })

  // Subscribe to presence for all friends
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
      await userApi.userMeFriendsDelete({
        request: { user_id: user.id as number },
      })
      await queryClient.invalidateQueries({ queryKey: ['friends'] })
      toast.success(t('friends.unfriended', { name: user.name ?? 'user' }))
    } catch (e) {
      console.error('Failed to unfriend:', e)
      toast.error(t('friends.unfriendFailed'))
    }
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    )
  }

  if (friends.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 p-8">
        <UserPlus className="w-12 h-12 opacity-30" />
        <p className="text-sm">{t('friends.noFriends')}</p>
      </div>
    )
  }

  return (
    <div className="p-4">
      <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-3">
        {t('friends.allFriends', { count: friends.length })}
      </p>
      <div className="space-y-0.5">
        {friends.map((user) => (
          <FriendRow
            key={String(user.id)}
            user={user}
            onOpenDm={() => void openDm(user)}
            onUnfriend={() => void unfriend(user)}
          />
        ))}
      </div>
    </div>
  )
}

function PendingRequests() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ['friend-requests'],
    queryFn: () => userApi.userMeFriendsRequestsGet().then((r) => r.data ?? []),
  })

  async function accept(user: DtoUser) {
    try {
      await userApi.userMeFriendsRequestsPost({
        request: { user_id: user.id as number },
      })
      await queryClient.invalidateQueries({ queryKey: ['friend-requests'] })
      await queryClient.invalidateQueries({ queryKey: ['friends'] })
      toast.success(t('friends.accepted', { name: user.name ?? 'user' }))
    } catch (e) {
      console.error('Failed to accept friend request:', e)
      toast.error(t('friends.acceptFailed'))
    }
  }

  async function decline(user: DtoUser) {
    try {
      await userApi.userMeFriendsRequestsDelete({
        request: { user_id: user.id as number },
      })
      await queryClient.invalidateQueries({ queryKey: ['friend-requests'] })
      toast.success(t('friends.declined'))
    } catch (e) {
      console.error('Failed to decline friend request:', e)
      toast.error(t('friends.declineFailed'))
    }
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    )
  }

  if (requests.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 p-8">
        <Check className="w-12 h-12 opacity-30" />
        <p className="text-sm">{t('friends.noPending')}</p>
      </div>
    )
  }

  return (
    <div className="p-4">
      <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-3">
        {t('friends.incoming', { count: requests.length })}
      </p>
      <div className="space-y-0.5">
        {requests.map((user) => (
          <div
            key={String(user.id)}
            className="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-accent/50 group"
          >
            <UserAvatar user={user} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{user.name}</p>
              {user.discriminator && (
                <p className="text-xs text-muted-foreground truncate">@{user.discriminator}</p>
              )}
            </div>
            <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <Button
                size="icon"
                variant="ghost"
                className="w-8 h-8 text-green-500 hover:text-green-400 hover:bg-green-500/10"
                onClick={() => void accept(user)}
                title={t('friends.accept')}
              >
                <Check className="w-4 h-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="w-8 h-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => void decline(user)}
                title={t('friends.decline')}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function AddFriend() {
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
    <div className="p-6 max-w-xl">
      <h3 className="font-semibold mb-1">{t('friends.addFriendTitle')}</h3>
      <p className="text-sm text-muted-foreground mb-4">
        {t('friends.addFriendDesc')}
      </p>
      <div className="flex gap-2">
        <Input
          value={discriminator}
          onChange={(e) => setDiscriminator(e.target.value)}
          placeholder={t('friends.usernamePlaceholder')}
          onKeyDown={(e) => e.key === 'Enter' && void sendRequest()}
          className="flex-1"
        />
        <Button onClick={() => void sendRequest()} disabled={loading || !discriminator.trim()}>
          {t('friends.sendRequest')}
        </Button>
      </div>
    </div>
  )
}

function FriendRow({
  user,
  onOpenDm,
  onUnfriend,
}: {
  user: DtoUser
  onOpenDm: () => void
  onUnfriend: () => void
}) {
  const userId = String(user.id)
  const status = usePresenceStore((s) => s.statuses[userId] ?? 'offline')
  const customStatus = usePresenceStore((s) => s.customStatuses[userId] ?? '')

  const { t } = useTranslation()

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-accent/50 group">
      <UserAvatar user={user} />
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
      <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          size="icon"
          variant="ghost"
          className="w-8 h-8"
          onClick={onOpenDm}
          title={t('friends.message')}
        >
          <MessageSquare className="w-4 h-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="w-8 h-8 text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={onUnfriend}
          title={t('friends.removeFriend')}
        >
          <UserMinus className="w-4 h-4" />
        </Button>
      </div>
    </div>
  )
}

function UserAvatar({ user }: { user: DtoUser }) {
  const initials = (user.name ?? '?').charAt(0).toUpperCase()
  const status = usePresenceStore((s) => s.statuses[String(user.id)] ?? 'offline')
  return (
    <div className="relative shrink-0">
      <Avatar className="w-9 h-9">
        <AvatarImage src={user.avatar?.url} alt={user.name ?? ''} className="object-cover" />
        <AvatarFallback>{initials}</AvatarFallback>
      </Avatar>
      <StatusDot status={status} className="absolute -bottom-0.5 -right-0.5" />
    </div>
  )
}
