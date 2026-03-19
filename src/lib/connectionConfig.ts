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

function isAbsoluteHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

function isAbsoluteWsUrl(url: string): boolean {
  return url.startsWith('ws://') || url.startsWith('wss://')
}

function normalizeRelativePath(raw: string): string {
  return raw.startsWith('/') ? raw : `/${raw}`
}

function normalizeBasePath(raw: string | undefined): string {
  if (!raw || raw === '/') return ''
  const trimmed = raw.replace(/\/+$/, '')
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function runningFromFileProtocol(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'file:'
}

export const DEFAULT_API_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  (runningFromFileProtocol() ? 'http://localhost/api/v1' : '/api/v1')
export const DEFAULT_WS_URL =
  (import.meta.env.VITE_WEBSOCKET_URL as string | undefined) ??
  (runningFromFileProtocol() ? 'ws://localhost/ws/subscribe' : '/ws/subscribe')

let _apiBaseUrl = DEFAULT_API_URL
let _wsUrl = DEFAULT_WS_URL

/** Override at runtime (called by Electron's connectionStore after hydration). */
export function setConnectionConfig(config: { apiBaseUrl?: string; wsUrl?: string }) {
  if (config.apiBaseUrl) _apiBaseUrl = config.apiBaseUrl
  if (config.wsUrl) _wsUrl = config.wsUrl
}

/** Current API base URL. */
export function getApiBaseUrl(): string {
  const raw = _apiBaseUrl.trim()
  if (isAbsoluteHttpUrl(raw)) return raw.replace(/\/$/, '')

  const path = normalizeRelativePath(raw)
  if (typeof window === 'undefined') return path
  if (window.location.protocol === 'file:') return `http://localhost${path}`
  return `${window.location.origin}${path}`
}

/**
 * Current WebSocket URL, with relative paths resolved against the current host
 * so the Vite dev proxy can handle them.
 */
export function getWsUrl(): string {
  const raw = _wsUrl.trim()
  if (isAbsoluteWsUrl(raw)) return raw

  const path = normalizeRelativePath(raw)
  if (typeof window === 'undefined') return path
  if (window.location.protocol === 'file:') return `ws://localhost${path}`

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${path}`
}

export function getBackendRoot(): string {
  return getApiBaseUrl().replace(/\/api\/v1\/?$/, '').replace(/\/$/, '')
}

export function getInviteUrl(code: string): string {
  if (typeof window === 'undefined') return `/invite/${code}`
  if (window.location.protocol === 'file:') return `${getBackendRoot()}/invite/${code}`

  const invitePath = `${normalizeBasePath(import.meta.env.VITE_BASE_PATH as string | undefined)}/invite/${code}`
  if (window.location.hash.startsWith('#/')) return `${window.location.origin}/#${invitePath}`
  return `${window.location.origin}${invitePath}`
}
