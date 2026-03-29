const DEVICE_KEY_STORAGE = 'gochat_device_key'

/**
 * Render text/shapes on an offscreen canvas and return the data URL.
 * GPU + driver + OS anti-aliasing differences produce unique pixel output
 * per device, even for identical inputs. Works in incognito.
 * Returns '' if canvas is blocked by a privacy extension.
 */
function canvasFingerprint(): string {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 240
    canvas.height = 60
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    ctx.fillStyle = '#f3a'
    ctx.fillRect(0, 0, 240, 60)
    ctx.fillStyle = '#069'
    ctx.font = '14px Arial, sans-serif'
    ctx.fillText('GoChat device fingerprint 🔑', 2, 22)
    ctx.fillStyle = 'rgba(80,200,30,0.8)'
    ctx.font = '11px "Times New Roman", serif'
    ctx.fillText('stable-key-2025 \u00e9\u00e0\u00fc', 4, 44)
    ctx.strokeStyle = '#c0f'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(220, 30, 18, 0, Math.PI * 2)
    ctx.stroke()
    return canvas.toDataURL()
  } catch {
    return ''
  }
}

/**
 * Collect stable, non-permission-gated browser properties.
 * Avoids enumerateDevices() labels (permission-dependent, unstable).
 * Produces the same string in normal and incognito sessions on the same device+browser.
 */
function buildFingerprint(): string {
  const parts = [
    navigator.userAgent,
    navigator.languages.join(','),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    String((navigator as any).platform ?? ''),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    String((navigator as any).vendor ?? ''),
    String(navigator.hardwareConcurrency ?? ''),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    String((navigator as any).deviceMemory ?? ''),
    String(navigator.maxTouchPoints ?? ''),
    String(window.devicePixelRatio ?? ''),
    String(screen.width),
    String(screen.height),
    String(screen.colorDepth),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    canvasFingerprint(),
  ]
  return parts.join('|')
}

async function sha256hex(str: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Resolved once at module load; subsequent calls are instant.
 * localStorage is used as a cache — if cleared (e.g. incognito close),
 * the fingerprint is re-hashed to the same value on the same device/browser.
 */
const _keyPromise: Promise<string> = (async () => {
  const stored = window.localStorage.getItem(DEVICE_KEY_STORAGE)
  if (stored) return stored

  const key = await sha256hex(buildFingerprint())

  try {
    window.localStorage.setItem(DEVICE_KEY_STORAGE, key)
  } catch {
    // Storage unavailable (incognito quota) — key is recomputed next time, same result
  }

  return key
})()

/** Stable installation key — same value in normal and incognito on the same device+browser. */
export function getDeviceKey(): Promise<string> {
  return _keyPromise
}
