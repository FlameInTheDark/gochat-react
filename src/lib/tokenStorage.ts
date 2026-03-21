/**
 * Platform-aware token storage.
 *
 * • Electron: OS-encrypted via window.electronAPI.secureStore (safeStorage/DPAPI/Keychain)
 * • Web:      localStorage — persists across tabs and browser restarts
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
    return localStorage.getItem(key)
  },

  set(key: string, value: string): void {
    if (typeof window !== 'undefined' && window.electronAPI?.secureStore) {
      window.electronAPI.secureStore.set(key, value)
    } else {
      localStorage.setItem(key, value)
    }
  },

  delete(key: string): void {
    if (typeof window !== 'undefined' && window.electronAPI?.secureStore) {
      window.electronAPI.secureStore.delete(key)
    } else {
      localStorage.removeItem(key)
    }
  },
}
