import type { DynamicVirtualizedMessageListItem, OnItemsRenderedArgs, ScrollAlignment } from './types'

export interface Measurements {
  offsets: number[]
  sizes: number[]
  totalHeight: number
}

function clamp(value: number, min: number, max: number) {
  if (value < min) return min
  if (value > max) return max
  return value
}

function findIndexForOffset(
  measurements: Measurements,
  offset: number,
  leadingSpacer: number,
  itemCount: number,
) {
  if (itemCount === 0) {
    return 0
  }

  const adjustedOffset = Math.max(offset - leadingSpacer, 0)
  let low = 0
  let high = itemCount - 1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const start = measurements.offsets[mid]
    const end = start + measurements.sizes[mid]

    if (adjustedOffset < start) {
      high = mid - 1
      continue
    }

    if (adjustedOffset >= end) {
      low = mid + 1
      continue
    }

    return mid
  }

  return clamp(low, 0, itemCount - 1)
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

export function getAnchorIndex(
  renderedRange: OnItemsRenderedArgs,
  scrollDirection: 'backward' | 'forward',
  itemCount: number,
) {
  if (itemCount === 0) {
    return -1
  }

  if (renderedRange.visibleStopIndex < renderedRange.visibleStartIndex) {
    return clamp(renderedRange.visibleStartIndex, 0, itemCount - 1)
  }

  return clamp(
    scrollDirection === 'backward'
      ? renderedRange.visibleStopIndex
      : renderedRange.visibleStartIndex,
    0,
    itemCount - 1,
  )
}

export function buildMeasurements<TItem extends DynamicVirtualizedMessageListItem>(
  items: TItem[],
  sizeMap: Map<string, number>,
  estimateItemHeight: (item: TItem, index: number) => number,
): Measurements {
  const offsets = new Array<number>(items.length)
  const sizes = new Array<number>(items.length)

  let offset = 0
  for (let index = 0; index < items.length; index += 1) {
    offsets[index] = offset
    const item = items[index]
    const cachedSize = sizeMap.get(item.key)
    const size = Math.max(0, Math.ceil(cachedSize ?? estimateItemHeight(item, index)))
    sizes[index] = size
    offset += size
  }

  return {
    offsets,
    sizes,
    totalHeight: offset,
  }
}

export function getVisibleRange(
  measurements: Measurements,
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  leadingSpacer: number,
  overscanCountBackward: number,
  overscanCountForward: number,
): OnItemsRenderedArgs {
  if (itemCount === 0) {
    return {
      overscanStartIndex: 0,
      overscanStopIndex: -1,
      visibleStartIndex: 0,
      visibleStopIndex: -1,
    }
  }

  const visibleStartIndex = findIndexForOffset(
    measurements,
    scrollTop,
    leadingSpacer,
    itemCount,
  )
  const visibleStopIndex = findIndexForOffset(
    measurements,
    scrollTop + viewportHeight,
    leadingSpacer,
    itemCount,
  )
  const viewportOverscan = viewportHeight * 2
  const viewportOverscanStartIndex = findIndexForOffset(
    measurements,
    scrollTop - viewportOverscan,
    leadingSpacer,
    itemCount,
  )
  const viewportOverscanStopIndex = findIndexForOffset(
    measurements,
    scrollTop + viewportHeight + viewportOverscan,
    leadingSpacer,
    itemCount,
  )

  return {
    overscanStartIndex: Math.min(
      viewportOverscanStartIndex,
      clamp(visibleStartIndex - overscanCountBackward, 0, itemCount - 1),
    ),
    overscanStopIndex: Math.max(
      viewportOverscanStopIndex,
      clamp(visibleStopIndex + overscanCountForward, 0, itemCount - 1),
    ),
    visibleStartIndex,
    visibleStopIndex,
  }
}

export function getOffsetForAlignment(
  measurements: Measurements,
  index: number,
  align: ScrollAlignment,
  currentScrollTop: number,
  viewportHeight: number,
  leadingSpacer: number,
  contentHeight: number,
) {
  if (index < 0 || index >= measurements.sizes.length) {
    return currentScrollTop
  }

  const itemOffset = getItemOffset(measurements, index, leadingSpacer)
  const itemSize = measurements.sizes[index] ?? 0
  const maxScrollTop = getMaxScrollTop(contentHeight, viewportHeight)

  switch (align) {
    case 'start':
      return clamp(itemOffset, 0, maxScrollTop)
    case 'center':
      return clamp(itemOffset - (viewportHeight / 2) + (itemSize / 2), 0, maxScrollTop)
    case 'end':
      return clamp(itemOffset - viewportHeight + itemSize, 0, maxScrollTop)
    case 'auto':
    default: {
      const itemStart = itemOffset
      const itemEnd = itemStart + itemSize
      const viewportStart = currentScrollTop
      const viewportEnd = currentScrollTop + viewportHeight

      if (itemStart >= viewportStart && itemEnd <= viewportEnd) {
        return currentScrollTop
      }

      if (itemStart < viewportStart) {
        return clamp(itemStart, 0, maxScrollTop)
      }

      return clamp(itemEnd - viewportHeight, 0, maxScrollTop)
    }
  }
}

export function isAtBottomPosition(
  scrollTop: number,
  viewportHeight: number,
  contentHeight: number,
  bottomThreshold: number,
) {
  return scrollTop + viewportHeight >= contentHeight - bottomThreshold
}
