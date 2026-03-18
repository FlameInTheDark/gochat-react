import type { ReactNode } from 'react'

export type ScrollAlignment = 'auto' | 'start' | 'center' | 'end'

export interface OnScrollArgs {
  scrollDirection: 'backward' | 'forward'
  scrollOffset: number
  scrollUpdateWasRequested: boolean
  scrollHeight: number
  clientHeight: number
}

export interface OnItemsRenderedArgs {
  overscanStartIndex: number
  overscanStopIndex: number
  visibleStartIndex: number
  visibleStopIndex: number
}

export interface DynamicVirtualizedMessageListHandle {
  scrollToIndex: (
    index: number,
    align?: ScrollAlignment,
    offset?: number,
    behavior?: ScrollBehavior,
  ) => void
  scrollToBottom: (behavior?: ScrollBehavior) => void
  getVisibleRange: () => OnItemsRenderedArgs
  isAtBottom: () => boolean
  getScroller: () => HTMLDivElement | null
}

export interface DynamicVirtualizedMessageListItem {
  key: string
}

export interface DynamicVirtualizedMessageListProps<TItem extends DynamicVirtualizedMessageListItem> {
  items: TItem[]
  estimateItemHeight: (item: TItem, index: number) => number
  renderItem: (item: TItem, index: number) => ReactNode
  bottomPadding?: number
  className?: string
  innerClassName?: string
  overscanCountBackward?: number
  overscanCountForward?: number
  bottomThreshold?: number
  onItemsRendered?: (args: OnItemsRenderedArgs) => void
  onScroll?: (args: OnScrollArgs) => void
}
