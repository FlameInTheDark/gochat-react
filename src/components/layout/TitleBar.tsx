import { useState, useEffect } from 'react'

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const [updateReady, setUpdateReady] = useState(false)

  useEffect(() => {
    window.electronAPI?.isMaximized().then(setMaximized)
    return window.electronAPI?.onMaximizeChange(setMaximized)
  }, [])

  useEffect(() => {
    return window.electronAPI?.onUpdateReady(() => setUpdateReady(true))
  }, [])

  return (
    <div
      className="flex h-8 w-full shrink-0 select-none items-center bg-background"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div
        className="ml-auto flex h-full items-center"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {updateReady && (
          <button
            onClick={() => window.electronAPI?.installUpdate()}
            className="mr-2 flex items-center gap-1.5 rounded bg-green-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-green-500"
            title="Update ready — click to restart and install"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="1" x2="6" y2="8" />
              <polyline points="3,5.5 6,8.5 9,5.5" />
              <line x1="1" y1="11" x2="11" y2="11" />
            </svg>
            Restart to update
          </button>
        )}
        <button
          onClick={() => window.electronAPI?.minimize()}
          className="flex h-full w-11 items-center justify-center text-foreground/60 hover:bg-white/10 hover:text-foreground"
          aria-label="Minimize"
        >
          <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
            <rect width="10" height="1" />
          </svg>
        </button>
        <button
          onClick={() => window.electronAPI?.maximize()}
          className="flex h-full w-11 items-center justify-center text-foreground/60 hover:bg-white/10 hover:text-foreground"
          aria-label={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? (
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="3" y="0" width="8" height="8" />
              <path d="M0 3 L0 11 L8 11 L8 8" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
          )}
        </button>
        <button
          onClick={() => window.electronAPI?.close()}
          className="flex h-full w-11 items-center justify-center text-foreground/60 hover:bg-red-600 hover:text-white"
          aria-label="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="0" y1="0" x2="10" y2="10" />
            <line x1="10" y1="0" x2="0" y2="10" />
          </svg>
        </button>
      </div>
    </div>
  )
}
