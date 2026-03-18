import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DtoMessage } from '@/types'
import type { MentionResolver } from '@/lib/messageParser'
import type {
  JumpRequest,
  MessageTimelineMode,
  MessageTimelineRow,
} from '@/lib/messageJump'
import { DEFAULT_CHAT_SPACING, useAppearanceStore } from '@/stores/appearanceStore'
import DynamicVirtualizedMessageList from '@/components/chat/message-list/DynamicVirtualizedMessageList'
import MessageListRow from '@/components/chat/message-list/MessageListRow'
import { getEstimatedMessageListRowHeight } from '@/components/chat/message-list/rowHeights'
import { GroupedMessageSkeletonRow, MessageSkeletonRow } from '@/components/chat/message-list/SkeletonRows'
import {
  getAutoloadGapKeys,
  resolveInitialScrollTarget,
} from '@/components/chat/message-list/messageListUtils'
import type { MessageItemProps } from '@/components/chat/MessageItem'
import type {
  DynamicVirtualizedMessageListHandle,
  OnItemsRenderedArgs,
  ScrollAlignment,
} from '@/components/chat/message-list/types'

interface Props {
  rows: MessageTimelineRow[]
  mode: MessageTimelineMode
  isLoadingInitial?: boolean
  jumpTargetRowKey?: string | null
  focusTargetRowKey?: string | null
  highlightRequest?: JumpRequest | null
  onHighlightHandled?: (requestKey: string) => void
  channelName?: string
  resolver?: MentionResolver
  getMessageProps?: (message: DtoMessage) => Partial<MessageItemProps>
  onLoadGap?: (gapKey: string) => void
  onJumpToPresent?: () => void
  onAckLatest?: () => void
}

interface StabilizedScrollOptions {
  index: number
  align: ScrollAlignment
  offset?: number
  behavior?: ScrollBehavior
  positionCheck: 'center' | 'start'
  maxAttempts?: number
  requiredStableAttempts?: number
  onSettled?: (targetEl: HTMLElement | null, scroller: HTMLDivElement | null) => void
  onFallback?: () => void
}

const BOTTOM_THRESHOLD = 48
const MIN_GAP_VIEWPORTS = 2.5

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function getMessageIdFromRowKey(rowKey: string | null | undefined): string | null {
  if (!rowKey?.startsWith('message:')) return null
  return rowKey.slice('message:'.length) || null
}

function findMessageTargetElement(
  scroller: HTMLDivElement,
  options: { messageId?: string | null; rowKey?: string | null },
): HTMLElement | null {
  if (options.messageId) {
    const byMessageId = scroller.querySelector<HTMLElement>(
      `[data-message-id="${escapeAttributeValue(options.messageId)}"]`,
    )
    if (byMessageId) return byMessageId
  }

  if (options.rowKey) {
    return scroller.querySelector<HTMLElement>(
      `[data-row-key="${escapeAttributeValue(options.rowKey)}"]`,
    )
  }

  return null
}

function isCenteredEnough(scroller: HTMLDivElement, target: HTMLElement) {
  const scrollerRect = scroller.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const viewportCenter = scrollerRect.top + (scroller.clientHeight / 2)
  const targetCenter = targetRect.top + (targetRect.height / 2)
  return Math.abs(targetCenter - viewportCenter) <= Math.max(24, targetRect.height)
}

function isStartAlignedEnough(scroller: HTMLDivElement, target: HTMLElement, offset: number) {
  const scrollerRect = scroller.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const expectedTop = Math.max(0, -offset)
  return Math.abs((targetRect.top - scrollerRect.top) - expectedTop) <= Math.max(16, targetRect.height / 2)
}

function InitialSkeleton() {
  return (
    <div className="flex-1 min-h-0 overflow-hidden flex flex-col justify-end pb-2">
      {Array.from({ length: 13 }).map((_, index) => {
        const isGrouped = index % 5 !== 0
        return isGrouped
          ? <GroupedMessageSkeletonRow key={index} seed={index} />
          : <MessageSkeletonRow key={index} seed={index} />
      })}
    </div>
  )
}

