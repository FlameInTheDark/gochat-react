import { useState, useEffect } from 'react'
import { useClientModeStore, type ClientMode } from '@/stores/clientModeStore'

/** Returns true when running inside an Electron shell. */
function isElectron(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron')
}

/**
 * Detect the native client mode from UA + viewport.
 * Electron is always treated as desktop regardless of window width.
 */
function detectNativeMode(): ClientMode {
  if (isElectron()) return 'desktop'
  if (typeof window === 'undefined') return 'desktop'
  return window.innerWidth < 768 ? 'mobile' : 'desktop'
}

/**
 * Returns the effective client mode.
 *
 * Priority:
 * 1. Override stored in localStorage (allows Electron to force mobile, or web to force desktop)
 * 2. Auto-detected from UA + viewport (Electron → desktop, narrow → mobile)
 *
 * Re-evaluates on window resize so orientation changes are handled live.
 */
export function useClientMode(): ClientMode {
  const override = useClientModeStore((s) => s.override)
  const [detected, setDetected] = useState<ClientMode>(detectNativeMode)

  useEffect(() => {
    const handler = () => setDetected(detectNativeMode())
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  if (override !== null) return override
  return detected
}
