import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageTimelineRow } from '@/lib/messageJump'
import type {
  DynamicVirtualizedMessageListHandle,
  OnItemsRenderedArgs,
} from '@/components/chat/message-list/types'
import MessageList from './MessageList'

const scrollToIndexMock = vi.fn()
const scrollToBottomMock = vi.fn()
let latestVirtualizerProps: Record<string, unknown> | null = null

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        if (options?.name && typeof options.name === 'string') {
          return `${key}:${options.name}`
        }
        return key
      },
    }),
  }
})

vi.mock('@/components/chat/message-list/DynamicVirtualizedMessageList', () => ({
  default: forwardRef(function MockDynamicVirtualizedMessageList(
    props: Record<string, unknown>,
    ref,
  ) {
    const scrollerRef = useRef<HTMLDivElement | null>(null)

    useImperativeHandle(ref, (): DynamicVirtualizedMessageListHandle => ({
      scrollToIndex: (...args) => scrollToIndexMock(...args),
      scrollToBottom: (...args) => scrollToBottomMock(...args),
      getVisibleRange: () => ({
        overscanStartIndex: 0,
        overscanStopIndex: ((props.items as MessageTimelineRow[])?.length ?? 1) - 1,
        visibleStartIndex: 0,
        visibleStopIndex: ((props.items as MessageTimelineRow[])?.length ?? 1) - 1,
      }),
      isAtBottom: () => false,
      getScroller: () => scrollerRef.current,
    }), [props.items])

    useEffect(() => {
      latestVirtualizerProps = props
    }, [props])

    useEffect(() => {
      ;(props.onScroll as ((args: {
        scrollDirection: 'forward'
        scrollOffset: number
        scrollUpdateWasRequested: boolean
        scrollHeight: number
        clientHeight: number
      }) => void) | undefined)?.({
        scrollDirection: 'forward',
        scrollOffset: 0,
        scrollUpdateWasRequested: false,
        scrollHeight: 1000,
        clientHeight: 600,
      })
    }, [props.onScroll])

    return (
      <div
        ref={scrollerRef}
        data-testid="mock-list"
        data-test-client-height="600"
        data-test-client-width="480"
        data-test-height="600"
      >
        {(props.items as MessageTimelineRow[]).map((item, index) => (
          <div
            key={item.key}
            data-row-key={item.key}
            data-message-id={item.kind === 'message' ? String(item.message.id) : undefined}
            data-test-height="40"
          >
            {(props.renderItem as (row: MessageTimelineRow, index: number) => ReactNode)(item, index)}
          </div>
        ))}
      </div>
    )
  }),
}))

function getVirtualizerProps() {
  if (!latestVirtualizerProps) {
    throw new Error('virtualizer props were not captured')
  }
  return latestVirtualizerProps
}

function triggerItemsRendered(args: OnItemsRenderedArgs) {
  const onItemsRendered = getVirtualizerProps().onItemsRendered as (args: OnItemsRenderedArgs) => void
  onItemsRendered(args)
}