export default function MessageList({
  rows,
  mode,
  isLoadingInitial,
  jumpTargetRowKey,
  focusTargetRowKey,
  highlightRequest,
  onHighlightHandled,
  channelName,
  resolver,
  getMessageProps,
  onLoadGap,
  onJumpToPresent,
  onAckLatest,
}: Props) {
  const { t } = useTranslation()
  const chatSpacing = useAppearanceStore((state) => state.chatSpacing) ?? DEFAULT_CHAT_SPACING
  const listRef = useRef<DynamicVirtualizedMessageListHandle | null>(null)
  const bootstrapCompletedRef = useRef(false)
  const suppressedInitialHighlightKeyRef = useRef<string | null>(null)
  const lastHighlightKeyRef = useRef<string | null>(null)
  const lastFocusRowKeyRef = useRef<string | null>(null)
  const stabilizeRafRef = useRef<number | null>(null)
  const stabilizeTokenRef = useRef(0)
  const lastRenderedRangeRef = useRef<OnItemsRenderedArgs | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const isAtBottomRef = useRef(true)
  const prevLastRowKeyRef = useRef<string | null>(null)
  const [viewportHeight, setViewportHeight] = useState(0)

  const hasNewerGap = useMemo(
    () => rows.some((row) => row.kind === 'gap' && row.direction === 'newer'),
    [rows],
  )
  const minGapHeightPx = viewportHeight > 0
    ? Math.round(viewportHeight * MIN_GAP_VIEWPORTS)
    : 0
  const rowIndexByKey = useMemo(() => {
    const map = new Map<string, number>()
    rows.forEach((row, index) => {
      map.set(row.key, index)
    })
    return map
  }, [rows])

  const cancelStabilizedScroll = useCallback(() => {
    stabilizeTokenRef.current += 1
    if (stabilizeRafRef.current != null) {
      cancelAnimationFrame(stabilizeRafRef.current)
      stabilizeRafRef.current = null
    }
  }, [])

  useEffect(() => cancelStabilizedScroll, [cancelStabilizedScroll])

  // Explicit live-tail scroll: when a new row is appended at the end while in live-tail
  // mode and the user was already at the bottom, snap to the new bottom. This is a
  // belt-and-suspenders fallback for the virtual list's anchor-based restoration, which
  // can miss when the two-render sequence (messages → timelineState update) leaves
  // atBottomSnapshotRef stale in the intermediate render.
  useLayoutEffect(() => {
    const lastRow = rows[rows.length - 1]
    const newLastRowKey = lastRow?.key ?? null
    const prevLastRowKey = prevLastRowKeyRef.current
    prevLastRowKeyRef.current = newLastRowKey

    if (!bootstrapCompletedRef.current) return
    if (mode !== 'live-tail' || hasNewerGap) return
    if (!isAtBottomRef.current) return
    if (newLastRowKey === null || newLastRowKey === prevLastRowKey) return

    listRef.current?.scrollToBottom('auto')
  }, [rows, mode, hasNewerGap])

  useEffect(() => {
    if (!focusTargetRowKey) {
      lastFocusRowKeyRef.current = null
    }
  }, [focusTargetRowKey])

  useEffect(() => {
    if (isLoadingInitial) {
      bootstrapCompletedRef.current = false
      suppressedInitialHighlightKeyRef.current = null
      cancelStabilizedScroll()
    }
  }, [cancelStabilizedScroll, isLoadingInitial])

  const applyHighlight = useCallback((requestKey: string, targetEl: HTMLElement | null) => {
    const scroller = listRef.current?.getScroller()
    if (!scroller || !targetEl) {
      return
    }

    scroller.querySelectorAll<HTMLElement>('.message-highlight').forEach((node) => {
      node.classList.remove('message-highlight')
    })

    targetEl.classList.remove('message-highlight')
    void targetEl.offsetWidth
    targetEl.classList.add('message-highlight')

    if (lastHighlightKeyRef.current !== requestKey) {
      lastHighlightKeyRef.current = requestKey
      onHighlightHandled?.(requestKey)
    }
  }, [onHighlightHandled])

  const completeJumpWithoutHighlight = useCallback((requestKey: string) => {
    if (lastHighlightKeyRef.current !== requestKey) {
      lastHighlightKeyRef.current = requestKey
      onHighlightHandled?.(requestKey)
    }
  }, [onHighlightHandled])

  const startStabilizedScroll = useCallback((options: StabilizedScrollOptions) => {
    cancelStabilizedScroll()

    const maxAttempts = options.maxAttempts ?? 45
    const requiredStableAttempts = options.requiredStableAttempts ?? 3
    const token = stabilizeTokenRef.current
    let attempt = 0
    let stableAttempts = 0

    const run = () => {
      if (stabilizeTokenRef.current !== token) {
        return
      }

      const list = listRef.current
      const scroller = list?.getScroller()
      if (!list || !scroller || scroller.clientHeight <= 0) {
        if (attempt >= maxAttempts) {
          options.onFallback?.()
          return
        }

        attempt += 1
        stabilizeRafRef.current = requestAnimationFrame(run)
        return
      }

      list.scrollToIndex(
        options.index,
        options.align,
        options.offset ?? 0,
        attempt === 0 ? (options.behavior ?? 'auto') : 'auto',
      )

      const row = rows[options.index]
      const targetEl = row
        ? findMessageTargetElement(scroller, {
            messageId: getMessageIdFromRowKey(row.key),
            rowKey: row.key,
          })
        : null

      if (!targetEl) {
        if (attempt >= maxAttempts) {
          options.onSettled?.(null, scroller)
          options.onFallback?.()
          return
        }

        attempt += 1
        stabilizeRafRef.current = requestAnimationFrame(run)
        return
      }

      const positioned = options.positionCheck === 'center'
        ? isCenteredEnough(scroller, targetEl)
        : isStartAlignedEnough(scroller, targetEl, options.offset ?? 0)
      stableAttempts = positioned ? stableAttempts + 1 : 0

      if (stableAttempts >= requiredStableAttempts || attempt >= maxAttempts) {
        stabilizeRafRef.current = null
        options.onSettled?.(targetEl, scroller)
        return
      }

      attempt += 1
      stabilizeRafRef.current = requestAnimationFrame(run)
    }

    run()
  }, [cancelStabilizedScroll, rows])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    if (hasNewerGap && onJumpToPresent) {
      onJumpToPresent()
      return
    }

    listRef.current?.scrollToBottom(behavior)
  }, [hasNewerGap, onJumpToPresent])

  const handleVirtualScroll = useCallback((args: {
    scrollOffset: number
    scrollHeight: number
    clientHeight: number
  }) => {
    setViewportHeight((current) => current === args.clientHeight ? current : args.clientHeight)

    const atBottom = args.scrollOffset + args.clientHeight >= args.scrollHeight - BOTTOM_THRESHOLD
    isAtBottomRef.current = atBottom
    setIsAtBottom((current) => current === atBottom ? current : atBottom)

    if (atBottom && (mode === 'live-tail' || !hasNewerGap)) {
      onAckLatest?.()
    }
  }, [hasNewerGap, mode, onAckLatest])

  const handleItemsRendered = useCallback((renderedRange: OnItemsRenderedArgs) => {
    lastRenderedRangeRef.current = renderedRange

    if (!onLoadGap || mode === 'jump-travel') {
      return
    }
    // Don't auto-load gaps before the initial scroll-to-bottom (or jump) has completed.
    // On first render scrollState.scrollTop = 0, which puts the older-edge gap in the
    // visible range even though the user hasn't scrolled there yet.
    if (!bootstrapCompletedRef.current) {
      return
    }

    // Call onLoadGap for every idle gap in the overscan/visible range.
    // loadGap has its own synchronous gapFetchesRef guard to prevent concurrent fetches,
    // so calling it on every scroll event is safe — it returns early if already fetching.
    getAutoloadGapKeys(rows, renderedRange).forEach((gapKey) => {
      onLoadGap(gapKey)
    })
  }, [mode, onLoadGap, rows])

  // Keep a stable ref so RAF-based bootstrap callbacks can call handleItemsRendered
  // without capturing a stale closure. Updated synchronously on every render.
  const handleItemsRenderedRef = useRef(handleItemsRendered)
  handleItemsRenderedRef.current = handleItemsRendered

  useLayoutEffect(() => {
    if (isLoadingInitial || bootstrapCompletedRef.current || rows.length === 0) {
      return
    }

    const initialTarget = resolveInitialScrollTarget(rows, {
      focusTargetRowKey,
      jumpTargetRowKey,
      highlightRequest,
    })

    if (initialTarget.type === 'bottom') {
      listRef.current?.scrollToBottom(initialTarget.behavior)
      bootstrapCompletedRef.current = true
      return
    }

    if (initialTarget.type === 'focus' && highlightRequest?.requestKey) {
      suppressedInitialHighlightKeyRef.current = highlightRequest.requestKey
    }

    startStabilizedScroll({
      index: initialTarget.index ?? 0,
      align: initialTarget.align ?? 'auto',
      offset: initialTarget.offset,
      behavior: initialTarget.behavior,
      positionCheck: initialTarget.type === 'unread' ? 'start' : 'center',
      onSettled: (targetEl) => {
        if (initialTarget.type === 'focus' && focusTargetRowKey) {
          lastFocusRowKeyRef.current = focusTargetRowKey
        }

        if (initialTarget.type === 'jump' && highlightRequest?.requestKey) {
          applyHighlight(highlightRequest.requestKey, targetEl)
          if (!targetEl) {
            completeJumpWithoutHighlight(highlightRequest.requestKey)
          }
        }

        bootstrapCompletedRef.current = true
        // Re-check gap auto-loading: handleItemsRendered may have fired while bootstrap
        // was pending (bootstrapCompletedRef=false) and won't fire again on its own.
        const lastRange = lastRenderedRangeRef.current
        if (lastRange) handleItemsRenderedRef.current(lastRange)
      },
      onFallback: () => {
        if (initialTarget.type === 'focus' && focusTargetRowKey) {
          lastFocusRowKeyRef.current = focusTargetRowKey
        }

        if (initialTarget.type === 'jump' && highlightRequest?.requestKey) {
          completeJumpWithoutHighlight(highlightRequest.requestKey)
        }

        bootstrapCompletedRef.current = true
        const lastRange = lastRenderedRangeRef.current
        if (lastRange) handleItemsRenderedRef.current(lastRange)
      },
    })
  }, [
    applyHighlight,
    completeJumpWithoutHighlight,
    focusTargetRowKey,
    highlightRequest,
    isLoadingInitial,
    jumpTargetRowKey,
    rows,
    startStabilizedScroll,
  ])

  useLayoutEffect(() => {
    if (!bootstrapCompletedRef.current) {
      return
    }
    if (!highlightRequest || !jumpTargetRowKey) {
      return
    }
    if (highlightRequest.requestKey === lastHighlightKeyRef.current) {
      return
    }
    if (highlightRequest.requestKey === suppressedInitialHighlightKeyRef.current) {
      return
    }

    const targetIndex = rowIndexByKey.get(jumpTargetRowKey)
    if (targetIndex == null) {
      if (!isLoadingInitial && mode !== 'live-tail') {
        completeJumpWithoutHighlight(highlightRequest.requestKey)
      }
      return
    }

    startStabilizedScroll({
      index: targetIndex,
      align: 'center',
      behavior: highlightRequest.behavior === 'direct-scroll' ? 'smooth' : 'auto',
      positionCheck: 'center',
      onSettled: (targetEl) => {
        applyHighlight(highlightRequest.requestKey, targetEl)
        if (!targetEl) {
          completeJumpWithoutHighlight(highlightRequest.requestKey)
        }
      },
      onFallback: () => {
        completeJumpWithoutHighlight(highlightRequest.requestKey)
      },
    })
  }, [
    applyHighlight,
    completeJumpWithoutHighlight,
    highlightRequest,
    isLoadingInitial,
    jumpTargetRowKey,
    mode,
    rowIndexByKey,
    startStabilizedScroll,
  ])

  useLayoutEffect(() => {
    if (!bootstrapCompletedRef.current || highlightRequest || !focusTargetRowKey) {
      return
    }
    if (focusTargetRowKey === lastFocusRowKeyRef.current) {
      return
    }

    const targetIndex = rowIndexByKey.get(focusTargetRowKey)
    if (targetIndex == null) {
      if (hasNewerGap && onJumpToPresent) {
        onJumpToPresent()
      } else {
        listRef.current?.scrollToBottom('auto')
      }
      lastFocusRowKeyRef.current = focusTargetRowKey
      return
    }

    startStabilizedScroll({
      index: targetIndex,
      align: 'center',
      behavior: 'auto',
      positionCheck: 'center',
      onSettled: () => {
        lastFocusRowKeyRef.current = focusTargetRowKey
      },
      onFallback: () => {
        if (hasNewerGap && onJumpToPresent) {
          onJumpToPresent()
        } else {
          listRef.current?.scrollToBottom('auto')
        }
        lastFocusRowKeyRef.current = focusTargetRowKey
      },
    })
  }, [
    focusTargetRowKey,
    hasNewerGap,
    highlightRequest,
    onJumpToPresent,
    rowIndexByKey,
    startStabilizedScroll,
  ])

  // Stable callbacks so DynamicVirtualizedMessageList's memos/deps don't invalidate on
  // every MessageList render. estimateRowHeight and renderRow only change when their own
  // visual inputs change (spacing, viewport, etc.) — not on scroll events.
  const estimateRowHeight = useCallback(
    (row: MessageTimelineRow) => getEstimatedMessageListRowHeight(row, { chatSpacing, minGapHeightPx }),
    [chatSpacing, minGapHeightPx],
  )

  const renderRow = useCallback(
    (row: MessageTimelineRow) => (
      <MessageListRow
        row={row}
        channelName={channelName}
        chatSpacing={chatSpacing}
        minGapHeightPx={minGapHeightPx}
        resolver={resolver}
        getMessageProps={getMessageProps}
        onLoadGap={onLoadGap}
      />
    ),
    [channelName, chatSpacing, minGapHeightPx, resolver, getMessageProps, onLoadGap],
  )

  if (isLoadingInitial) {
    return <InitialSkeleton />
  }

  return (
    <div className="relative flex-1 min-h-0">
      <DynamicVirtualizedMessageList
        ref={listRef}
        items={rows}
        className="h-full"
        innerClassName="min-h-full"
        bottomThreshold={BOTTOM_THRESHOLD}
        estimateItemHeight={estimateRowHeight}
        renderItem={renderRow}
        onScroll={handleVirtualScroll}
        onItemsRendered={handleItemsRendered}
      />

      {mode !== 'live-tail' && hasNewerGap && onJumpToPresent && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
          <div className="pointer-events-auto inline-flex max-w-full items-center gap-3 rounded-full border border-border/80 bg-background/90 px-4 py-2 shadow-lg backdrop-blur">
            <span className="truncate text-xs font-medium text-muted-foreground">
              {t('chat.viewingOlderMessages')}
            </span>
            <button
              type="button"
              onClick={onJumpToPresent}
              className="shrink-0 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {t('chat.jumpToPresent')}
            </button>
          </div>
        </div>
      )}

      {mode === 'live-tail' && !isAtBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-lg transition-colors hover:bg-primary/90"
        >
          <ChevronDown className="h-3.5 w-3.5" />
          {hasNewerGap ? t('chat.jumpToPresent') : t('chat.jumpToBottom')}
        </button>
      )}
    </div>
  )
}
