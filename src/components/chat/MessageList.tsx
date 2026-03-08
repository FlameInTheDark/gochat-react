import { useEffect, useLayoutEffect, useRef, useState, Fragment } from 'react'
import { Hash, MessageSquare, ChevronDown } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import type { DtoMessage } from '@/types'
import type { MentionResolver } from '@/lib/messageParser'
import MessageItem from './MessageItem'
import { snowflakeToDate, snowflakeToDayLabel } from '@/lib/snowflake'
import { useTranslation } from 'react-i18next'
import { useAppearanceStore, DEFAULT_CHAT_SPACING } from '@/stores/appearanceStore'

interface Props {
  messages: DtoMessage[]
  /** True while the initial full-channel load is in progress (full-screen skeleton). */
  isLoading?: boolean
  /** True while an older-page fetch is in-flight (skeleton at top). */
  isLoadingOlder?: boolean
  /** True while a newer-page fetch is in-flight (skeleton at bottom). */
  isLoadingNewer?: boolean
  /** True once we have reached the beginning of the channel history. */
  endReached?: boolean
  /** True once the most-recent messages are loaded (no more pages below). */
  latestReached?: boolean
  /** Render a "NEW MESSAGES" separator after the message with this ID. */
  unreadSeparatorAfter?: string | null
  /** Scroll to this message ID and flash-highlight it (jump from search). */
  highlightMessageId?: string | null
  channelName?: string
  resolver?: MentionResolver
  /** Called when the user scrolls near the top — load older messages. */
  onLoadOlder?: () => void
  /** Called when the user scrolls to the bottom and latestReached is false — load newer. */
  onLoadNewer?: () => void
  /** Called when the user is at the bottom with all messages loaded — ACK read state. */
  onAckLatest?: () => void
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FIVE_MINUTES = 5 * 60 * 1000
const LOAD_OLDER_THRESHOLD = 120   // px from top
const BOTTOM_THRESHOLD = 80        // px from bottom = "at bottom"
const ACK_DEBOUNCE = 800           // ms — fire ACK once the user has settled at the bottom

// ── Helpers ───────────────────────────────────────────────────────────────────

function isGroupedWith(curr: DtoMessage, prev: DtoMessage): boolean {
  if (String(curr.author?.id) !== String(prev.author?.id)) return false
  const currTime = snowflakeToDate(curr.id).getTime()
  const prevTime = snowflakeToDate(prev.id).getTime()
  if (new Date(currTime).toDateString() !== new Date(prevTime).toDateString()) return false
  return currTime - prevTime < FIVE_MINUTES
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 my-3 px-2">
      <div className="flex-1 h-px bg-border" />
      <span className="text-xs font-medium text-muted-foreground px-2 whitespace-nowrap select-none">
        {label}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  )
}

function ConversationStart({ channelName }: { channelName?: string }) {
  const isChannel = !!channelName
  const { t } = useTranslation()
  return (
    <div className="px-4 pt-10 pb-6">
      <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center mb-4">
        {isChannel
          ? <Hash className="w-7 h-7 text-muted-foreground" />
          : <MessageSquare className="w-7 h-7 text-muted-foreground" />
        }
      </div>
      <h3 className="text-2xl font-bold mb-1">
        {isChannel ? t('chat.welcomeChannel', { name: channelName }) : t('chat.welcomeDm')}
      </h3>
      <p className="text-sm text-muted-foreground">
        {isChannel
          ? t('chat.welcomeChannelDesc', { name: channelName })
          : t('chat.welcomeDmDesc')}
      </p>
    </div>
  )
}

