import axios from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshAuthToken } from '@/lib/authRefresh'
import { useAuthStore } from '@/stores/authStore'
import { useAuthProblemStore } from '@/stores/authProblemStore'

vi.mock('axios', () => {
  const axiosMock = {
    get: vi.fn(),
    isAxiosError: vi.fn((error: unknown) => Boolean((error as { isAxiosError?: boolean }).isAxiosError)),
  }

  return { default: axiosMock }
})

const axiosMock = vi.mocked(axios, true)

function axiosError(status?: number) {
  return {
    isAxiosError: true,
    response: status ? { status } : undefined,
  }
}

async function runRefreshTimers() {
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(1_000)
  await vi.advanceTimersByTimeAsync(3_000)
}

describe('auth refresh retry flow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    axiosMock.get.mockReset()
    useAuthStore.getState().logout()
    useAuthProblemStore.setState({
      isOpen: false,
      isRetrying: false,
      kind: null,
      message: null,
    })
    useAuthStore.getState().setToken('old-access')
    useAuthStore.getState().setRefreshToken('old-refresh')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries transient failures and stores rotated tokens on success', async () => {
    axiosMock.get
      .mockRejectedValueOnce(axiosError(503))
      .mockRejectedValueOnce(axiosError())
      .mockResolvedValueOnce({ data: { token: 'new-access', refresh_token: 'new-refresh' } })

    const refresh = refreshAuthToken()
    await runRefreshTimers()

    await expect(refresh).resolves.toBe('new-access')
    expect(axiosMock.get).toHaveBeenCalledTimes(3)
    expect(useAuthStore.getState().token).toBe('new-access')
    expect(useAuthStore.getState().refreshToken).toBe('new-refresh')
    expect(useAuthProblemStore.getState().isOpen).toBe(false)
  })

  it('opens the modal after transient retries fail without clearing tokens', async () => {
    axiosMock.get.mockRejectedValue(axiosError(500))

    const refresh = refreshAuthToken()
    const assertion = expect(refresh).rejects.toMatchObject({ kind: 'transient' })
    await runRefreshTimers()

    await assertion
    expect(axiosMock.get).toHaveBeenCalledTimes(3)
    expect(useAuthStore.getState().token).toBe('old-access')
    expect(useAuthStore.getState().refreshToken).toBe('old-refresh')
    expect(useAuthProblemStore.getState()).toMatchObject({
      isOpen: true,
      kind: 'transient',
    })
  })

  it('opens the modal on confirmed auth failure without clearing tokens', async () => {
    axiosMock.get.mockRejectedValueOnce(axiosError(401))

    const refresh = refreshAuthToken()
    const assertion = expect(refresh).rejects.toMatchObject({ kind: 'invalid' })
    await runRefreshTimers()

    await assertion
    expect(axiosMock.get).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().token).toBe('old-access')
    expect(useAuthStore.getState().refreshToken).toBe('old-refresh')
    expect(useAuthProblemStore.getState()).toMatchObject({
      isOpen: true,
      kind: 'invalid',
    })
  })

  it('shares one retry sequence across concurrent refresh callers', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { token: 'new-access', refresh_token: 'new-refresh' } })

    const first = refreshAuthToken()
    const second = refreshAuthToken()
    await runRefreshTimers()

    await expect(first).resolves.toBe('new-access')
    await expect(second).resolves.toBe('new-access')
    expect(axiosMock.get).toHaveBeenCalledTimes(1)
  })

  it('closes an existing auth problem after a manual retry succeeds', async () => {
    useAuthProblemStore.getState().open('transient')
    axiosMock.get.mockResolvedValueOnce({ data: { token: 'retry-access', refresh_token: 'retry-refresh' } })

    const refresh = refreshAuthToken()
    await runRefreshTimers()

    await expect(refresh).resolves.toBe('retry-access')
    expect(useAuthProblemStore.getState().isOpen).toBe(false)
    expect(useAuthStore.getState().token).toBe('retry-access')
    expect(useAuthStore.getState().refreshToken).toBe('retry-refresh')
  })
})
