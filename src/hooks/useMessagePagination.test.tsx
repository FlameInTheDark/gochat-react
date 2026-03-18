import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMessagePagination } from './useMessagePagination'
import { useMessageStore, type PendingMessage } from '@/stores/messageStore'
import { useReadStateStore } from '@/stores/readStateStore'
import type { DtoMessage } from '@/types'

const messageChannelChannelIdGetMock = vi.fn()
const messageChannelChannelIdMessageIdAckPostMock = vi.fn()

vi.mock('@/api/client', () => ({
  messageApi: {
    messageChannelChannelIdGet: (...args: unknown[]) => messageChannelChannelIdGetMock(...args),
    messageChannelChannelIdMessageIdAckPost: (...args: unknown[]) => messageChannelChannelIdMessageIdAckPostMock(...args),
  },
}))

function HookProbe({ channelId }: { channelId: string }) {
  const { rows, isLoadingInitial, mode, loadOlder } = useMessagePagination(channelId)

  return (
    <div>
      <div data-testid="loading">{String(isLoadingInitial)}</div>
      <div data-testid="mode">{mode}</div>
      <button type="button" onClick={loadOlder}>
        load older
      </button>
      <div data-testid="rows">
        {rows.map((row) => (
          row.kind === 'message'
            ? `${row.kind}:${row.key}:${row.message.content ?? ''}`
            : `${row.kind}:${row.key}`
        )).join('|')}
      </div>
    </div>
  )
}

function buildPendingMessage(overrides?: Partial<PendingMessage>): PendingMessage {
  return {
    localId: 'local-1',
    channelId: 'channel-1',
    uploadChannelId: 'channel-1',
    nonce: 'nonce-1',
    status: 'sending',
    createdAt: Date.now(),
    content: 'Hello',
    attachmentIds: [],
    attachments: [],
    attachmentDrafts: [],
    suppressEmbeds: false,
    message: {
      channel_id: 'channel-1' as unknown as number,
      content: 'Hello',
      nonce: 'nonce-1',
      type: 0,
    } as DtoMessage,
    ...overrides,
  }
}

function buildConfirmedMessage(): DtoMessage {
  return {
    id: '739999999999999999',
    channel_id: 'channel-1' as unknown as number,
    content: 'Hello',
    nonce: 'nonce-1',
    type: 0,
  } as DtoMessage
}

function buildMessage(params: {
  id: string
  content: string
  position: number
  nonce?: string
}): DtoMessage {
  return {
    id: params.id,
    channel_id: 'channel-1' as unknown as number,
    content: params.content,
    nonce: params.nonce,
    position: params.position,
    type: 0,
  } as DtoMessage
}

describe('useMessagePagination', () => {
  beforeEach(() => {
    messageChannelChannelIdGetMock.mockReset()
    messageChannelChannelIdMessageIdAckPostMock.mockReset()
    messageChannelChannelIdGetMock.mockResolvedValue({ data: [] })

    useMessageStore.setState({
      messages: {},
      pendingMessages: {},
      messageRowKeys: {},
    })
    useReadStateStore.setState({
      readStates: {},
      lastMessages: {},
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders a conversation-start row for an empty chat', async () => {
    render(<HookProbe channelId="channel-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false')
    })

    expect(screen.getByTestId('rows')).toHaveTextContent('conversation-start:conversation-start')
  })

  it('keeps the first confirmed message visible after pending cleanup in an empty chat', async () => {
    render(<HookProbe channelId="channel-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false')
    })

    act(() => {
      useMessageStore.getState().addPendingMessage(buildPendingMessage())
    })

    await waitFor(() => {
      expect(screen.getByTestId('rows').textContent).toContain('message:pending:local-1:Hello')
    })

    act(() => {
      useMessageStore.getState().receiveMessage('channel-1', buildConfirmedMessage())
    })

    await waitFor(() => {
      expect(screen.getByTestId('rows').textContent).toContain('message:pending:local-1:Hello')
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450))
    })

    await waitFor(() => {
      expect(screen.getByTestId('rows').textContent).toContain('message:pending:local-1:Hello')
    })
  })

  it('surfaces a newer gap when messages arrive while browsing older history', async () => {
    const currentMessage = buildMessage({
      id: '200',
      content: 'Current',
      position: 2,
    })
    const olderMessage = buildMessage({
      id: '100',
      content: 'Older',
      position: 1,
    })
    const newestMessage = buildMessage({
      id: '300',
      content: 'Newest',
      position: 3,
    })

    messageChannelChannelIdGetMock.mockImplementation((request: {
      direction?: string
      from?: number | string
    }) => {
      if (request.direction === 'before') {
        return Promise.resolve({ data: [olderMessage] })
      }

      return Promise.resolve({ data: [currentMessage] })
    })

    render(<HookProbe channelId="channel-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false')
    })

    expect(screen.getByTestId('rows').textContent).toContain('gap:gap:older-edge')

    act(() => {
      screen.getByRole('button', { name: 'load older' }).click()
    })

    await waitFor(() => {
      expect(screen.getByTestId('mode')).toHaveTextContent('history-browse')
      expect(screen.getByTestId('rows').textContent).toContain('message:message:100:Older')
      expect(screen.getByTestId('rows').textContent).not.toContain('gap:gap:newer-edge')
    })

    act(() => {
      useMessageStore.getState().receiveMessage('channel-1', newestMessage)
      useReadStateStore.getState().updateLastMessage('channel-1', String(newestMessage.id))
    })

    await waitFor(() => {
      expect(screen.getByTestId('rows').textContent).toContain('gap:gap:newer-edge')
    })
  })
})
