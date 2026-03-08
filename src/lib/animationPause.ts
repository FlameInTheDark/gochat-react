/**
 * Shared app-focus / tab-visibility tracking for animation pause logic.
 * Both AnimatedImage (GIF/WebP) and video-based embeds register their
 * `apply` callbacks here so a single set of event listeners covers all.
 */

export const focusListeners = new Set<() => void>()

export function isAppPaused(): boolean {
  return document.hidden || !document.hasFocus()
}

if (typeof window !== 'undefined') {
  const notify = () => focusListeners.forEach((fn) => fn())
  document.addEventListener('visibilitychange', notify)
  window.addEventListener('blur', notify)
  window.addEventListener('focus', notify)
}
