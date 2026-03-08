import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { guildApi } from '@/api/client'
import { useTypingStore, type TypingUser } from '@/stores/typingStore'
import { useAuthStore } from '@/stores/authStore'

// Stable fallback so `useTypingStore` selector never returns a new [] reference
// when the channel has no typers — prevents Zustand infinite re-render loop.
const EMPTY_TYPERS: TypingUser[] = []

interface Props {
  channelId: string
  serverId: string
}

export default function TypingIndicator({ channelId, serverId }: Props) {
  const { t } = useTranslation()
  const currentUserId = useAuthStore((s) =>
    s.user?.id !== undefined ? String(s.user.id) : null,
  )

  // Use stable EMPTY_TYPERS reference when no one is typing for this channel,
  // so Zustand's Object.is comparison doesn't see a change every render.
  const typingUsers = useTypingStore((s) => s.typingUsers[channelId] ?? EMPTY_TYPERS)

  // Resolve usernames from the already-loaded members cache (no extra request)
  const { data: members } = useQuery({
    queryKey: ['members', serverId],
    queryFn: () =>
      guildApi.guildGuildIdMembersGet({ guildId: serverId }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: 30_000,
  })

  const now = Date.now()
  const others = typingUsers.filter(
    (u) => u.userId !== currentUserId && u.expiresAt > now,
  )

  if (others.length === 0) return null

  function resolveName(userId: string): string {
    const member = members?.find((m) => String(m.user?.id) === userId)
    return member?.username ?? member?.user?.name ?? userId
  }

  let text: string
  if (others.length === 1) {
    text = t('chat.typingOne', { name: resolveName(others[0].userId) })
  } else if (others.length === 2) {
    text = t('chat.typingTwo', {
      name1: resolveName(others[0].userId),
      name2: resolveName(others[1].userId),
    })
  } else {
    text = t('chat.typingSeveral')
  }

  return (
    <div className="flex items-center gap-1 px-4 pb-1 h-5 shrink-0">
      {/* Animated dots */}
      <span className="flex gap-0.5 items-end shrink-0">
        <span className="w-1 h-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
        <span className="w-1 h-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
        <span className="w-1 h-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
      </span>
      <span className="text-xs text-muted-foreground truncate">{text}</span>
    </div>
  )
}
