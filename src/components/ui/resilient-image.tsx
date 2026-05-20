import { useEffect, useMemo, useRef, useState } from 'react'
import type { ImgHTMLAttributes, SyntheticEvent } from 'react'
import { imageRetryUrl, resolveAssetUrl } from '@/lib/assetUrl'

interface ResilientImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  maxRetries?: number
}

export function ResilientImage({
  src,
  maxRetries = 2,
  onError,
  ...props
}: ResilientImageProps) {
  const resolvedSrc = useMemo(() => resolveAssetUrl(src), [src])
  const [attempt, setAttempt] = useState(0)
  const retryTimerRef = useRef<number | null>(null)

  useEffect(() => {
    setAttempt(0)
  }, [resolvedSrc])

  useEffect(() => () => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current)
    }
  }, [])

  const currentSrc = useMemo(() => imageRetryUrl(resolvedSrc, attempt), [resolvedSrc, attempt])

  function handleError(event: SyntheticEvent<HTMLImageElement, Event>) {
    onError?.(event)
    if (event.defaultPrevented || attempt >= maxRetries || typeof window === 'undefined') return

    retryTimerRef.current = window.setTimeout(() => {
      setAttempt((current) => Math.min(current + 1, maxRetries))
    }, 250 * (attempt + 1))
  }

  return <img {...props} src={currentSrc} onError={handleError} />
}
