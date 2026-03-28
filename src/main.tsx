import { Buffer } from 'buffer'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import '@/i18n'
import App from './App.tsx'

// @napi-rs/wasm-runtime (used by @snazzah/davey-wasm32-wasi) returns buffer values that
// the npm `buffer` polyfill's Buffer.from cannot handle (cross-realm or non-standard types).
// Patch Buffer.from: try normally first; on failure extract bytes via indexed access,
// which works for any array-like regardless of prototype chain or realm.
{
  const _from = Buffer.from.bind(Buffer)
  ;(Buffer as unknown as { from: typeof Buffer.from }).from = function patchedBufferFrom(
    value: unknown,
    ...args: unknown[]
  ) {
    try {
      return _from(value, ...args)
    } catch (err) {
      if (value !== null && typeof value === 'object') {
        const v = value as Record<string, unknown>
        // Unwrap { type: 'Buffer', data: <array-like> } if present
        const source = (v['type'] === 'Buffer' && v['data'] != null) ? v['data'] : v
        const len = (source as { length?: unknown }).length
        if (typeof len === 'number' && len >= 0) {
          const bytes = new Uint8Array(len)
          for (let i = 0; i < len; i++) bytes[i] = (source as Record<number, unknown>)[i] as number
          return _from(bytes)
        }
      }
      throw err
    }
  } as typeof Buffer.from
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
