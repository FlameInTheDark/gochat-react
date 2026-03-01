import { useEffect, useRef } from 'react'
import { usePresenceStore } from '@/stores/presenceStore'
import { sendPresenceStatus } from '@/services/wsService'

/** After this many ms of no user input the client auto-sends "idle" status. */
const IDLE_TIMEOUT_MS = 10 * 60 * 1_000 // 10 minutes

const ACTIVITY_EVENTS = [
  'mousemove',
  'mousedown',
  'keydown',
  'scroll',
  'touchstart',
] as const

/**
 * Auto-switches the user's presence to "idle" after IDLE_TIMEOUT_MS of no
 * input activity, and restores it to "online" when they return.
 *
 * Rules:
 *  - Only auto-idles when the current status is "online".
 *  - Only auto-restores if the idle state was set by this hook, not by the user.
 *  - Never modifies "dnd", user-set "offline", or user-set "idle".
 *
 * Call once inside the authenticated shell (AuthenticatedApp), after the WS
 * hook has been mounted, so sendPresenceStatus has an open socket to write to.
 */
export function useIdlePresence() {
  const setOwnStatus = usePresenceStore((s) => s.setOwnStatus)
  const ownStatus = usePresenceStore((s) => s.ownStatus)

  // Stable ref so the timeout/event callbacks always see the latest ownStatus
  // without needing to re-register them every time the status changes.
  const ownStatusRef = useRef(ownStatus)
  useEffect(() => {
    ownStatusRef.current = ownStatus
  }, [ownStatus])

  // true when this hook (not the user) triggered the current "idle" state
  const autoIdled = useRef(false)

  useEffect(() => {
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    function scheduleIdle() {
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = setTimeout(goIdle, IDLE_TIMEOUT_MS)
    }

    function goIdle() {
      if (ownStatusRef.current === 'online') {
        autoIdled.current = true
        setOwnStatus('idle')
        sendPresenceStatus('idle')
      }
      // dnd / user-set offline / user-set idle — leave untouched.
      // The timer is now expired; onActivity() will restart it on next input.
    }

    function onActivity() {
      // Restore from auto-idle when the user comes back to the keyboard/mouse
      if (autoIdled.current && ownStatusRef.current === 'idle') {
        autoIdled.current = false
        setOwnStatus('online')
        sendPresenceStatus('online')
      }
      scheduleIdle()
    }

    // Arm the timer immediately on mount
    scheduleIdle()

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true })
    }
    // Tab regaining visibility (alt-tab back, unminimise) counts as activity
    document.addEventListener('visibilitychange', onActivity)

    return () => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity)
      }
      document.removeEventListener('visibilitychange', onActivity)
    }
  }, [setOwnStatus]) // setOwnStatus is a stable Zustand selector
}
