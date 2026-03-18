# Electron Integration Guide

This document describes how the React web project integrates with the Electron desktop app (`gochat-electron`).

---

## Overview

The React project is the **single source of truth** for all UI code. The Electron app wraps it using a file-sync script (`sync-web.mjs`) that copies the React `src/` into the Electron renderer. A small set of platform abstractions ensures that most files are **identical in both builds** with no manual merging.

```
gochat-react/src/   ──sync──►   gochat-electron/src/
     (web)                            (renderer)
```

---

## Platform Abstractions

These files in `src/lib/` and `src/stores/` make the codebase portable. Write platform-agnostic code by importing from them instead of using `import.meta.env` or `sessionStorage` directly.

### `src/lib/tokenStorage.ts`

Abstracts auth token persistence.

| Context  | Backend |
|----------|---------|
| Electron | `window.electronAPI.secureStore` — OS-level encryption (DPAPI on Windows, Keychain on macOS, libsecret on Linux) |
| Web      | `sessionStorage` — cleared on tab close, no plaintext on disk |

Handles migration from `localStorage` automatically on first read.

```ts
import { tokenStorage } from '@/lib/tokenStorage'

tokenStorage.get('auth_token')
tokenStorage.set('auth_token', value)
tokenStorage.delete('auth_token')
```

### `src/lib/connectionConfig.ts`

Abstracts the API base URL and WebSocket URL.

| Context  | Source |
|----------|--------|
| Electron | Persisted user config (`connectionStore`) loaded from `localStorage` on startup; user can point the app at any server via the Connection Config modal |
| Web      | Vite env vars (`VITE_API_BASE_URL`, `VITE_WEBSOCKET_URL`) baked in at build time |

```ts
import { getApiBaseUrl, getWsUrl } from '@/lib/connectionConfig'

// api/client.ts and wsService.ts use these — do not read import.meta.env directly
```

`setConnectionConfig()` is called by Electron's `connectionStore` at module load and whenever the user changes the server URL. Web code never needs to call it.

---

## `window.electronAPI`

The preload script (`src/preload.ts` in the Electron project) exposes a typed bridge on `window.electronAPI`. It is **always optional** — every call must use optional chaining so the same code runs in the browser without errors.

```ts
// ✅ correct
window.electronAPI?.notify({ title: 'GoChat', body: 'New message' })
window.electronAPI?.setTrayBadge(3)
window.electronAPI?.openExternal('https://example.com')

// ❌ wrong — crashes in the browser build
window.electronAPI.notify(...)
```

The full interface is declared in `src/types/electron.d.ts`:

```ts
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
```

> When adding a new IPC channel: add the handler to `main.ts`, expose it in `preload.ts`, and extend this interface.

---

## Hooks

### `src/hooks/useDeepLink.ts`

Handles `gochat://` deep links forwarded from the OS via IPC. No-op in the browser.

```
gochat://invite/<code>  →  navigate to /invite/<code>
```

Mount it once at the router root (already done in `AppLayout.tsx`).

### Detecting Electron at runtime

```ts
const isElectron = !!window.electronAPI
```

Use this for conditional UI (e.g. showing/hiding the custom title bar, window controls, or connection config button).

---

## Electron Bridge (`src/electron/bridge.ts`)

Electron-only file (never synced from web). Wires Zustand stores to native desktop APIs after React mounts:

- **Tray badge** — tracks `mentionStore` and updates the taskbar/dock badge count
- **Native notifications** — fires a system notification when new mentions arrive
- **Deep links** — re-dispatches IPC deep-link events as DOM `CustomEvent`s so `useDeepLink` can call `navigate()` inside the router context

Called once from `renderer.tsx`:
```ts
setupElectronBridge()
```

---

## Sync Workflow

```bash
# From the gochat-electron repo root:

npm run sync-web          # copy changed files from ../gochat-react/src/
npm run sync-web:dry      # preview what would change
npm run sync-web:remote   # clone from GitHub and sync (CI / fresh machines)
```

### `electron-patches.json`

Controls what the sync script does with each file:

| Category | Behaviour | Files |
|----------|-----------|-------|
| `new` | Electron-only — never touched by sync | `main.ts`, `preload.ts`, `renderer.tsx`, `TitleBar.tsx`, `ConnectionConfigModal.tsx`, `connectionStore.ts`, `bridge.ts`, `backgroundStore.ts` |
| `patched` | Exists in both but diverges — sync warns, **do not auto-overwrite** | `App.tsx`, `LoginPage.tsx`, `AppLayout.tsx`, `AppShell.tsx` |
| *(everything else)* | Kept in sync automatically | All other `src/` files |

### Why these files are patched

| File | Difference from web |
|------|-----------|
| `App.tsx` | `createHashRouter` instead of `createBrowserRouter`; `<TitleBar />` in root layout |
| `LoginPage.tsx` | May contain Electron-specific server URL handling |
| `AppLayout.tsx` | May contain Electron-specific behaviour |
| `AppShell.tsx` | Imports `backgroundStore` for custom chat background (Electron-only feature) |

When updating any of these in the web project, run `sync-web:dry` first to see what would be overwritten, then manually apply the diff to the Electron version.

---

## Adding New Electron Features

1. **IPC channel** — add `ipcMain.handle/on` in `main.ts`, expose via `contextBridge` in `preload.ts`, extend `ElectronAPI` in `src/types/electron.d.ts`
2. **Store wiring** — add subscriptions in `src/electron/bridge.ts` (keep this file free of UI code)
3. **React hook** — create a hook in `src/hooks/` that calls `window.electronAPI?....` with optional chaining; it will be a no-op in the browser automatically
4. **Conditional UI** — use `!!window.electronAPI` to show/hide electron-only controls; keep the component in the shared `src/` so it syncs automatically

---

## File Ownership Summary

```
src/
├── lib/
│   ├── tokenStorage.ts       ← shared (platform-aware)
│   └── connectionConfig.ts   ← shared (platform-aware)
├── stores/
│   ├── authStore.ts          ← shared (uses tokenStorage)
│   ├── backgroundStore.ts    ← Electron-only (new) — custom chat background
│   └── connectionStore.ts    ← Electron-only (new)
├── electron/
│   └── bridge.ts             ← Electron-only (new)
├── components/layout/
│   ├── TitleBar.tsx          ← Electron-only (new)
│   └── AppShell.tsx          ← patched (backgroundStore import)
├── components/modals/
│   └── ConnectionConfigModal.tsx  ← Electron-only (new)
├── types/
│   └── electron.d.ts         ← shared (type declarations)
├── hooks/
│   └── useDeepLink.ts        ← shared (no-op in web)
├── App.tsx                   ← patched (hash router + TitleBar)
├── pages/LoginPage.tsx       ← patched (connection config button)
└── pages/app/AppLayout.tsx   ← patched (connection config button)
```
