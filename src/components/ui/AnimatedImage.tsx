import { useRef, useEffect } from 'react'
import { focusListeners, isAppPaused } from '@/lib/animationPause'

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

// ── Component ─────────────────────────────────────────────────────────────────

interface Props extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string
  /**
   * Optional static preview (e.g. a JPEG thumbnail) shown while the animated
   * `src` is loading and whenever the element is off-screen or the app loses focus.
   *
   * When omitted the component captures frame 0 via canvas right after the
   * image loads and uses that as the paused/off-screen placeholder.
   */
  preview?: string
}

export default function AnimatedImage({ src, preview, crossOrigin, ...rest }: Props) {
  const ref = useRef<HTMLImageElement>(null)
  const loadedRef = useRef(!preview)
  const inViewRef = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    let pausedSrc: string | null = preview ?? null
    let worker: HTMLImageElement | null = null

    function apply() {
      if (!el) return
      if (!loadedRef.current) {
        // Original not ready yet – keep showing the static preview
        el.src = preview!
      } else if (isAppPaused() || !inViewRef.current) {
        el.src = pausedSrc ?? BLANK
      } else {
        el.src = src
      }
    }

    // Register with the global focus/visibility system
    focusListeners.add(apply)

    if (!preview) {
      // No caller-supplied preview: load the image in a shadow element and
      // draw frame 0 to canvas to obtain a static placeholder.
      const shadow = new Image()
      if (crossOrigin) shadow.crossOrigin = crossOrigin
      shadow.src = src
      shadow.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = shadow.naturalWidth || 1
          canvas.height = shadow.naturalHeight || 1
          const ctx = canvas.getContext('2d')
          if (ctx) {
            ctx.drawImage(shadow, 0, 0)
            pausedSrc = canvas.toDataURL()
            if (isAppPaused() || !inViewRef.current) apply()
          }
        } catch {
          // Canvas taint or unsupported – fall back to BLANK
        } finally {
          shadow.onload = null
        }
      }
      worker = shadow
    }

    // For preview-based images: start downloading the original only when the
    // element is near the viewport (saves bandwidth for unread history).
    function startLoad() {
      if (loadedRef.current || worker) return
      worker = new Image()
      worker.src = src
      worker.onload = () => {
        loadedRef.current = true
        apply()
      }
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        inViewRef.current = entry.isIntersecting
        if (entry.isIntersecting && preview && !loadedRef.current) startLoad()
        apply()
      },
      { rootMargin: '100px 0px', threshold: 0 },
    )

    observer.observe(el)

    return () => {
      observer.disconnect()
      focusListeners.delete(apply)
      if (worker) worker.onload = null
    }
  }, [src, preview, crossOrigin])

  return <img ref={ref} src={preview ?? src} crossOrigin={crossOrigin} {...rest} />
}
