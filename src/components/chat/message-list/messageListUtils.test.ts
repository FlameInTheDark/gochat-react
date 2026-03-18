import { describe, expect, it } from 'vitest'
import type { MessageTimelineRow } from '@/lib/messageJump'
import {
  getAutoloadGapKeys,
  resolveInitialScrollTarget,
  resolveUnreadTargetIndex,
} from './messageListUtils'

describe('message list targeting helpers', () => {
  it('prefers focus targets over jump and unread targets', () => {
    const rows: MessageTimelineRow[] = [
      { kind: 'date-divider', key: 'date:1', label: 'Today' },
      { kind: 'unread-separator', key: 'unread:1' },
      { kind: 'conversation-start', key: 'focus-row' },
    ]

    expect(resolveInitialScrollTarget(rows, {
      focusTargetRowKey: 'focus-row',
      jumpTargetRowKey: 'date:1',
      highlightRequest: {
        messageId: '123',
        requestKey: 'jump-1',
        behavior: 'direct-scroll',
      },
    })).toEqual({
      type: 'focus',
      index: 2,
      align: 'center',
      behavior: 'auto',
    })
  })

  it('maps jump requests to centered scroll behavior', () => {
    const rows: MessageTimelineRow[] = [
      { kind: 'conversation-start', key: 'top' },
      { kind: 'date-divider', key: 'jump-row', label: 'Today' },
    ]

    expect(resolveInitialScrollTarget(rows, {
      jumpTargetRowKey: 'jump-row',
      highlightRequest: {
        messageId: '222',
        requestKey: 'jump-2',
        behavior: 'direct-scroll',
      },
    })).toEqual({
      type: 'jump',
      index: 1,
      align: 'center',
      behavior: 'smooth',
    })
  })

  it('targets the adjacent date divider for unread anchors when present', () => {
    const rows: MessageTimelineRow[] = [
      { kind: 'date-divider', key: 'date:unread', label: 'Yesterday' },
      { kind: 'unread-separator', key: 'unread:123' },
      { kind: 'conversation-start', key: 'conversation-start' },
    ]

    expect(resolveUnreadTargetIndex(rows)).toBe(0)
    expect(resolveInitialScrollTarget(rows, {})).toEqual({
      type: 'unread',
      index: 0,
      align: 'start',
      offset: -50,
      behavior: 'auto',
    })
  })

  it('selects only idle older and newer gaps within their trigger ranges', () => {
    const rows: MessageTimelineRow[] = [
      {
        kind: 'gap',
        key: 'gap:older',
        direction: 'older',
        gapKind: 'older-edge',
        status: 'idle',
        heightPx: 120,
      },
      { kind: 'date-divider', key: 'date:1', label: 'Today' },
      {
        kind: 'gap',
        key: 'gap:newer',
        direction: 'newer',
        gapKind: 'newer-edge',
        status: 'idle',
        heightPx: 120,
      },
      {
        kind: 'gap',
        key: 'gap:error',
        direction: 'newer',
        gapKind: 'between',
        status: 'error',
        heightPx: 120,
      },
    ]

    expect(getAutoloadGapKeys(rows, {
      overscanStartIndex: 0,
      overscanStopIndex: 2,
      visibleStartIndex: 1,
      visibleStopIndex: 1,
    })).toEqual(['gap:older', 'gap:newer'])
  })
})
