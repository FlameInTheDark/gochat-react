import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIdlePresence } from './useIdlePresence'
import { usePresenceStore } from '@/stores/presenceStore'

const sendPresenceStatusMock = vi.fn()

vi.mock('@/services/wsService', () => ({
  sendPresenceStatus: (...args: unknown[]) => sendPresenceStatusMock(...args),
}))

const IDLE_TIMEOUT_MS = 10 * 60 * 1_000

function Probe() {
  useIdlePresence()
  return null
}

describe('useIdlePresence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendPresenceStatusMock.mockReset()
    usePresenceStore.setState({
      ownStatus: 'online',
      manualStatus: null,
      sessionStatus: 'online',
      customStatusText: '',
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('auto-idles automatic online sessions and restores them on activity', () => {
    render(<Probe />)

    act(() => {
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS)
    })

    expect(usePresenceStore.getState().sessionStatus).toBe('idle')
    expect(usePresenceStore.getState().ownStatus).toBe('idle')
    expect(sendPresenceStatusMock).toHaveBeenLastCalledWith('idle')

    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove'))
    })

    expect(usePresenceStore.getState().sessionStatus).toBe('online')
    expect(usePresenceStore.getState().ownStatus).toBe('online')
    expect(sendPresenceStatusMock).toHaveBeenLastCalledWith('online')
  })

  it('does not change sticky manual idle on activity', () => {
    usePresenceStore.setState({
      ownStatus: 'idle',
      manualStatus: 'idle',
      sessionStatus: 'online',
    })
    render(<Probe />)

    act(() => {
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS)
      window.dispatchEvent(new KeyboardEvent('keydown'))
    })

    expect(usePresenceStore.getState().manualStatus).toBe('idle')
    expect(usePresenceStore.getState().ownStatus).toBe('idle')
    expect(sendPresenceStatusMock).not.toHaveBeenCalled()
  })

  it('only treats visibility return as activity', () => {
    render(<Probe />)

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS)
    })

    expect(usePresenceStore.getState().sessionStatus).toBe('idle')
    sendPresenceStatusMock.mockClear()

    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(usePresenceStore.getState().sessionStatus).toBe('online')
    expect(sendPresenceStatusMock).toHaveBeenLastCalledWith('online')
  })
})
