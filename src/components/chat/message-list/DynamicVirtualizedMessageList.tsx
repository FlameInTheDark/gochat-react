import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type UIEvent,
} from 'react'
import { cn } from '@/lib/utils'
import ListItem from './ListItem'
import type {
  DynamicVirtualizedMessageListHandle,
  DynamicVirtualizedMessageListItem,
  DynamicVirtualizedMessageListProps,
  ScrollAlignment,
} from './types'
import {
  buildMeasurements,
  getAnchorIndex,
  getOffsetForAlignment,
  getVisibleRange,
  isAtBottomPosition,
  type Measurements,
} from './math'

interface AnchorSnapshot {
  key: string
  offsetWithinItem: number
}

interface PendingScrollRestore {
  keepBottom: boolean
  anchor: AnchorSnapshot | null
  fallbackScrollTop: number
  previousContentHeight: number
}

interface ScrollState {
  direction: 'backward' | 'forward'
  scrollTop: number
  scrollUpdateWasRequested: boolean
}

const DEFAULT_BOTTOM_PADDING = 16
const DEFAULT_BOTTOM_THRESHOLD = 48
const DEFAULT_OVERSCAN_BACKWARD = 8
const DEFAULT_OVERSCAN_FORWARD = 12

function clamp(value: number, min: number, max: number) {
  if (value < min) return min
  if (value > max) return max
  return value
}

function arraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function findFirstChangedIndex(previousIds: string[], nextIds: string[]) {
  const sharedLength = Math.min(previousIds.length, nextIds.length)

  for (let index = 0; index < sharedLength; index += 1) {
    if (previousIds[index] !== nextIds[index]) {
      return index
    }
  }

  return previousIds.length === nextIds.length ? -1 : sharedLength
}

function getItemOffset(
  measurements: Measurements,
  index: number,
  leadingSpacer: number,
) {
  return leadingSpacer + (measurements.offsets[index] ?? 0)
}

function getMaxScrollTop(contentHeight: number, viewportHeight: number) {
  return Math.max(contentHeight - viewportHeight, 0)
}

