import axios from 'axios'
import { useAuthStore } from '@/stores/authStore'
import { useAuthProblemStore, type AuthRefreshProblemKind } from '@/stores/authProblemStore'
import { getApiBaseUrl } from '@/lib/connectionConfig'

const RETRY_DELAYS_MS = [0, 1_000, 3_000] as const

export class AuthRefreshError extends Error {
  constructor(
    readonly kind: AuthRefreshProblemKind,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'AuthRefreshError'
  }
}

interface RefreshResponse {
  token?: string
  refresh_token?: string
}

interface RefreshOptions {
  openModalOnFailure?: boolean
}

let inFlightRefresh: Promise<string> | null = null

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function classifyRefreshError(error: unknown): AuthRefreshProblemKind {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status
    if (status === 401 || status === 403) {
      return 'invalid'
    }
  }
  return 'transient'
}

function messageFor(kind: AuthRefreshProblemKind, error?: unknown) {
  if (kind === 'invalid') {
    return 'Your saved session could not be refreshed.'
  }
  if (axios.isAxiosError(error)) {
    const status = error.response?.status
    if (status && status >= 500) {
      return 'The server could not refresh your session.'
    }
    if (!error.response) {
      return 'The app could not reach the server to refresh your session.'
    }
  }
  return 'The app could not refresh your session.'
}

async function requestRefresh() {
  const refreshToken = useAuthStore.getState().refreshToken
  if (!refreshToken) {
    throw new AuthRefreshError('invalid', 'No refresh token is available.')
  }

  const baseUrl = getApiBaseUrl()
  const res = await axios.get<RefreshResponse>(
    `${baseUrl}/auth/refresh`,
    { headers: { Authorization: `Bearer ${refreshToken}` } },
  )

  const newToken = res.data.token
  if (!newToken) {
    throw new AuthRefreshError('transient', 'Refresh response did not contain an access token.')
  }

  const store = useAuthStore.getState()
  store.setToken(newToken)
  if (res.data.refresh_token) {
    store.setRefreshToken(res.data.refresh_token)
  }
  return newToken
}

async function runRefreshWithRetries(options: RefreshOptions) {
  let lastError: unknown

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    const delay = RETRY_DELAYS_MS[attempt] ?? 0
    if (delay > 0) {
      await sleep(delay)
    }

    try {
      const token = await requestRefresh()
      useAuthProblemStore.getState().close()
      return token
    } catch (error) {
      lastError = error
      const kind = error instanceof AuthRefreshError
        ? error.kind
        : classifyRefreshError(error)
      if (kind === 'invalid') {
        break
      }
    }
  }

  const kind = lastError instanceof AuthRefreshError
    ? lastError.kind
    : classifyRefreshError(lastError)
  const message = lastError instanceof AuthRefreshError
    ? lastError.message
    : messageFor(kind, lastError)
  const refreshError = lastError instanceof AuthRefreshError
    ? lastError
    : new AuthRefreshError(kind, message, lastError)

  if (options.openModalOnFailure !== false) {
    useAuthProblemStore.getState().open(kind, message)
  }

  throw refreshError
}

export function isAuthRefreshError(error: unknown): error is AuthRefreshError {
  return error instanceof AuthRefreshError
}

export function isRefreshAuthFailure(error: unknown) {
  if (error instanceof AuthRefreshError) {
    return error.kind === 'invalid'
  }
  if (axios.isAxiosError(error)) {
    const status = error.response?.status
    return status === 401 || status === 403
  }
  return false
}

export function refreshAuthToken(options: RefreshOptions = {}) {
  if (!inFlightRefresh) {
    inFlightRefresh = runRefreshWithRetries(options).finally(() => {
      inFlightRefresh = null
    })
  }
  return inFlightRefresh
}
