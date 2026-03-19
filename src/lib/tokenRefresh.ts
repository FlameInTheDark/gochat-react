import axios from 'axios'
import { useAuthStore } from '@/stores/authStore'
import { getApiBaseUrl } from '@/lib/connectionConfig'

// Refresh the token this many ms before it actually expires.
const REFRESH_LEEWAY_MS = 30_000

// setTimeout's max safe delay value (~24.8 days). Tokens with longer lifetimes
// don't need a proactive refresh timer.
const MAX_TIMER_MS = 2_147_483_647

let refreshTimer: ReturnType<typeof setTimeout> | null = null

/** Decode the `exp` claim from a JWT. Returns the expiry as ms-since-epoch, or null. */
function decodeTokenExpiry(token: string): number | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    // Base64url → base64 → JSON
    const json = atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'))
    const claims = JSON.parse(json) as Record<string, unknown>
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null
  } catch {
    return null
  }
}

async function doRefresh() {
  refreshTimer = null
  const store = useAuthStore.getState()
  const refreshToken = store.refreshToken
  if (!refreshToken) {
    store.logout()
    return
  }
  try {
    const baseUrl = getApiBaseUrl()
    // Plain axios (not axiosInstance) to avoid re-triggering the 401 interceptor.
    const res = await axios.get<{ token?: string; refresh_token?: string }>(
      `${baseUrl}/auth/refresh`,
      { headers: { Authorization: `Bearer ${refreshToken}` } },
    )
    const newToken = res.data.token
    const newRefreshToken = res.data.refresh_token
    if (!newToken) throw new Error('Empty refresh response')
    // setToken triggers the authStore subscriber, which calls scheduleRefreshFor
    // with the new token — the next timer is scheduled automatically.
    store.setToken(newToken)
    if (newRefreshToken) store.setRefreshToken(newRefreshToken)
  } catch {
    store.logout()
  }
}

/**
 * Schedule a proactive refresh for the given token, 30 s before expiry.
 * Cancels any previously scheduled timer first.
 * Safe to call with null (just clears the timer).
 */
export function scheduleRefreshFor(token: string | null) {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  if (!token) return

  const exp = decodeTokenExpiry(token)
  if (!exp) return

  const delay = exp - Date.now() - REFRESH_LEEWAY_MS
  if (delay <= 0) {
    // Token is already expired or expiring in the next 30 s — refresh immediately.
    void doRefresh()
    return
  }
  if (delay > MAX_TIMER_MS) return  // lives longer than setTimeout can handle; skip

  refreshTimer = setTimeout(() => void doRefresh(), delay)
}

/**
 * Subscribe to authStore.token changes and keep the proactive refresh timer in sync.
 *
 * Call once at app startup (e.g. inside AppLayout).
 * Returns an unsubscribe function suitable for useEffect cleanup.
 */
export function setupTokenRefreshScheduler(): () => void {
  // Seed the timer for the token that was restored from localStorage on load.
  scheduleRefreshFor(useAuthStore.getState().token)

  return useAuthStore.subscribe((state, prev) => {
    if (state.token !== prev.token) {
      scheduleRefreshFor(state.token)
    }
  })
}
