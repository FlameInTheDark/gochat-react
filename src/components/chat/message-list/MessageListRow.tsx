import { useEffect, useRef } from 'react'
import { Hash, Loader2, MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { DtoMessage } from '@/types'
import type { MentionResolver } from '@/lib/messageParser'
import type {
  MessageTimelineGapRow,
  MessageTimelineRow,
} from '@/lib/messageJump'
import { retryPendingChannelMessage } from '@/lib/pendingMessageSend'
import MessageItem, { type MessageItemProps } from '@/components/chat/MessageItem'
import { GroupedMessageSkeletonRow, MessageSkeletonRow } from './SkeletonRows'

const GAP_RUNWAY_MIN_CARD_COUNT = 6
const GAP_RUNWAY_ESTIMATED_CARD_HEIGHT = 44

function DateDivider({ label }: { label: string }) {
  return (
    <div className="my-3 flex items-center gap-2 px-4">
      <div className="h-px flex-1 bg-border" />
      <span className="select-none whitespace-nowrap px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

function ConversationStart({ channelName }: { channelName?: string }) {
  const isChannel = !!channelName
  const { t } = useTranslation()

  return (
    <div className="px-6 pb-6 pt-10">
      <div className="mb-4 flex h-[4.25rem] w-[4.25rem] items-center justify-center rounded-full bg-muted">
        {isChannel
          ? <Hash className="h-8 w-8 text-muted-foreground" />
          : <MessageSquare className="h-8 w-8 text-muted-foreground" />
        }
      </div>
      <h3 className="mb-1 text-[1.6rem] font-bold leading-tight">
        {isChannel ? t('chat.welcomeChannel', { name: channelName }) : t('chat.welcomeDm')}
      </h3>
      <p className="text-sm text-muted-foreground leading-relaxed">
        {isChannel
          ? t('chat.welcomeChannelDesc', { name: channelName })
          : t('chat.welcomeDmDesc')}
      </p>
    </div>
  )
}

function UnreadSeparator() {
  const { t } = useTranslation()

  return (
    <div className="my-2 flex items-center gap-2 px-4 select-none">
      <div className="h-px flex-1 bg-red-500/60" />
      <span className="whitespace-nowrap px-2 text-xs font-semibold text-red-400">
        {t('chat.newMessages')}
      </span>
      <div className="h-px flex-1 bg-red-500/60" />
    </div>
  )
}

function GapRunwayRow({
  row,
  minHeightPx,
  onActivate,
}: {
  row: MessageTimelineGapRow
  minHeightPx: number
  onActivate?: () => void
}) {
  const { t } = useTranslation()

  // Auto-trigger loading when gap enters the overscan window with idle status.
  // loadGap has its own gapFetchesRef guard to prevent concurrent fetches.
  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate
  useEffect(() => {
    if (row.status === 'idle') {
      onActivateRef.current?.()
    }
  }, [row.status])

  const resolvedHeightPx = Math.max(row.heightPx, minHeightPx)
  const isError = row.status === 'error'
  const isLoading = row.status === 'loading'
  const runwayContentHeight = Math.max(resolvedHeightPx - 40, 0)
  const skeletonCount = Math.max(
    GAP_RUNWAY_MIN_CARD_COUNT,
    Math.ceil(runwayContentHeight / GAP_RUNWAY_ESTIMATED_CARD_HEIGHT),
  )

  return (
    <div className="relative" style={{ minHeight: `${resolvedHeightPx}px` }}>
      {(isLoading || isError) && (
        <div className="sticky top-3 z-10 flex justify-center px-4 pt-3">
          {isLoading && (
            <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-border/70 bg-background/90 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="truncate">
                {row.direction === 'older'
                  ? t('chat.loadingOlderMessages')
                  : t('chat.loadingNewerMessages')}
              </span>
            </div>
          )}
          {isError && (
            <button
              type="button"
              onClick={onActivate}
              className="inline-flex max-w-full items-center gap-2 rounded-full border border-border/70 bg-background/90 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-background"
            >
              <span className="truncate">
                {row.direction === 'older'
                  ? t('chat.olderMessagesFailed')
                  : t('chat.newerMessagesFailed')}
              </span>
              <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-foreground">
                {t('chat.retryLoad')}
              </span>
            </button>
          )}
        </div>
      )}

      <div
        className="pointer-events-none py-4 opacity-60"
        style={{ minHeight: `${runwayContentHeight}px` }}
      >
        {Array.from({ length: skeletonCount }).map((_, index) => (
          <div key={index}>
            {index % 5 === 0 ? (
              <MessageSkeletonRow seed={index + 100} />
            ) : (
              <GroupedMessageSkeletonRow seed={index + 200} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

interface Props {
  row: MessageTimelineRow
  channelName?: string
  chatSpacing: number
  minGapHeightPx: number
  resolver?: MentionResolver
  getMessageProps?: (message: DtoMessage) => Partial<MessageItemProps>
  onLoadGap?: (gapKey: string) => void
}

export default function MessageListRow({
  row,
  channelName,
  chatSpacing,
  minGapHeightPx,
  resolver,
  getMessageProps,
  onLoadGap,
}: Props) {
  const { t } = useTranslation()

  switch (row.kind) {
    case 'conversation-start':
      return (
        <div data-row-key={row.key}>
          <ConversationStart channelName={channelName} />
        </div>
      )

    case 'date-divider':
      return (
        <div data-row-key={row.key}>
          <DateDivider label={row.label} />
        </div>
      )

    case 'unread-separator':
      return (
        <div data-row-key={row.key}>
          <UnreadSeparator />
        </div>
      )

    case 'gap':
      return (
        <div data-row-key={row.key}>
          <GapRunwayRow
            row={row}
            minHeightPx={minGapHeightPx}
            onActivate={onLoadGap ? () => onLoadGap(row.key) : undefined}
          />
        </div>
      )

    case 'message':
      return (
        <div
          data-row-key={row.key}
          data-message-id={row.message.id != null ? String(row.message.id) : undefined}
          style={{ paddingTop: chatSpacing }}
        >
          <div className="px-4">
            <MessageItem
              message={row.message}
              isGrouped={row.grouped}
              resolver={resolver}
              {...getMessageProps?.(row.message)}
              deliveryState={row.deliveryState}
              pendingAttachmentDrafts={row.pendingAttachmentDrafts}
              optimisticCreatedAt={row.optimisticCreatedAt}
              onRetrySend={
                row.pendingLocalId && row.deliveryState === 'failed'
                  ? () => {
                      void retryPendingChannelMessage(row.pendingLocalId!).catch(() => {
                        toast.error(t('chat.sendFailed'))
                      })
                    }
                  : undefined
              }
            />
          </div>
        </div>
      )
  }
}
