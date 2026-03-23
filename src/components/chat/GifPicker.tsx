import { useRef, useEffect, useState } from 'react'
import { X, ImageOff } from 'lucide-react'
import { useGifStore } from '@/stores/gifStore'
import { extractGifUrls, giphyGifUrl, giferVideoUrl, imgurGifUrl, isFromContentHost } from '@/lib/gifUrls'
import type { GifUrl } from '@/lib/gifUrls'

function parseGifUrl(url: string, contentHosts: string[]): GifUrl | null {
  // Check known GIF providers (giphy, gifer, imgur, content host)
  const known = extractGifUrls(url, contentHosts)[0]
  if (known) return known

  // The star button is only shown on confirmed GIF attachments. If the URL is
  // from a trusted content host (matched against normalized hostnames), render
  // it directly. Non-trusted URLs show as placeholder so the user can remove them.
  if (isFromContentHost(url, contentHosts)) {
    return { provider: 'content', url }
  }

  return null
}

function getMediaUrl(gifUrl: GifUrl): string | null {
  if (gifUrl.provider === 'giphy') return giphyGifUrl(gifUrl.url)
  if (gifUrl.provider === 'gifer') return giferVideoUrl(gifUrl.url)
  if (gifUrl.provider === 'imgur') return imgurGifUrl(gifUrl.url)
  if (gifUrl.provider === 'content') return gifUrl.url
  return null
}

interface GifThumbnailProps {
  url: string
  mediaUrl: string | null
  isVideo: boolean
  onSelect: (url: string) => void
  onRemove: (url: string) => void
}

function GifPlaceholder({ onRemove, url }: { url: string; onRemove: (url: string) => void }) {
  return (
    <div className="relative group rounded overflow-hidden bg-muted flex items-center justify-center aspect-square">
      <ImageOff className="h-6 w-6 text-muted-foreground" />
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(url) }}
        className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 h-5 w-5 flex items-center justify-center rounded-full bg-black/70 text-white transition-opacity hover:bg-black/90"
        aria-label="Remove from favorites"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

function GifThumbnail({ url, mediaUrl, isVideo, onSelect, onRemove }: GifThumbnailProps) {
  const [visible, setVisible] = useState(false)
  const [failed, setFailed] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '50px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  if (!mediaUrl || failed) {
    return <GifPlaceholder url={url} onRemove={onRemove} />
  }

  return (
    <div
      ref={ref}
      className="relative group rounded overflow-hidden cursor-pointer hover:ring-2 hover:ring-primary transition-shadow bg-muted"
      onClick={() => onSelect(url)}
    >
      {visible && (
        isVideo ? (
          <video
            src={mediaUrl}
            autoPlay
            muted
            loop
            playsInline
            className="w-full h-auto block"
            onError={() => setFailed(true)}
          />
        ) : (
          <img
            src={mediaUrl}
            alt=""
            className="w-full h-auto block"
            onError={() => setFailed(true)}
          />
        )
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(url) }}
        className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 h-5 w-5 flex items-center justify-center rounded-full bg-black/70 text-white transition-opacity hover:bg-black/90"
        aria-label="Remove from favorites"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

interface GifPickerProps {
  onSelect: (url: string) => void
  isMobile?: boolean
}

export default function GifPicker({ onSelect, isMobile }: GifPickerProps) {
  const favoriteGifs = useGifStore((s) => s.favoriteGifs)
  const removeFavorite = useGifStore((s) => s.removeFavorite)
  const contentHosts = useGifStore((s) => s.contentHosts)

  const parsedGifs = favoriteGifs.map((url) => {
    const gifUrl = parseGifUrl(url, contentHosts)
    const mediaUrl = gifUrl ? getMediaUrl(gifUrl) : null
    const isVideo = gifUrl?.provider === 'gifer'
    return { url, mediaUrl, isVideo }
  })

  return (
    <div className={isMobile ? 'w-full rounded-xl border border-border bg-popover text-popover-foreground shadow-xl' : 'w-[320px] rounded-xl border border-border bg-popover text-popover-foreground shadow-xl'}>
      <div className="border-b border-border px-3 py-2">
        <span className="text-sm font-semibold text-foreground">Favorite GIFs</span>
      </div>
      <div className="p-2 overflow-y-auto" style={{ height: 300 }}>
        {parsedGifs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <ImageOff className="h-8 w-8" />
            <p className="text-sm">No favorite GIFs yet.</p>
            <p className="text-xs text-center px-4">
              Hover over a GIF in chat and click the star to save it here.
            </p>
          </div>
        ) : (
          <div className="columns-2 gap-2">
            {parsedGifs.map(({ url, mediaUrl, isVideo }) => (
              <div key={url} className="break-inside-avoid mb-2">
                <GifThumbnail
                  url={url}
                  mediaUrl={mediaUrl}
                  isVideo={isVideo}
                  onSelect={onSelect}
                  onRemove={removeFavorite}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
