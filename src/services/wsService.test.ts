import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.OPEN
  send = vi.fn()
  close = vi.fn()
  private listeners: Record<string, Array<(event: unknown) => void>> = {}

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners[type] = [...(this.listeners[type] ?? []), listener]
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((candidate) => candidate !== listener)
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners[type] ?? []) {
      listener(event)
    }
  }
}

async function connectService() {
  vi.resetModules()
  vi.stubGlobal('WebSocket', MockWebSocket)
  vi.stubGlobal('Worker', undefined)
  MockWebSocket.instances = []

  const service = await import('./wsService')
  service.connect('token')
  const socket = MockWebSocket.instances[0]
  socket.emit('open')
  socket.emit('message', {
    data: JSON.stringify({
      op: 1,
      d: {
        heartbeat_interval: 30_000,
        session_id: 'session-1',
        connection_id: 'connection-1',
        generation: 1,
      },
    }),
  })
  socket.send.mockClear()
  return { service, socket }
}

function sentPayload(socket: MockWebSocket) {
  const raw = socket.send.mock.calls.at(-1)?.[0]
  expect(typeof raw).toBe('string')
  return JSON.parse(raw as string) as { op: number; d: Record<string, unknown> }
}

describe('wsService presence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(async () => {
    const service = await import('./wsService')
    service.disconnect()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('sends manual status updates as global overrides', async () => {
    const { service, socket } = await connectService()

    service.sendPresenceStatus('idle', 'lunch', { manual: true })

    expect(sentPayload(socket)).toEqual({
      op: 3,
      d: {
        status: 'idle',
        platform: 'web',
        manual: true,
        custom_status_text: 'lunch',
        self_video: false,
      },
    })
  })

  it('sends automatic idle as a session-only update', async () => {
    const { service, socket } = await connectService()

    service.sendPresenceStatus('idle')

    expect(sentPayload(socket)).toEqual({
      op: 3,
      d: {
        status: 'idle',
        platform: 'web',
        self_video: false,
      },
    })
  })

  it('uses the current session status for voice state updates', async () => {
    const { service, socket } = await connectService()
    service.sendPresenceStatus('idle')
    socket.send.mockClear()

    service.sendPresenceVoiceState({
      channelId: '123',
      mute: true,
      deafen: false,
      selfVideo: true,
    })

    expect(sentPayload(socket)).toEqual({
      op: 3,
      d: {
        status: 'idle',
        platform: 'web',
        voice_channel_id: 123,
        mute: true,
        deafen: false,
        self_video: true,
      },
    })
  })
})