describe('MessageList', () => {
  beforeEach(() => {
    latestVirtualizerProps = null
    scrollToIndexMock.mockReset()
    scrollToBottomMock.mockReset()
  })

  it('scrolls to the bottom on initial render when there is no focus, jump, or unread target', async () => {
    render(
      <MessageList
        rows={[
          { kind: 'date-divider', key: 'date:1', label: 'Today' },
        ]}
        mode="live-tail"
      />,
    )

    await waitFor(() => {
      expect(scrollToBottomMock).toHaveBeenCalledWith('auto')
    })
  })

  it('uses focus targets ahead of jump requests during initial positioning', async () => {
    render(
      <MessageList
        rows={[
          { kind: 'conversation-start', key: 'focus-row' },
          { kind: 'date-divider', key: 'jump-row', label: 'Today' },
        ]}
        mode="history-browse"
        focusTargetRowKey="focus-row"
        jumpTargetRowKey="jump-row"
        highlightRequest={{
          messageId: '55',
          requestKey: 'jump-1',
          behavior: 'direct-scroll',
        }}
      />,
    )

    await waitFor(() => {
      expect(scrollToIndexMock).toHaveBeenCalled()
    })

    expect(scrollToIndexMock.mock.calls[0]).toEqual([0, 'center', 0, 'auto'])
  })

  it('autoloads visible gap rows once and keeps the jump-to-present CTA working', async () => {
    const onLoadGap = vi.fn()
    const onJumpToPresent = vi.fn()
    const user = userEvent.setup()

    render(
      <MessageList
        rows={[
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
        ]}
        mode="history-browse"
        onLoadGap={onLoadGap}
        onJumpToPresent={onJumpToPresent}
      />,
    )

    act(() => {
      triggerItemsRendered({
        overscanStartIndex: 0,
        overscanStopIndex: 2,
        visibleStartIndex: 1,
        visibleStopIndex: 1,
      })
      triggerItemsRendered({
        overscanStartIndex: 0,
        overscanStopIndex: 2,
        visibleStartIndex: 1,
        visibleStopIndex: 1,
      })
    })

    expect(onLoadGap).toHaveBeenCalledTimes(2)
    expect(onLoadGap).toHaveBeenNthCalledWith(1, 'gap:older')
    expect(onLoadGap).toHaveBeenNthCalledWith(2, 'gap:newer')

    await user.click(screen.getByRole('button', { name: 'chat.jumpToPresent' }))
    expect(onJumpToPresent).toHaveBeenCalledTimes(1)
  })

  it('autoloads the same gap again after it returns from loading', () => {
    const onLoadGap = vi.fn()

    const { rerender } = render(
      <MessageList
        rows={[
          {
            kind: 'gap',
            key: 'gap:older-edge',
            direction: 'older',
            gapKind: 'older-edge',
            status: 'idle',
            heightPx: 120,
          },
          { kind: 'date-divider', key: 'date:1', label: 'Today' },
        ]}
        mode="history-browse"
        onLoadGap={onLoadGap}
      />,
    )

    act(() => {
      triggerItemsRendered({
        overscanStartIndex: 0,
        overscanStopIndex: 1,
        visibleStartIndex: 1,
        visibleStopIndex: 1,
      })
    })

    expect(onLoadGap).toHaveBeenCalledTimes(1)
    expect(onLoadGap).toHaveBeenLastCalledWith('gap:older-edge')

    rerender(
      <MessageList
        rows={[
          {
            kind: 'gap',
            key: 'gap:older-edge',
            direction: 'older',
            gapKind: 'older-edge',
            status: 'loading',
            heightPx: 120,
          },
          { kind: 'date-divider', key: 'date:1', label: 'Today' },
        ]}
        mode="history-browse"
        onLoadGap={onLoadGap}
      />,
    )

    rerender(
      <MessageList
        rows={[
          {
            kind: 'gap',
            key: 'gap:older-edge',
            direction: 'older',
            gapKind: 'older-edge',
            status: 'idle',
            heightPx: 120,
          },
          { kind: 'date-divider', key: 'date:1', label: 'Today' },
        ]}
        mode="history-browse"
        onLoadGap={onLoadGap}
      />,
    )

    act(() => {
      triggerItemsRendered({
        overscanStartIndex: 0,
        overscanStopIndex: 1,
        visibleStartIndex: 1,
        visibleStopIndex: 1,
      })
    })

    expect(onLoadGap).toHaveBeenCalledTimes(2)
    expect(onLoadGap).toHaveBeenLastCalledWith('gap:older-edge')
  })

  it('uses jump-to-present for the live-tail bottom button when newer messages are unloaded', async () => {
    const onJumpToPresent = vi.fn()
    const user = userEvent.setup()

    render(
      <MessageList
        rows={[
          { kind: 'date-divider', key: 'date:1', label: 'Today' },
          {
            kind: 'gap',
            key: 'gap:newer',
            direction: 'newer',
            gapKind: 'newer-edge',
            status: 'idle',
            heightPx: 120,
          },
        ]}
        mode="live-tail"
        onJumpToPresent={onJumpToPresent}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'chat.jumpToPresent' }))
    expect(onJumpToPresent).toHaveBeenCalledTimes(1)
  })
})
