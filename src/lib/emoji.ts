/**
 * Build the public emoji asset URL.
 *
 * The /emoji/{id}.webp route is served from the backend root (not under /api/v1)
 * and requires no authentication.
 *
 * Size variants: 44 or 96 — anything else redirects to the closest variant.
 */

import { getBackendRoot } from '@/lib/connectionConfig'

export function emojiUrl(emojiId: string, size?: 44 | 96): string {
  return `${getBackendRoot()}/emoji/${emojiId}.webp${size ? `?size=${size}` : ''}`
}
