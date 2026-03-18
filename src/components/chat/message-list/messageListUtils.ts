import type { JumpRequest, MessageTimelineRow } from '@/lib/messageJump'
import type { OnItemsRenderedArgs, ScrollAlignment } from './types'

export interface ResolvedInitialScrollTarget {
  type: 'focus' | 'jump' | 'unread' | 'bottom'
  index: number | null
  align?: ScrollAlignment
  offset?: number
  behavior?: ScrollBehavior
}

export function resolveUnreadTargetIndex(rows: MessageTimelineRow[]): number | null {
  const unreadIndex = rows.findIndex((row) => row.kind === 'unread-separator')
  if (unreadIndex < 0) {
    return null
  }

  const nextRow = rows[unreadIndex + 1]
  if (nextRow?.kind === 'date-divider') {
    return unreadIndex + 1
  }

  const previousRow = rows[unreadIndex - 1]
  if (previousRow?.kind === 'date-divider') {
    return unreadIndex - 1
  }

  return unreadIndex
}

export function resolveInitialScrollTarget(
  rows: MessageTimelineRow[],
  options: {
    focusTargetRowKey?: string | null
    jumpTargetRowKey?: string | null
    highlightRequest?: JumpRequest | null
  },
): ResolvedInitialScrollTarget {
  if (options.focusTargetRowKey) {
    const index = rows.findIndex((row) => row.key === options.focusTargetRowKey)
    if (index >= 0) {
      return {
        type: 'focus',
        index,
        align: 'center',
        behavior: 'auto',
      }
    }
  }

  if (options.jumpTargetRowKey) {
    const index = rows.findIndex((row) => row.key === options.jumpTargetRowKey)
    if (index >= 0) {
      return {
        type: 'jump',
        index,
        align: 'center',
        behavior: options.highlightRequest?.behavior === 'direct-scroll' ? 'smooth' : 'auto',
      }
    }
  }

  const unreadIndex = resolveUnreadTargetIndex(rows)
  if (unreadIndex != null) {
    return {
      type: 'unread',
      index: unreadIndex,
      align: 'start',
      offset: -50,
      behavior: 'auto',
    }
  }

  return {
    type: 'bottom',
    index: null,
    behavior: 'auto',
  }
}

export function getAutoloadGapKeys(rows: MessageTimelineRow[], renderedRange: OnItemsRenderedArgs): string[] {
  if (renderedRange.visibleStopIndex < renderedRange.visibleStartIndex) {
    return []
  }

  const keys = new Set<string>()

  // Older gaps: scan from overscan start through the entire visible area (not just the first
  // visible item). This ensures between-gaps that happen to sit in the middle of the viewport
  // are auto-loaded instead of requiring a manual click.
  for (
    let index = renderedRange.overscanStartIndex;
    index <= Math.min(renderedRange.visibleStopIndex, rows.length - 1);
    index += 1
  ) {
    const row = rows[index]
    if (row?.kind === 'gap' && row.status === 'idle' && row.direction === 'older') {
      keys.add(row.key)
    }
  }

  // Newer gaps: scan from the entire visible area through overscan end (symmetric with above).
  for (
    let index = Math.max(renderedRange.visibleStartIndex, 0);
    index <= Math.min(renderedRange.overscanStopIndex, rows.length - 1);
    index += 1
  ) {
    const row = rows[index]
    if (row?.kind === 'gap' && row.status === 'idle' && row.direction === 'newer') {
      keys.add(row.key)
    }
  }

  return [...keys]
}
