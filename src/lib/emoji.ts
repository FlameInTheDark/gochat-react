/**
 * Build the public emoji asset URL.
 *
 * The /emoji/{id}.webp route is served from the backend root (not under /api/v1)
 * and requires no authentication.
 *
 * Size variants: 44 or 96 — anything else redirects to the closest variant.
 */

const _apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1'
// Strip the /api/v1 suffix to get the backend root URL.
// Works for both relative (/api/v1 → '') and absolute (http://host/api/v1 → http://host).
const _backendRoot = _apiBase.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '')

export function emojiUrl(emojiId: string, size?: 44 | 96): string {
  return `${_backendRoot}/emoji/${emojiId}.webp${size ? `?size=${size}` : ''}`
}
