import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Hash, ExternalLink, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { DtoChannel, DtoMessage } from '@/types'
import type { MentionResolver } from '@/lib/messageParser'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import MessageItem from '@/components/chat/MessageItem'

interface SearchPanelProps {
  serverId: string
  results: DtoMessage[]
  channels: DtoChannel[]
  isLoading: boolean
  hasSearched: boolean
  page: number
  totalPages: number
  onPageChange: (page: number) => void
  onJumpToMessage?: (message: DtoMessage) => void | Promise<void>
  resolver?: MentionResolver
  className?: string
}

function ResultCard({
  msg,
  channelName,
  onJump,
  resolver,
}: {
  msg: DtoMessage
  channelName: string | undefined
  onJump: () => void
  resolver?: MentionResolver
}) {
  const { t } = useTranslation()

  return (
    <div className="border-b border-border/40 last:border-0">
      {/* Channel name + Jump button */}
      <div className="group flex items-center justify-between px-3 pt-2.5 pb-0.5">
        <span className="text-xs text-muted-foreground flex items-center gap-1 min-w-0">
          <Hash className="w-3 h-3 shrink-0" />
          <span className="truncate">{channelName ?? '…'}</span>
        </span>
        <button
          onClick={onJump}
          className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium text-primary hover:bg-primary/10 transition-all shrink-0 ml-2"
        >
          {t('search.jump')} <ExternalLink className="w-3 h-3" />
        </button>
      </div>

      {/* Full message rendering */}
      <div className="px-1 pb-2 cursor-pointer" onClick={onJump}>
        <MessageItem message={msg} resolver={resolver} attachmentMaxWidth={220} />
      </div>
    </div>
  )
}

export default function SearchPanel({
  serverId,
  results,
  channels,
  isLoading,
  hasSearched,
  page,
  totalPages,
  onPageChange,
  onJumpToMessage,
  resolver,
  className,
}: SearchPanelProps) {
  const navigate = useNavigate()
  const { t } = useTranslation()

  const jumpToMessage = useCallback(
    async (msg: DtoMessage) => {
      if (onJumpToMessage) {
        await onJumpToMessage(msg)
        return
      }
      const path = serverId
        ? `/app/${serverId}/${String(msg.channel_id)}`
        : `/app/@me/${String(msg.channel_id)}`
      navigate(path, {
        state: {
          jumpToMessageId: String(msg.id),
          jumpBehavior: 'direct-scroll',
          jumpToMessagePosition: msg.position ?? undefined,
        },
      })
    },
    [navigate, onJumpToMessage, serverId],
  )

  const getChannelName = (chanId: string | number | undefined) =>
    chanId !== undefined ? channels.find((c) => String(c.id) === String(chanId))?.name : undefined

  if (isLoading) {
    return (
      <div className={cn('p-3 space-y-4 overflow-hidden', className)}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-24 ml-auto" />
            </div>
            <div className="flex items-start gap-3">
              <Skeleton className="w-9 h-9 rounded-full shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (hasSearched && results.length === 0) {
    return (
      <div className={cn('flex flex-1 min-h-0 flex-col items-center justify-center overflow-hidden p-8 text-center text-muted-foreground', className)}>
        <Search className="w-10 h-10 mb-3 opacity-20" />
        <p className="text-sm font-semibold">{t('search.noResults')}</p>
        <p className="text-xs mt-1 opacity-70">{t('search.tryDifferent')}</p>
      </div>
    )
  }

  if (!hasSearched) return null

  return (
    <div className={cn('flex flex-1 min-h-0 flex-col overflow-hidden', className)}>
      {/* Result count */}
      <div className="px-4 py-2 text-xs text-muted-foreground border-b border-border shrink-0 flex items-center justify-between">
        <span>
          {results.length === 1
            ? t('search.resultCount', { count: results.length })
            : t('search.resultCountPlural', { count: results.length })}
        </span>
        {totalPages > 1 && (
          <span>{t('search.pageOf', { page: page + 1, total: totalPages })}</span>
        )}
      </div>

      {/* Message list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="py-1">
          {results.map((msg) => (
            <ResultCard
              key={String(msg.id)}
              msg={msg}
              channelName={getChannelName(msg.channel_id)}
              onJump={() => { void jumpToMessage(msg) }}
              resolver={resolver}
            />
          ))}
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="px-3 py-2 border-t border-border shrink-0 flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onPageChange(page - 1)}
            disabled={page === 0}
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            {t('search.prev')}
          </Button>
          <span className="text-xs text-muted-foreground">{page + 1} / {totalPages}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages - 1}
          >
            {t('search.next')}
            <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      )}
    </div>
  )
}
