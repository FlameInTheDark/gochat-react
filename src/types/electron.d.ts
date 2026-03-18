/**
 * Optional Electron desktop API — exposed by preload.ts via contextBridge.
 * All properties are optional: this object only exists when running inside Electron.
 * Web code should always use optional chaining: window.electronAPI?.notify(...)
 */
interface ElectronAPI {
  minimize: () => void
  maximize: () => void
  close: () => void
  isMaximized: () => Promise<boolean>
  onMaximizeChange: (cb: (maximized: boolean) => void) => () => void
  notify: (opts: { title: string; body: string }) => void
  setTrayBadge: (count: number) => void
  onDeepLink: (cb: (url: string) => void) => () => void
  openExternal: (url: string) => void
  secureStore: {
    get: (key: string) => string | null
    set: (key: string, value: string) => void
    delete: (key: string) => void
  }
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

export {}
