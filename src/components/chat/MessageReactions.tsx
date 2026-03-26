import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { SmilePlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { messageApi } from '@/api/client'
import { useMessageStore } from '@/stores/messageStore'
import { emojiUrl } from '@/lib/emoji'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import type { DtoMessageReaction, DtoUser } from '@/types'

interface MessageReactionsProps {
  reactions: DtoMessageReaction[]
  channelId: string
  messageId: string
  onAddReaction?: (rect: DOMRect) => void
  openDialog?: boolean
  onDialogClose?: () => void
}

function getReactionName(reaction: DtoMessageReaction): string {
  const name = reaction.emoji?.name ?? ''
  const id = reaction.emoji?.id
  if (id) return `${name}:${id}`
  return name
}

interface ReactionUsers {
  items: DtoUser[]
  nextAfter: number | null
  loading: boolean
  loadingMore: boolean
  error: boolean
}

const PAGE_SIZE = 20

export default function MessageReactions({ reactions, channelId, messageId, onAddReaction, openDialog: openDialogProp, onDialogClose }: MessageReactionsProps) {
  const { t } = useTranslation()
  const updateMessageReaction = useMessageStore((s) => s.updateMessageReaction)
  const [pending, setPending] = useState<Set<string>>(new Set())

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedName, setSelectedName] = useState<string>('')
  const [usersCache, setUsersCache] = useState<Map<string, ReactionUsers>>(new Map())
  const sentinelRef = useRef<HTMLDivElement>(null)

  const visible = reactions.filter((r) => (r.count ?? 0) > 0)

  // Open dialog externally (e.g. from context menu)
  useEffect(() => {
    if (!openDialogProp) return
    const first = visible[0]
    if (first) openDialog(getReactionName(first))
    onDialogClose?.()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDialogProp])

  // Load users for a reaction if not cached
  const loadUsers = useCallback(async (reactionName: string) => {
    setUsersCache((prev) => {
      if (prev.has(reactionName)) return prev
      const next = new Map(prev)
      next.set(reactionName, { items: [], nextAfter: null, loading: true, loadingMore: false, error: false })
      return next
    })

    try {
      const res = await messageApi.messageChannelChannelIdMessageIdReactionsReactionNameGet({
        channelId: channelId as unknown as number,
        messageId: messageId as unknown as number,
        reactionName,
        limit: PAGE_SIZE,
      })
      setUsersCache((prev) => {
        const next = new Map(prev)
        next.set(reactionName, {
          items: res.data.items ?? [],
          nextAfter: res.data.next_after ?? null,
          loading: false,
          loadingMore: false,
          error: false,
        })
        return next
      })
    } catch {
      setUsersCache((prev) => {
        const next = new Map(prev)
        const existing = next.get(reactionName)
        if (existing) next.set(reactionName, { ...existing, loading: false, error: true })
        return next
      })
    }
  }, [channelId, messageId])

  const loadMore = useCallback(async (reactionName: string) => {
    const cached = usersCache.get(reactionName)
    if (!cached || cached.loadingMore || cached.nextAfter == null) return

    setUsersCache((prev) => {
      const next = new Map(prev)
      const entry = next.get(reactionName)
      if (entry) next.set(reactionName, { ...entry, loadingMore: true })
      return next
    })

    try {
      const res = await messageApi.messageChannelChannelIdMessageIdReactionsReactionNameGet({
        channelId: channelId as unknown as number,
        messageId: messageId as unknown as number,
        reactionName,
        after: cached.nextAfter as unknown as number,
        limit: PAGE_SIZE,
      })
      setUsersCache((prev) => {
        const next = new Map(prev)
        const entry = next.get(reactionName)
        if (entry) {
          next.set(reactionName, {
            ...entry,
            items: [...entry.items, ...(res.data.items ?? [])],
            nextAfter: res.data.next_after ?? null,
            loadingMore: false,
          })
        }
        return next
      })
    } catch {
      setUsersCache((prev) => {
        const next = new Map(prev)
        const entry = next.get(reactionName)
        if (entry) next.set(reactionName, { ...entry, loadingMore: false })
        return next
      })
    }
  }, [usersCache, channelId, messageId])

  // Load users when selected reaction changes
  useEffect(() => {
    if (!dialogOpen || !selectedName) return
    if (!usersCache.has(selectedName)) {
      void loadUsers(selectedName)
    }
  }, [dialogOpen, selectedName, usersCache, loadUsers])

  // Infinite scroll sentinel
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !selectedName) return
    const cached = usersCache.get(selectedName)
    if (!cached || cached.nextAfter == null) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore(selectedName)
      },
      { threshold: 0.1 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [selectedName, usersCache, loadMore])

  // Reset cache when dialog closes
  function handleOpenChange(open: boolean) {
    setDialogOpen(open)
    if (!open) setUsersCache(new Map())
  }

  function openDialog(reactionName: string) {
    setSelectedName(reactionName)
    setUsersCache(new Map())
    setDialogOpen(true)
  }

  if (visible.length === 0) return null

  async function handleToggle(reaction: DtoMessageReaction) {
    const name = getReactionName(reaction)
    if (!name || pending.has(name)) return

    const isMe = reaction.me ?? false
    updateMessageReaction(channelId, messageId, {
      ...reaction,
      me: !isMe,
      count: Math.max(0, (reaction.count ?? 1) + (isMe ? -1 : 1)),
    })
    setPending((prev) => new Set(prev).add(name))

    try {
      if (isMe) {
        await messageApi.messageChannelChannelIdMessageIdReactionsReactionNameDelete({
          channelId: channelId as unknown as number,
          messageId: messageId as unknown as number,
          reactionName: name,
        })
      } else {
        await messageApi.messageChannelChannelIdMessageIdReactionsReactionNamePut({
          channelId: channelId as unknown as number,
          messageId: messageId as unknown as number,
          reactionName: name,
        })
      }
    } catch {
      updateMessageReaction(channelId, messageId, reaction)
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
    }
  }

  const selectedReaction = visible.find((r) => getReactionName(r) === selectedName)
  const selectedData = usersCache.get(selectedName)

  return (
    <TooltipProvider>
      <div className="mt-1 flex flex-wrap gap-1">
        {visible.map((reaction) => {
          const name = getReactionName(reaction)
          const isMe = reaction.me ?? false
          const emojiId = reaction.emoji?.id ?? null
          const emojiName = reaction.emoji?.name ?? ''
          const isCustom = emojiId != null

          const button = (
            <button
              ref={() => {}}
              type="button"
              onClick={() => void handleToggle(reaction)}
              disabled={pending.has(name)}
              title={undefined}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm transition-colors select-none',
                'hover:border-primary/50 hover:bg-primary/10',
                isMe
                  ? 'border-primary/40 bg-primary/15 text-foreground'
                  : 'border-border bg-muted/40 text-muted-foreground',
                pending.has(name) && 'opacity-60',
              )}
            >
              {isCustom ? (
                <img
                  src={emojiUrl(String(emojiId), 44)}
                  alt={emojiName}
                  className="h-5 w-5 object-contain"
                  draggable={false}
                />
              ) : (
                <span className="text-base leading-none">{emojiName}</span>
              )}
              <span className="tabular-nums font-medium">{reaction.count}</span>
            </button>
          )

          return (
            <HoverCard key={name || emojiName} openDelay={400} closeDelay={150}>
              <HoverCardTrigger asChild>{button}</HoverCardTrigger>
              <HoverCardContent
                side="top"
                className="flex w-auto flex-col items-center gap-1.5 px-3 py-2.5 cursor-pointer"
                onClick={() => openDialog(name)}
              >
                {isCustom ? (
                  <img
                    src={emojiUrl(String(emojiId), 96)}
                    alt={emojiName}
                    className="h-10 w-10 object-contain"
                    draggable={false}
                  />
                ) : (
                  <span className="text-4xl leading-none">{emojiName}</span>
                )}
                <span className="text-center text-xs font-semibold leading-tight">
                  {isCustom ? `:${emojiName}:` : emojiName}
                </span>
                <span className="text-[10px] opacity-60">{t('reactions.clickToSeeWhoReacted')}</span>
              </HoverCardContent>
            </HoverCard>
          )
        })}

        {onAddReaction && (
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => onAddReaction((e.currentTarget as HTMLButtonElement).getBoundingClientRect())}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/10 hover:text-foreground"
              >
                <SmilePlus className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('messageItem.addReaction')}</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Reactions dialog */}
      <Dialog open={dialogOpen} onOpenChange={handleOpenChange}>
        <DialogContent aria-describedby={undefined} className="flex flex-col gap-0 p-0 sm:max-w-[480px] h-[440px] overflow-hidden">
          <DialogHeader className="px-4 py-3 border-b border-border shrink-0">
            <DialogTitle>{t('reactions.dialogTitle')}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-1 min-h-0">
            {/* Left: reaction list */}
            <div className="w-24 shrink-0 border-r border-border overflow-y-auto py-1">
              {visible.map((reaction) => {
                const name = getReactionName(reaction)
                const emojiId = reaction.emoji?.id ?? null
                const emojiName = reaction.emoji?.name ?? ''
                const isCustom = emojiId != null
                const isSelected = name === selectedName

                return (
                  <button
                    key={name || emojiName}
                    type="button"
                    onClick={() => setSelectedName(name)}
                    className="flex w-full items-center justify-center px-2 py-1.5"
                  >
                    <span className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors',
                      isSelected
                        ? 'bg-primary/20 text-foreground font-semibold'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}>
                      {isCustom ? (
                        <img
                          src={emojiUrl(String(emojiId), 44)}
                          alt={emojiName}
                          className="h-4 w-4 shrink-0 object-contain"
                          draggable={false}
                        />
                      ) : (
                        <span className="text-base leading-none">{emojiName}</span>
                      )}
                      <span className="tabular-nums">{reaction.count}</span>
                    </span>
                  </button>
                )
              })}
            </div>

            {/* Right: user list */}
            <div className="flex-1 overflow-y-auto">
              {!selectedData || selectedData.loading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
                </div>
              ) : selectedData.error ? (
                <p className="py-10 text-center text-sm text-muted-foreground">{t('common.error')}</p>
              ) : selectedData.items.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">{t('reactions.noReactions')}</p>
              ) : (
                <ul>
                  {selectedData.items.map((user) => (
                    <li key={String(user.id)} className="flex items-center gap-3 px-4 py-2.5">
                      <Avatar className="h-9 w-9 shrink-0">
                        <AvatarImage src={user.avatar?.url} alt={user.name} className="object-cover" />
                        <AvatarFallback className="text-sm font-semibold">
                          {(user.name ?? '?').charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground leading-tight">{user.name}</p>
                        {user.discriminator && (
                          <p className="truncate text-xs text-muted-foreground leading-tight">#{user.discriminator}</p>
                        )}
                      </div>
                    </li>
                  ))}

                  {/* Infinite scroll sentinel */}
                  <li ref={sentinelRef} className="px-4 py-1">
                    {selectedData.loadingMore && (
                      <div className="flex justify-center py-2">
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-foreground" />
                      </div>
                    )}
                  </li>
                </ul>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