const DynamicVirtualizedMessageList = forwardRef(function DynamicVirtualizedMessageList<
  TItem extends DynamicVirtualizedMessageListItem,
>(
  {
    items,
    estimateItemHeight,
    renderItem,
    bottomPadding = DEFAULT_BOTTOM_PADDING,
    className,
    innerClassName,
    overscanCountBackward = DEFAULT_OVERSCAN_BACKWARD,
    overscanCountForward = DEFAULT_OVERSCAN_FORWARD,
    bottomThreshold = DEFAULT_BOTTOM_THRESHOLD,
    onItemsRendered,
    onScroll,
  }: DynamicVirtualizedMessageListProps<TItem>,
  ref: React.ForwardedRef<DynamicVirtualizedMessageListHandle>,
) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const itemIds = useMemo(() => items.map((item) => item.key), [items])
  const [sizeMap, setSizeMap] = useState(() => new Map<string, number>())
  const previousItemIdsRef = useRef(itemIds)
  const anchorSnapshotRef = useRef<AnchorSnapshot | null>(null)
  const atBottomSnapshotRef = useRef(true)
  const pendingRestoreRef = useRef<PendingScrollRestore | null>(null)
  const requestedScrollRef = useRef(false)
  // Set to true when a programmatic scroll correction is applied within a layout effect.
  // Suppresses the onItemsRendered call in the same render cycle so that the stale
  // renderedRange (computed from pre-correction scrollTop) doesn't trigger a spurious
  // gap auto-load. The flag is cleared immediately so the next render (after the scroll
  // event updates scrollState) fires onItemsRendered with the correct range.
  const scrollCorrectionPendingRef = useRef(false)
  const [viewport, setViewport] = useState({ height: 0, width: 0 })
  const [scrollState, setScrollState] = useState<ScrollState>({
    direction: 'forward' as const,
    scrollTop: 0,
    scrollUpdateWasRequested: false,
  })

  const measurements = useMemo(
    () => buildMeasurements(items, sizeMap, estimateItemHeight),
    [estimateItemHeight, items, sizeMap],
  )

  const leadingSpacer = useMemo(
    () => Math.max(viewport.height - (measurements.totalHeight + bottomPadding), 0),
    [bottomPadding, measurements.totalHeight, viewport.height],
  )
  const contentHeight = useMemo(
    () => leadingSpacer + measurements.totalHeight + bottomPadding,
    [bottomPadding, leadingSpacer, measurements.totalHeight],
  )

  const renderedRange = useMemo(
    () => getVisibleRange(
      measurements,
      items.length,
      scrollState.scrollTop,
      viewport.height,
      leadingSpacer,
      overscanCountBackward,
      overscanCountForward,
    ),
    [
      items.length,
      leadingSpacer,
      measurements,
      overscanCountBackward,
      overscanCountForward,
      scrollState.scrollTop,
      viewport.height,
    ],
  )

  const captureAnchor = useCallback((): AnchorSnapshot | null => {
    if (!scrollerRef.current || items.length === 0) {
      return null
    }

    const anchorIndex = getAnchorIndex(renderedRange, scrollState.direction, items.length)
    if (anchorIndex < 0) {
      return null
    }

    const itemOffset = getItemOffset(measurements, anchorIndex, leadingSpacer)

    return {
      key: items[anchorIndex]?.key ?? items[0].key,
      offsetWithinItem: scrollerRef.current.scrollTop - itemOffset,
    }
  }, [items, leadingSpacer, measurements, renderedRange, scrollState.direction])

  // ---------------------------------------------------------------------------
  // Stable refs — updated inline every render so callbacks that need current
  // values can read them without being listed as useCallback/useEffect deps.
  // This prevents handleHeightChange and the ResizeObserver from being
  // recreated on every scroll event (which previously happened because
  // captureAnchor → renderedRange → scrollState.scrollTop all changed on scroll).
  // ---------------------------------------------------------------------------
  const captureAnchorRef = useRef(captureAnchor)
  captureAnchorRef.current = captureAnchor

  const contentHeightRef = useRef(contentHeight)
  contentHeightRef.current = contentHeight

  const sizeMapRef = useRef(sizeMap)
  sizeMapRef.current = sizeMap

  const itemIdsRef = useRef(itemIds)
  itemIdsRef.current = itemIds

  const visibleStartIndexRef = useRef(renderedRange.visibleStartIndex)
  visibleStartIndexRef.current = renderedRange.visibleStartIndex

  const viewportHeightRef = useRef(viewport.height)
  viewportHeightRef.current = viewport.height

  const applyImmediateScrollOffset = useCallback((scrollTop: number) => {
    if (!scrollerRef.current) {
      return
    }

    const clampedTop = clamp(scrollTop, 0, getMaxScrollTop(contentHeight, viewport.height))
    requestedScrollRef.current = true
    scrollerRef.current.scrollTop = clampedTop
    setScrollState((current) => ({
      direction: current.scrollTop > clampedTop ? 'backward' : 'forward',
      scrollTop: clampedTop,
      scrollUpdateWasRequested: true,
    }))
  }, [contentHeight, viewport.height])

  const restoreAnchorImmediately = useCallback((anchor: AnchorSnapshot | null) => {
    if (!scrollerRef.current || !anchor) {
      return false
    }

    const index = itemIds.indexOf(anchor.key)
    if (index < 0) {
      return false
    }

    applyImmediateScrollOffset(
      getItemOffset(measurements, index, leadingSpacer) + anchor.offsetWithinItem,
    )
    return true
  }, [applyImmediateScrollOffset, itemIds, leadingSpacer, measurements])

  const scrollToOffset = useCallback((scrollTop: number, behavior: ScrollBehavior = 'auto') => {
    if (!scrollerRef.current) {
      return
    }

    const clampedTop = clamp(scrollTop, 0, getMaxScrollTop(contentHeight, viewport.height))
    requestedScrollRef.current = true
    scrollerRef.current.scrollTo({ top: clampedTop, behavior })
    setScrollState((current) => ({
      direction: current.scrollTop > clampedTop ? 'backward' : 'forward',
      scrollTop: clampedTop,
      scrollUpdateWasRequested: true,
    }))
  }, [contentHeight, viewport.height])

  const scrollToIndex = useCallback((
    index: number,
    align: ScrollAlignment = 'auto',
    offset = 0,
    behavior: ScrollBehavior = 'auto',
  ) => {
    const targetTop = getOffsetForAlignment(
      measurements,
      index,
      align,
      scrollerRef.current?.scrollTop ?? scrollState.scrollTop,
      viewport.height,
      leadingSpacer,
      contentHeight,
    ) + offset

    scrollToOffset(targetTop, behavior)
  }, [contentHeight, leadingSpacer, measurements, scrollState.scrollTop, scrollToOffset, viewport.height])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const scroller = scrollerRef.current
    if (!scroller) return
    // Use actual DOM scrollHeight so we always reach the true bottom, even when virtual
    // contentHeight is computed from unresolved estimated item sizes. Items are laid out
    // at their real heights by the browser before paint, so scrollHeight is authoritative.
    const target = scroller.scrollHeight - scroller.clientHeight
    requestedScrollRef.current = true
    if (behavior === 'auto') {
      scroller.scrollTop = target
    } else {
      scroller.scrollTo({ top: target, behavior })
    }
    const actualTop = scroller.scrollTop
    setScrollState((current) => ({
      direction: current.scrollTop > actualTop ? 'backward' : 'forward',
      scrollTop: actualTop,
      scrollUpdateWasRequested: true,
    }))
  }, [])

  // Only depends on bottomThreshold (a stable constant prop) — all other values are read
  // from refs so this callback never needs to be recreated on scroll/layout changes.
  // This is what makes memo(ListItem) effective: onHeightChange stays the same reference.
  const handleHeightChange = useCallback((
    itemId: string,
    newHeight: number,
    forceScrollCorrection: boolean,
  ) => {
    if (newHeight <= 0) {
      return
    }

    // Early-out via ref avoids calling setSizeMap (and potentially capturing an anchor)
    // when the observed height hasn't actually changed.
    const previousHeight = sizeMapRef.current.get(itemId)
    if (previousHeight === newHeight) {
      return
    }

    const itemIndex = itemIdsRef.current.indexOf(itemId)
    const currentViewportHeight = viewportHeightRef.current
    const currentContentHeight = contentHeightRef.current
    const shouldKeepBottom = scrollerRef.current
      ? isAtBottomPosition(
          scrollerRef.current.scrollTop,
          currentViewportHeight,
          currentContentHeight,
          bottomThreshold,
        )
      : atBottomSnapshotRef.current
    const fallbackScrollTop = scrollerRef.current?.scrollTop ?? 0
    const shouldPreserveAnchor = forceScrollCorrection ||
      shouldKeepBottom ||
      (itemIndex >= 0 && itemIndex < visibleStartIndexRef.current)

    if (shouldPreserveAnchor) {
      pendingRestoreRef.current = {
        keepBottom: shouldKeepBottom,
        anchor: captureAnchorRef.current(),
        fallbackScrollTop,
        previousContentHeight: currentContentHeight,
      }
    }

    setSizeMap((current) => {
      const currentHeight = current.get(itemId)
      if (currentHeight === newHeight) {
        return current
      }

      const next = new Map(current)
      next.set(itemId, newHeight)
      return next
    })
  }, [bottomThreshold])

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const nextScrollTop = event.currentTarget.scrollTop
    const nextDirection = nextScrollTop >= scrollState.scrollTop ? 'forward' : 'backward'
    const scrollUpdateWasRequested = requestedScrollRef.current
    requestedScrollRef.current = false

    setScrollState({
      direction: nextDirection,
      scrollTop: nextScrollTop,
      scrollUpdateWasRequested,
    })
  }, [scrollState.scrollTop])

  // Only re-runs when bottomThreshold changes (effectively once on mount, since
  // bottomThreshold is a stable constant). captureAnchor and contentHeight are read
  // from refs so they're always current without being listed as deps — this was the
  // root cause of the ResizeObserver being destroyed/recreated on every scroll event.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) {
      return
    }

    const measure = () => {
      setViewport((current) => {
        const nextViewport = {
          height: scroller.clientHeight,
          width: scroller.clientWidth,
        }

        if (
          current.height === nextViewport.height &&
          current.width === nextViewport.width
        ) {
          return current
        }

        if (current.width > 0 && current.width !== nextViewport.width) {
          pendingRestoreRef.current = {
            keepBottom: isAtBottomPosition(
              scroller.scrollTop,
              current.height,
              contentHeightRef.current,
              bottomThreshold,
            ),
            anchor: captureAnchorRef.current(),
            fallbackScrollTop: scroller.scrollTop,
            previousContentHeight: contentHeightRef.current,
          }
          setSizeMap(new Map())
        }

        return nextViewport
      })
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)

    return () => observer.disconnect()
  }, [bottomThreshold])

  useLayoutEffect(() => {
    if (arraysEqual(previousItemIdsRef.current, itemIds)) {
      return
    }

    const firstChangedIndex = findFirstChangedIndex(previousItemIdsRef.current, itemIds)
    const shouldKeepBottom = atBottomSnapshotRef.current
    const insertedBeforeVisible = firstChangedIndex >= 0 && firstChangedIndex <= renderedRange.visibleStartIndex
    // Special case: items inserted just after index 0 while the visible area starts at 0.
    // This happens when new messages are prepended after a top gap (gap stays at index 0,
    // new messages appear at index 1). The anchor (the gap) doesn't move, so a normal
    // anchor restore would be a no-op. Instead we pass null anchor to force the
    // delta-scroll fallback, which shifts scrollTop by the new content height and keeps
    // the previously-visible content in place.
    const insertedAtTopEdge = !shouldKeepBottom &&
      firstChangedIndex === 1 &&
      renderedRange.visibleStartIndex === 0
    const shouldPreserveAnchor = shouldKeepBottom || insertedBeforeVisible || insertedAtTopEdge

    if (!shouldPreserveAnchor) {
      previousItemIdsRef.current = itemIds
      return
    }

    pendingRestoreRef.current = {
      keepBottom: shouldKeepBottom,
      anchor: insertedAtTopEdge ? null : anchorSnapshotRef.current,
      fallbackScrollTop: scrollerRef.current?.scrollTop ?? scrollState.scrollTop,
      previousContentHeight: contentHeight,
    }
    previousItemIdsRef.current = itemIds
  }, [contentHeight, itemIds, renderedRange.visibleStartIndex, scrollState.scrollTop])

  useLayoutEffect(() => {
    const pendingRestore = pendingRestoreRef.current
    if (!pendingRestore || !scrollerRef.current) {
      return
    }

    pendingRestoreRef.current = null
    // Signal that we're applying a scroll correction so that the onItemsRendered
    // effect below can suppress the stale-range notification for this render cycle.
    scrollCorrectionPendingRef.current = true

    if (pendingRestore.keepBottom) {
      // Use actual DOM scrollHeight rather than virtual contentHeight. When new items mount,
      // ListItem measures their real offsetHeight synchronously (useLayoutEffect) and queues
      // a sizeMap update — but that update causes a second render cycle where this effect
      // would find no pendingRestore. By scrolling to the actual DOM bottom here (in the
      // first cycle, before paint), we land at the correct position immediately without
      // needing a second correction pass.
      const target = scrollerRef.current.scrollHeight - scrollerRef.current.clientHeight
      requestedScrollRef.current = true
      scrollerRef.current.scrollTop = target
      const actualTop = scrollerRef.current.scrollTop
      setScrollState((current) => ({
        direction: current.scrollTop > actualTop ? 'backward' : 'forward',
        scrollTop: actualTop,
        scrollUpdateWasRequested: true,
      }))
      return
    }

    if (restoreAnchorImmediately(pendingRestore.anchor)) {
      return
    }

    applyImmediateScrollOffset(
      pendingRestore.fallbackScrollTop + (contentHeight - pendingRestore.previousContentHeight),
    )
  }, [applyImmediateScrollOffset, contentHeight, restoreAnchorImmediately, viewport.height])

  useLayoutEffect(() => {
    anchorSnapshotRef.current = captureAnchor()
    atBottomSnapshotRef.current = isAtBottomPosition(
      scrollerRef.current?.scrollTop ?? scrollState.scrollTop,
      viewport.height,
      contentHeight,
      bottomThreshold,
    )
  }, [bottomThreshold, captureAnchor, contentHeight, renderedRange, scrollState.scrollTop, viewport.height])

  useLayoutEffect(() => {
    // If a scroll correction was applied in this render cycle, the renderedRange is
    // based on the pre-correction scrollTop and would be stale. Skip this notification
    // and let the scroll event trigger a fresh render with the correct range.
    if (scrollCorrectionPendingRef.current) {
      scrollCorrectionPendingRef.current = false
      return
    }
    onItemsRendered?.(renderedRange)
  }, [onItemsRendered, renderedRange])

  useEffect(() => {
    onScroll?.({
      scrollDirection: scrollState.direction,
      scrollOffset: scrollState.scrollTop,
      scrollUpdateWasRequested: scrollState.scrollUpdateWasRequested,
      scrollHeight: contentHeight,
      clientHeight: viewport.height,
    })
  }, [contentHeight, onScroll, scrollState, viewport.height])

  useImperativeHandle(ref, (): DynamicVirtualizedMessageListHandle => ({
    scrollToIndex,
    scrollToBottom,
    getVisibleRange: () => renderedRange,
    isAtBottom: () => isAtBottomPosition(
      scrollerRef.current?.scrollTop ?? scrollState.scrollTop,
      viewport.height,
      contentHeight,
      bottomThreshold,
    ),
    getScroller: () => scrollerRef.current,
  }), [bottomThreshold, contentHeight, renderedRange, scrollState.scrollTop, scrollToBottom, scrollToIndex, viewport.height])

  const visibleItems = useMemo(() => {
    if (renderedRange.visibleStopIndex < renderedRange.visibleStartIndex) {
      return []
    }

    return items.slice(
      renderedRange.overscanStartIndex,
      renderedRange.overscanStopIndex + 1,
    )
  }, [items, renderedRange.overscanStartIndex, renderedRange.overscanStopIndex, renderedRange.visibleStartIndex, renderedRange.visibleStopIndex])

  const topPadding = renderedRange.visibleStopIndex < renderedRange.visibleStartIndex
    ? leadingSpacer
    : getItemOffset(measurements, renderedRange.overscanStartIndex, leadingSpacer)
  const bottomPaddingPx = renderedRange.visibleStopIndex < renderedRange.visibleStartIndex
    ? bottomPadding
    : Math.max(
        contentHeight -
          topPadding -
          visibleItems.reduce((sum, _item, visibleIndex) => {
            const index = renderedRange.overscanStartIndex + visibleIndex
            return sum + (measurements.sizes[index] ?? 0)
          }, 0),
        bottomPadding,
      )

  return (
    <div
      ref={scrollerRef}
      className={cn(
        'message-list__scroller h-full overflow-y-auto',
        className,
      )}
      style={{ overscrollBehavior: 'contain', willChange: 'scroll-position' }}
      onScroll={handleScroll}
    >
      <div
        className={cn('message-list__inner', innerClassName)}
        style={{
          paddingTop: `${topPadding}px`,
          paddingBottom: `${bottomPaddingPx}px`,
        }}
      >
        {visibleItems.map((item, visibleIndex) => {
          const index = renderedRange.overscanStartIndex + visibleIndex
          const measuredHeight = measurements.sizes[index] ?? estimateItemHeight(item, index)

          return (
            <ListItem
              key={item.key}
              itemId={item.key}
              item={item}
              renderItem={renderItem}
              itemIndex={index}
              height={measuredHeight}
              width={viewport.width}
              onHeightChange={handleHeightChange}
            />
          )
        })}
      </div>
    </div>
  )
}) as <TItem extends DynamicVirtualizedMessageListItem>(
  props: DynamicVirtualizedMessageListProps<TItem> & {
    ref?: React.ForwardedRef<DynamicVirtualizedMessageListHandle>
  },
) => ReactElement

export default DynamicVirtualizedMessageList
