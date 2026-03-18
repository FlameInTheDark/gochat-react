/**
 * Platform-aware token storage.
 *
 * • Electron: OS-encrypted via window.electronAPI.secureStore (safeStorage/DPAPI/Keychain)
 * • Web:      sessionStorage — cleared on tab/browser close, no plaintext on disk
 *
 * Migration: plain-text tokens left in localStorage by older versions are moved
 * to the current backend on first read and the localStorage copies are removed.
 */
export const tokenStorage = {
  get(key: string): string | null {
    if (typeof window !== 'undefined' && window.electronAPI?.secureStore) {
      const value = window.electronAPI.secureStore.get(key)
      if (value !== null) return value
      // Migrate from plain localStorage (older Electron builds)
      const legacy = localStorage.getItem(key)
      if (legacy) {
        window.electronAPI.secureStore.set(key, legacy)
        localStorage.removeItem(key)
        return legacy
      }
      return null
    }
    // Web: migrate from localStorage to sessionStorage
    const legacy = localStorage.getItem(key)
    if (legacy) {
      sessionStorage.setItem(key, legacy)
      localStorage.removeItem(key)
      return legacy
    }
    return sessionStorage.getItem(key)
  },

  set(key: string, value: string): void {
    if (typeof window !== 'undefined' && window.electronAPI?.secureStore) {
      window.electronAPI.secureStore.set(key, value)
    } else {
      sessionStorage.setItem(key, value)
    }
  },

  delete(key: string): void {
    if (typeof window !== 'undefined' && window.electronAPI?.secureStore) {
      window.electronAPI.secureStore.delete(key)
    } else {
      sessionStorage.removeItem(key)
    }
  },
}
