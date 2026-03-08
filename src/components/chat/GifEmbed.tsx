import { useState, useRef, useEffect } from 'react'
import AnimatedImage from '@/components/ui/AnimatedImage'
import { focusListeners, isAppPaused } from '@/lib/animationPause'
import type { GifUrl } from '@/lib/gifUrls'
import { giphyGifUrl, giferVideoUrl, imgurGifUrl } from '@/lib/gifUrls'

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

function GifImage({ src, fallbackUrl }: { src: string; fallbackUrl: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <UrlFallback url={fallbackUrl} />
  return (
    <div className="mt-1">
      <AnimatedImage
        src={src}
        crossOrigin="anonymous"
        className="rounded max-w-full object-contain"
        style={{ maxWidth: MAX_WIDTH, maxHeight: MAX_HEIGHT }}
        draggable={false}
        onError={() => setFailed(true)}
      />
    </div>
  )
}

function GiferVideo({ src, fallbackUrl }: { src: string; fallbackUrl: string }) {
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
    <div className="mt-1">
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
    </div>
  )
}

export default function GifEmbed({ gifUrl }: { gifUrl: GifUrl }) {
  if (gifUrl.provider === 'giphy') {
    const src = giphyGifUrl(gifUrl.url)
    if (!src) return <UrlFallback url={gifUrl.url} />
    return <GifImage src={src} fallbackUrl={gifUrl.url} />
  }

  if (gifUrl.provider === 'gifer') {
    const src = giferVideoUrl(gifUrl.url)
    if (!src) return <UrlFallback url={gifUrl.url} />
    return <GiferVideo src={src} fallbackUrl={gifUrl.url} />
  }

  if (gifUrl.provider === 'imgur') {
    const src = imgurGifUrl(gifUrl.url)
    if (!src) return <UrlFallback url={gifUrl.url} />
    return <GifImage src={src} fallbackUrl={gifUrl.url} />
  }

  return null
}
