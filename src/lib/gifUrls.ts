export type GifUrl = { provider: 'giphy' | 'gifer' | 'imgur' | 'content'; url: string }

// ── Renderable GIF providers ──────────────────────────────────────────────────

const GIPHY_RE = /https?:\/\/(?:www\.)?giphy\.com\/gifs\/[a-zA-Z0-9-]+/g

// gifer.com/en/HASH  and  i.gifer.com/HASH.gif
const GIFER_RE = /https?:\/\/(?:(?:www\.)?gifer\.com\/en\/[a-zA-Z0-9]+|i\.gifer\.com\/[a-zA-Z0-9]+\.gif)/g

// imgur.com/ID (≥4 chars to avoid path segments)  and  i.imgur.com/ID.gif[v]
const IMGUR_RE = /https?:\/\/(?:(?:www\.)?imgur\.com\/[a-zA-Z0-9]{4,}|i\.imgur\.com\/[a-zA-Z0-9]+\.gifv?)/g

// ── Tenor (discontinued — suppress backend embeds but don't render) ───────────

const TENOR_RE = /https?:\/\/(?:www\.)?tenor\.com\/(?:view\/[a-zA-Z0-9][a-zA-Z0-9-]*|[a-zA-Z0-9]+\.gif)/g

// ── Public API ────────────────────────────────────────────────────────────────

const BARE_URL_RE = /https?:\/\/[^\s<>"']+/g

/**
 * Normalize a content host entry to a plain hostname.
 * Handles both "hostname.example.com" and "https://hostname.example.com" formats.
 */
function normalizeHost(entry: string): string {
  try {
    // If it parses as a URL, use its hostname
    const u = new URL(entry.includes('://') ? entry : `https://${entry}`)
    return u.hostname
  } catch {
    return entry
  }
}

function isContentHost(hostname: string, contentHosts: string[]): boolean {
  return contentHosts.some((entry) => normalizeHost(entry) === hostname)
}

/** Returns true if the given URL's hostname is in the trusted content hosts list. */
export function isFromContentHost(url: string, contentHosts: string[]): boolean {
  if (contentHosts.length === 0) return false
  try {
    return isContentHost(new URL(url).hostname, contentHosts)
  } catch {
    return false
  }
}

/** Returns GIF URLs that should be rendered as embedded GIFs (excludes Tenor). */
export function extractGifUrls(content: string, contentHosts: string[] = []): GifUrl[] {
  const results: GifUrl[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null

  GIPHY_RE.lastIndex = 0
  while ((m = GIPHY_RE.exec(content)) !== null) {
    if (!seen.has(m[0])) { seen.add(m[0]); results.push({ provider: 'giphy', url: m[0] }) }
  }

  GIFER_RE.lastIndex = 0
  while ((m = GIFER_RE.exec(content)) !== null) {
    if (!seen.has(m[0])) { seen.add(m[0]); results.push({ provider: 'gifer', url: m[0] }) }
  }

  IMGUR_RE.lastIndex = 0
  while ((m = IMGUR_RE.exec(content)) !== null) {
    if (!seen.has(m[0])) { seen.add(m[0]); results.push({ provider: 'imgur', url: m[0] }) }
  }

  if (contentHosts.length > 0) {
    BARE_URL_RE.lastIndex = 0
    while ((m = BARE_URL_RE.exec(content)) !== null) {
      const raw = m[0]
      if (seen.has(raw)) continue
      try {
        const parsed = new URL(raw)
        if (isContentHost(parsed.hostname, contentHosts)) {
          seen.add(raw)
          results.push({ provider: 'content', url: raw })
        }
      } catch {
        // not a valid URL — skip
      }
    }
  }

  return results
}

/**
 * True when the message contains any GIF-service URL (including Tenor) or a
 * content-host GIF URL that would trigger backend embed generation — used to
 * decide whether to send the message with `flags: 4` (suppress embeds).
 */
export function needsEmbedSuppression(content: string, contentHosts: string[] = []): boolean {
  TENOR_RE.lastIndex = 0
  if (TENOR_RE.test(content)) return true
  GIPHY_RE.lastIndex = 0
  if (GIPHY_RE.test(content)) return true
  GIFER_RE.lastIndex = 0
  if (GIFER_RE.test(content)) return true
  IMGUR_RE.lastIndex = 0
  if (IMGUR_RE.test(content)) return true

  if (contentHosts.length > 0) {
    BARE_URL_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = BARE_URL_RE.exec(content)) !== null) {
      try {
        const parsed = new URL(m[0])
        if (isContentHost(parsed.hostname, contentHosts)) return true
      } catch {
        // skip
      }
    }
  }

  return false
}

/** True when the message is nothing but renderable GIF URL(s) and whitespace. */
export function isGifOnlyMessage(content: string, gifUrls: GifUrl[]): boolean {
  if (gifUrls.length === 0) return false
  return gifUrls.reduce((s, g) => s.replace(g.url, ''), content).trim().length === 0
}

/** giphy.com/gifs/name-ID → https://media.giphy.com/media/ID/giphy.gif */
export function giphyGifUrl(pageUrl: string): string | null {
  const match = pageUrl.match(/giphy\.com\/gifs\/(?:[a-zA-Z0-9]+-)*([a-zA-Z0-9]+)/)
  return match ? `https://media.giphy.com/media/${match[1]}/giphy.gif` : null
}

/** gifer.com/en/HASH or i.gifer.com/HASH.gif → https://i.gifer.com/HASH.mp4 */
export function giferVideoUrl(pageUrl: string): string | null {
  let match = pageUrl.match(/i\.gifer\.com\/([a-zA-Z0-9]+)/)
  if (match) return `https://i.gifer.com/${match[1]}.mp4`
  match = pageUrl.match(/gifer\.com\/en\/([a-zA-Z0-9]+)/)
  if (match) return `https://i.gifer.com/${match[1]}.mp4`
  return null
}

/** imgur.com/ID or i.imgur.com/ID.gif[v] → https://i.imgur.com/ID.gif */
export function imgurGifUrl(pageUrl: string): string | null {
  const match = pageUrl.match(/imgur\.com\/([a-zA-Z0-9]+)/)
  return match ? `https://i.imgur.com/${match[1]}.gif` : null
}
