/**
 * Connection configuration — API base URL and WebSocket URL.
 *
 * Web:      reads from Vite env vars at startup; cannot be changed at runtime.
 * Electron: connectionStore calls setConnectionConfig() after loading persisted
 *           settings, allowing users to point the app at any server.
 *
 * Both api/client.ts and wsService.ts import from here so neither file needs
 * to be patched between the web and Electron builds.
 */

const DEFAULT_API_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1'
const DEFAULT_WS_URL =
  (import.meta.env.VITE_WEBSOCKET_URL as string | undefined) ?? '/ws/subscribe'

let _apiBaseUrl = DEFAULT_API_URL
let _wsUrl = DEFAULT_WS_URL

/** Override at runtime (called by Electron's connectionStore after hydration). */
export function setConnectionConfig(config: { apiBaseUrl?: string; wsUrl?: string }) {
  if (config.apiBaseUrl) _apiBaseUrl = config.apiBaseUrl
  if (config.wsUrl) _wsUrl = config.wsUrl
}

/** Current API base URL. */
export function getApiBaseUrl(): string {
  return _apiBaseUrl
}

/**
 * Current WebSocket URL, with relative paths resolved against the current host
 * so the Vite dev proxy can handle them.
 */
export function getWsUrl(): string {
  const raw = _wsUrl
  if (raw.startsWith('ws://') || raw.startsWith('wss://')) return raw
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${raw}`
}
