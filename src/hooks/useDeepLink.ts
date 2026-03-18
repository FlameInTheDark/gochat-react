import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

/**
 * Handles deep links from the Electron shell (gochat://...).
 * No-op in a browser context where window.electronAPI is absent.
 *
 * Supported schemes:
 *   gochat://invite/<code>  →  /invite/<code>
 */
export function useDeepLink() {
  const navigate = useNavigate()

  useEffect(() => {
    if (!window.electronAPI) return

    const cleanup = window.electronAPI.onDeepLink((url) => {
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'gochat:') return
        navigate(`/${parsed.hostname}${parsed.pathname}`)
      } catch {
        // malformed URL — ignore
      }
    })

    return cleanup
  }, [navigate])
}
