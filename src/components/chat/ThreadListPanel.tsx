import { MessageSquare, Spool } from 'lucide-react'
import type { DtoChannel, DtoMessage } from '@/types'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslation } from 'react-i18next'
import { parseMessageContent, type MentionResolver } from '@/lib/messageParser'

interface Props {
  threads: DtoChannel[]
  previews: Record<string, string>
  previewMessages?: Record<string, DtoMessage | null>
  memberColors?: Record<string, string>
  isLoading?: boolean
  activeThreadId?: string | null
  resolver?: MentionResolver
  onOpenThread: (threadId: string) => void
}

export default function ThreadListPanel({
  threads,
  previews,
  previewMessages,
  memberColors,
  isLoading = false,
  activeThreadId,
  resolver,
  onOpenThread,
}: Props) {
  const { t } = useTranslation()

  function isInteractiveTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement &&
      target.closest('[data-message-interactive="true"]') != null
  }

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="h-12 border-b border-sidebar-border flex items-center gap-2 px-4 shrink-0">
          <Spool className="w-4 h-4 text-muted-foreground" />
          <span className="font-semibold">{t('threads.title')}</span>
        </div>
        <div className="p-3 space-y-2">
          {Array.from({ length: 5 }).map((_, idx) => (
            <div key={idx} className="rounded-lg border border-sidebar-border/60 p-3 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (threads.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="h-12 border-b border-sidebar-border flex items-center gap-2 px-4 shrink-0">
          <Spool className="w-4 h-4 text-muted-foreground" />
          <span className="font-semibold">{t('threads.title')}</span>
        </div>
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
          <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
            <MessageSquare className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">{t('threads.emptyTitle')}</p>
            <p className="text-xs">{t('threads.emptyDescription')}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 border-b border-sidebar-border flex items-center gap-2 px-4 shrink-0">
        <Spool className="w-4 h-4 text-muted-foreground" />
        <span className="font-semibold">{t('threads.title')}</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        <div className="space-y-1">
          {threads.map((thread) => {
            const threadId = String(thread.id)
            const preview = previews[threadId] ?? t('threads.previewEmpty')
            const previewMessage = previewMessages?.[threadId] ?? null
            const previewAuthorName = previewMessage?.author?.name?.trim()
            const previewAuthorColor = previewMessage?.author?.id != null
              ? memberColors?.[String(previewMessage.author.id)]
              : undefined

            return (
              <div
                key={threadId}
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  if (isInteractiveTarget(e.target)) return
                  onOpenThread(threadId)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpenThread(threadId)
                  }
                }}
                className={cn(
                  'w-full rounded-lg border px-3 py-2.5 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40',
                  activeThreadId === threadId
                    ? 'border-primary/40 bg-primary/10'
                    : 'border-transparent hover:border-sidebar-border hover:bg-accent/40',
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Spool className="w-4 h-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium text-foreground">
                    {thread.name ?? threadId}
                  </span>
                  {thread.closed && (
                    <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t('threads.closedBadge')}
                    </span>
                  )}
                </div>
                <div className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
                  {previewAuthorName && (
                    <span
                      className="font-medium text-foreground"
                      style={previewAuthorColor ? { color: previewAuthorColor } : undefined}
                    >
                      {previewAuthorName}
                      {': '}
                    </span>
                  )}
                  {parseMessageContent(preview, resolver)}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
