import { getBackendRoot } from './connectionConfig'

const PASSTHROUGH_PROTOCOLS = /^(blob:|data:|file:)/i
const HTTP_PROTOCOLS = /^https?:\/\//i

export function resolveAssetUrl(rawUrl?: string | null): string | undefined {
  const value = rawUrl?.trim()
  if (!value) return undefined
  if (PASSTHROUGH_PROTOCOLS.test(value)) return value
  if (HTTP_PROTOCOLS.test(value)) return value

  if (value.startsWith('//')) {
    const protocol = typeof window === 'undefined' ? 'https:' : window.location.protocol
    return `${protocol}${value}`
  }

  try {
    return new URL(value.startsWith('/') ? value : `/${value}`, `${getBackendRoot()}/`).toString()
  } catch {
    return value
  }
}

export function imageRetryUrl(rawUrl: string | undefined, attempt: number): string | undefined {
  if (!rawUrl || attempt <= 0 || PASSTHROUGH_PROTOCOLS.test(rawUrl)) return rawUrl

  try {
    const assetUrl = new URL(rawUrl)
    const backendUrl = new URL(getBackendRoot())
    if (assetUrl.origin !== backendUrl.origin) return rawUrl

    assetUrl.searchParams.set('_img_retry', `${attempt}`)
    return assetUrl.toString()
  } catch {
    return rawUrl
  }
}
