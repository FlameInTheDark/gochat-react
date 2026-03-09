import { useState, useRef, useEffect } from 'react'
import { Star } from 'lucide-react'
import AnimatedImage from '@/components/ui/AnimatedImage'
import { focusListeners, isAppPaused } from '@/lib/animationPause'
import type { GifUrl } from '@/lib/gifUrls'
import { giphyGifUrl, giferVideoUrl, imgurGifUrl } from '@/lib/gifUrls'
import { useGifStore } from '@/stores/gifStore'
import { cn } from '@/lib/utils'

const MAX_WIDTH = 400
const MAX_HEIGHT = 300

function UrlFallback({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sm text-primary underline break-all"
    >
      {url}
    </a>
  )
}

function StarButton({ url }: { url: string }) {
  const isFavorite = useGifStore((s) => s.favoriteGifs.includes(url))
  const addFavorite = useGifStore((s) => s.addFavorite)
  const removeFavorite = useGifStore((s) => s.removeFavorite)

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        if (isFavorite) removeFavorite(url)
        else addFavorite(url)
      }}
      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 h-7 w-7 flex items-center justify-center rounded-full bg-black/60 text-white transition-opacity hover:bg-black/80"
      aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
    >
      <Star className={cn('h-4 w-4', isFavorite && 'fill-yellow-400 text-yellow-400')} />
    </button>
  )
}

function GifImage({ src, fallbackUrl, originalUrl }: { src: string; fallbackUrl: string; originalUrl: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <UrlFallback url={fallbackUrl} />
  return (
    <div className="mt-1 relative group w-fit">
      <AnimatedImage
        src={src}
        crossOrigin="anonymous"
        className="rounded max-w-full object-contain"
        style={{ maxWidth: MAX_WIDTH, maxHeight: MAX_HEIGHT }}
        draggable={false}
        onError={() => setFailed(true)}
      />
      <StarButton url={originalUrl} />
    </div>
  )
}

function GiferVideo({ src, fallbackUrl, originalUrl }: { src: string; fallbackUrl: string; originalUrl: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const inViewRef = useRef(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const video = ref.current
    if (!video) return

    function apply() {
      if (!video) return
      if (isAppPaused() || !inViewRef.current) {
        video.pause()
      } else {
        void video.play().catch(() => {})
      }
    }

    focusListeners.add(apply)

    const observer = new IntersectionObserver(
      ([entry]) => {
        inViewRef.current = entry.isIntersecting
        apply()
      },
      { rootMargin: '100px 0px', threshold: 0 },
    )

    observer.observe(video)

    return () => {
      observer.disconnect()
      focusListeners.delete(apply)
    }
  }, [src])

  if (failed) return <UrlFallback url={fallbackUrl} />

  return (
    <div className="mt-1 relative group w-fit">
      <video
        ref={ref}
        loop
        muted
        playsInline
        className="rounded max-w-full object-contain"
        style={{ maxWidth: MAX_WIDTH, maxHeight: MAX_HEIGHT }}
        onError={() => setFailed(true)}
      >
        <source src={src} type="video/mp4" />
      </video>
      <StarButton url={originalUrl} />
    </div>
  )
}

/**
 * Content-host GIF: uses AnimatedImage for viewport/focus pause behaviour but
 * omits crossOrigin="anonymous" so CORS doesn't block display. The canvas
 * frame-capture will silently fail (taint) and fall back to BLANK as the
 * paused placeholder — that's acceptable.
 * On load failure:
 * - hideOnFail=true → unmount silently (text URL is still visible in the message)
 * - hideOnFail=false → show UrlFallback (message is only this URL, nothing else to show)
 */
function ContentGifImage({ src, originalUrl, hideOnFail }: { src: string; originalUrl: string; hideOnFail: boolean }) {
  const [failed, setFailed] = useState(false)
  if (failed) return hideOnFail ? null : <UrlFallback url={src} />
  return (
    <div className="mt-1 relative group w-fit">
      <AnimatedImage
        src={src}
        captureCrossOrigin="anonymous"
        pauseFallback={src}
        className="rounded max-w-full object-contain"
        style={{ maxWidth: MAX_WIDTH, maxHeight: MAX_HEIGHT }}
        draggable={false}
        onError={() => setFailed(true)}
      />
      <StarButton url={originalUrl} />
    </div>
  )
}

export default function GifEmbed({ gifUrl, gifOnly = false }: { gifUrl: GifUrl; gifOnly?: boolean }) {
  if (gifUrl.provider === 'giphy') {
    const src = giphyGifUrl(gifUrl.url)
    if (!src) return <UrlFallback url={gifUrl.url} />
    return <GifImage src={src} fallbackUrl={gifUrl.url} originalUrl={gifUrl.url} />
  }

  if (gifUrl.provider === 'gifer') {
    const src = giferVideoUrl(gifUrl.url)
    if (!src) return <UrlFallback url={gifUrl.url} />
    return <GiferVideo src={src} fallbackUrl={gifUrl.url} originalUrl={gifUrl.url} />
  }

  if (gifUrl.provider === 'imgur') {
    const src = imgurGifUrl(gifUrl.url)
    if (!src) return <UrlFallback url={gifUrl.url} />
    return <GifImage src={src} fallbackUrl={gifUrl.url} originalUrl={gifUrl.url} />
  }

  if (gifUrl.provider === 'content') {
    // gifOnly=true → message is only this URL, so on failure show a link (nothing else to show)
    // gifOnly=false → text is visible, so on failure just hide the embed
    return <ContentGifImage src={gifUrl.url} originalUrl={gifUrl.url} hideOnFail={!gifOnly} />
  }

  return null
}
