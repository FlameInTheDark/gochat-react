import { useRef, useEffect, useState } from 'react'
import { X, ImageOff } from 'lucide-react'
import { useGifStore } from '@/stores/gifStore'
import { extractGifUrls, giphyGifUrl, giferVideoUrl, imgurGifUrl } from '@/lib/gifUrls'
import type { GifUrl } from '@/lib/gifUrls'

function parseGifUrl(url: string): GifUrl | null {
  return extractGifUrls(url)[0] ?? null
}

function getMediaUrl(gifUrl: GifUrl): string | null {
  if (gifUrl.provider === 'giphy') return giphyGifUrl(gifUrl.url)
  if (gifUrl.provider === 'gifer') return giferVideoUrl(gifUrl.url)
  if (gifUrl.provider === 'imgur') return imgurGifUrl(gifUrl.url)
  return null
}

interface GifThumbnailProps {
  url: string
  gifUrl: GifUrl
  mediaUrl: string
  onSelect: (url: string) => void
  onRemove: (url: string) => void
}

function GifThumbnail({ url, gifUrl, mediaUrl, onSelect, onRemove }: GifThumbnailProps) {
  const [visible, setVisible] = useState(false)
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

  return (
    <div
      ref={ref}
      className="relative group rounded overflow-hidden cursor-pointer hover:ring-2 hover:ring-primary transition-shadow bg-muted"
      onClick={() => onSelect(url)}
    >
      {visible && (
        gifUrl.provider === 'gifer' ? (
          <video
            src={mediaUrl}
            autoPlay
            muted
            loop
            playsInline
            className="w-full h-auto block"
          />
        ) : (
          <img src={mediaUrl} alt="" className="w-full h-auto block" />
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
}

export default function GifPicker({ onSelect }: GifPickerProps) {
  const favoriteGifs = useGifStore((s) => s.favoriteGifs)
  const removeFavorite = useGifStore((s) => s.removeFavorite)

  const parsedGifs = favoriteGifs
    .map((url) => {
      const gifUrl = parseGifUrl(url)
      if (!gifUrl) return null
      const mediaUrl = getMediaUrl(gifUrl)
      if (!mediaUrl) return null
      return { url, gifUrl, mediaUrl }
    })
    .filter(Boolean) as { url: string; gifUrl: GifUrl; mediaUrl: string }[]

  return (
    <div className="w-[320px] rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
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
          <div className="grid grid-cols-2 gap-2 items-start">
            {parsedGifs.map(({ url, gifUrl, mediaUrl }) => (
              <GifThumbnail
                key={url}
                url={url}
                gifUrl={gifUrl}
                mediaUrl={mediaUrl}
                onSelect={onSelect}
                onRemove={removeFavorite}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