function PaginationSkeleton() {
  return (
    <div className="space-y-4 px-4 py-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3">
          <Skeleton className="w-9 h-9 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-full" />
            {i % 2 === 0 && <Skeleton className="h-3 w-2/3" />}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
//
// Chat layout: bottom-anchored with:
//   • "beginning of history" shown only when confirmed (endReached)
//   • "NEW MESSAGES" separator at the unread boundary
//   • Scroll-to-separator on initial open with unread messages
//   • Scroll position preserved when prepending older messages
//   • loadNewer triggered when scrolling to bottom (latestReached=false)
//   • ACK when user reaches the bottom with latest messages visible

export default function MessageList({
  messages,
  isLoading,
  isLoadingOlder,
  isLoadingNewer,
  endReached,
  latestReached = true,
  unreadSeparatorAfter,
  highlightMessageId,
  channelName,
  resolver,
  onLoadOlder,
  onLoadNewer,
  onAckLatest,
}: Props) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const chatSpacing = useAppearanceStore((s) => s.chatSpacing) ?? DEFAULT_CHAT_SPACING
  const isAtBottomRef = useRef(true)
  const prevLengthRef = useRef(0)
  const [showJumpButton, setShowJumpButton] = useState(false)

  // Scroll-position preservation refs (no extra renders needed)
  const prevIsLoadingOlderRef = useRef(false)
  const savedScrollHeightRef = useRef(0)
  const savedScrollTopRef = useRef(0)

  // Unread separator ref + "which separator have we scrolled to" guard
  const separatorRef = useRef<HTMLDivElement | null>(null)
  const scrolledToSeparatorRef = useRef<string | null>(null)

  // Debounce timer for ACK: fires once after the user has settled at the bottom.
  // Cancelled immediately if the user scrolls away before the delay elapses.
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Jump-to-message scroll + highlight ────────────────────────────────────
  // Fires after paint whenever highlightMessageId or message count changes.
  // The smooth scroll takes ~400 ms, so we delay the blink animation until
  // after it completes so the user sees the flash while the element is visible.
  useEffect(() => {
    if (!highlightMessageId) return
    const el = scrollRef.current
    if (!el) return
    const target = el.querySelector<HTMLElement>(
      `[data-message-id="${highlightMessageId}"]`,
    )
    if (!target) return
    // Remove any leftover class first so re-jumps always restart the animation.
    target.classList.remove('message-highlight')
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // Wait for the smooth scroll to finish before starting the blink animation.
    const t = setTimeout(() => {
      void target.offsetWidth // force reflow so animation restarts
      target.classList.add('message-highlight')
    }, 450)
    return () => clearTimeout(t)
  }, [highlightMessageId, messages.length])

  // ── Sync prop refs so inline handlers always see fresh values ──────────────
  const unreadSeparatorAfterRef = useRef(unreadSeparatorAfter)
  unreadSeparatorAfterRef.current = unreadSeparatorAfter
  const latestReachedRef = useRef(latestReached)
  latestReachedRef.current = latestReached
  const onLoadNewerRef = useRef(onLoadNewer)
  onLoadNewerRef.current = onLoadNewer
  const onAckLatestRef = useRef(onAckLatest)
  onAckLatestRef.current = onAckLatest

  // ── Layout effect: scroll preservation + initial scroll to separator ───────
  //
  // This fires synchronously after every DOM update where the deps changed,
  // before the browser paints — crucial for flicker-free scroll restoration.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    // ── Scroll position preservation when older messages are prepended ───────
    const wasLoading = prevIsLoadingOlderRef.current
    const nowLoading = isLoadingOlder ?? false
    prevIsLoadingOlderRef.current = nowLoading

    if (!nowLoading && wasLoading && savedScrollHeightRef.current > 0) {
      // Loading finished — restore scroll position using absolute value to avoid
      // double-adjustment from browser scroll anchoring that may have fired
      // when the skeleton appeared (false→true transition).
      const diff = el.scrollHeight - savedScrollHeightRef.current
      if (diff > 0) el.scrollTop = savedScrollTopRef.current + diff
      savedScrollHeightRef.current = 0
      savedScrollTopRef.current = 0
    }

    // ── One-time scroll to unread separator ──────────────────────────────────
    // Fires only once per separator ID (scrolledToSeparatorRef guards repeats).
    if (
      unreadSeparatorAfter &&
      scrolledToSeparatorRef.current !== unreadSeparatorAfter &&
      separatorRef.current
    ) {
      scrolledToSeparatorRef.current = unreadSeparatorAfter
      const containerRect = el.getBoundingClientRect()
      const sepRect = separatorRef.current.getBoundingClientRect()
      // Place the separator ~80 px from the top so there's a little context above it
      el.scrollTop += sepRect.top - containerRect.top - 80
    }
  }, [isLoadingOlder, messages.length, unreadSeparatorAfter])

  // ── Auto-scroll to bottom when messages arrive / initial load ────────────
  // useLayoutEffect (synchronous, before paint) avoids any flash of the message
  // list starting at scrollTop=0. `isLoading` is in the deps so this also fires
  // on the skeleton→content transition even when messages.length hasn't changed
  // between the two renders (Zustand store update and React state updates for
  // isLoading/unreadSeparatorAfter may land in separate renders).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return  // skeleton is showing — scrollRef not yet attached

    const hadMessages = prevLengthRef.current > 0
    prevLengthRef.current = messages.length

    // If this is an initial load with an unread separator, let the layout
    // effect above scroll to the separator instead.
    if (!hadMessages && unreadSeparatorAfterRef.current) return

    if (!hadMessages || isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, isLoading])

  // ── Scroll handler ────────────────────────────────────────────────────────
  function handleScroll() {
    const el = scrollRef.current
    if (!el) return

    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distFromBottom < BOTTOM_THRESHOLD
    isAtBottomRef.current = atBottom
    setShowJumpButton(!atBottom)

    // Load older when near the top
    if (!isLoadingOlder && !endReached && el.scrollTop <= LOAD_OLDER_THRESHOLD && onLoadOlder) {
      // Save both scrollHeight AND scrollTop before the skeleton renders.
      // The layout effect uses savedScrollTop as the base for absolute restoration,
      // so browser scroll anchoring adjustments during the skeleton phase don't skew the result.
      savedScrollHeightRef.current = el.scrollHeight
      savedScrollTopRef.current = el.scrollTop
      onLoadOlder()
    }

    // Load newer when at the bottom but not at latest
    if (!isLoadingNewer && !latestReachedRef.current && atBottom && onLoadNewerRef.current) {
      onLoadNewerRef.current()
    }

    // ACK when at the bottom with all messages loaded.
    // Debounced: schedule once when the user first arrives at the bottom;
    // cancel immediately if they scroll away before the delay elapses.
    if (atBottom && latestReachedRef.current && onAckLatestRef.current) {
      if (ackTimerRef.current === null) {
        ackTimerRef.current = setTimeout(() => {
          ackTimerRef.current = null
          onAckLatestRef.current?.()
        }, ACK_DEBOUNCE)
      }
    } else {
      if (ackTimerRef.current !== null) {
        clearTimeout(ackTimerRef.current)
        ackTimerRef.current = null
      }
    }
  }

  // Cancel any pending ACK timer on unmount (channel navigation / component teardown)
  useEffect(() => {
    return () => {
      if (ackTimerRef.current !== null) {
        clearTimeout(ackTimerRef.current)
        ackTimerRef.current = null
      }
    }
  }, [])

  // ── Full-screen initial skeleton ──────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex-1 min-h-0 overflow-hidden px-4 py-4 space-y-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3">
            <Skeleton className="w-9 h-9 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-full" />
              {i % 3 === 0 && <Skeleton className="h-3 w-3/4" />}
            </div>
          </div>
        ))}
      </div>
    )
  }

  // ── Main scrollable view ──────────────────────────────────────────────────
  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto"
        style={{ overflowAnchor: 'none' }}
      >
        {/* min-h-full lets the flex column always fill the viewport */}
        <div className="flex flex-col min-h-full px-4">

          {/* Older-page skeleton at the top */}
          {isLoadingOlder && <PaginationSkeleton />}

          {/* "Beginning of history" panel — only once confirmed by the server */}
          {endReached && !isLoadingOlder && (
            <ConversationStart channelName={channelName} />
          )}

          {/* mt-auto pushes content to the bottom when shorter than the viewport */}
          <div className="mt-auto pb-4">
            {messages.map((msg, i) => {
              const prev = messages[i - 1]
              const grouped = prev ? isGroupedWith(msg, prev) : false
              const showDivider =
                !prev || snowflakeToDayLabel(msg.id) !== snowflakeToDayLabel(prev.id)

              // "NEW MESSAGES" separator appears BEFORE the first unread message,
              // i.e. after the last-read message (unreadSeparatorAfter = lastReadId).
              const showUnreadSeparator =
                unreadSeparatorAfter != null &&
                prev != null &&
                String(prev.id) === unreadSeparatorAfter

              return (
                <Fragment key={String(msg.id)}>
                  {showDivider && <DateDivider label={snowflakeToDayLabel(msg.id)} />}
                  {showUnreadSeparator && (
                    <div
                      ref={separatorRef}
                      className="flex items-center gap-2 my-2 px-2 select-none"
                    >
                      <div className="flex-1 h-px bg-red-500/60" />
                      <span className="text-xs font-semibold text-red-400 px-2 whitespace-nowrap">
                        {t('chat.newMessages')}
                      </span>
                      <div className="flex-1 h-px bg-red-500/60" />
                    </div>
                  )}
                  <div data-message-id={String(msg.id)} style={{ paddingTop: chatSpacing }}>
                    <MessageItem message={msg} isGrouped={grouped} resolver={resolver} />
                  </div>
                </Fragment>
              )
            })}
          </div>

          {/* Newer-page skeleton at the bottom */}
          {isLoadingNewer && <PaginationSkeleton />}

        </div>
      </div>

      {/* Jump-to-bottom button */}
      {showJumpButton && (
        <button
          onClick={() => {
            const el = scrollRef.current
            if (el) el.scrollTop = el.scrollHeight
          }}
          className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors"
        >
          <ChevronDown className="w-3.5 h-3.5" />
          {latestReached ? t('chat.jumpToBottom') : t('chat.jumpToPresent')}
        </button>
      )}
    </div>
  )
}
