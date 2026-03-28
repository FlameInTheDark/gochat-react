import { Buffer } from 'buffer'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import '@/i18n'
import App from './App.tsx'

// @napi-rs/wasm-runtime (used by @snazzah/davey-wasm32-wasi) passes a SharedArrayBuffer
// to Buffer.from. The npm `buffer` polyfill only handles ArrayBuffer, not SharedArrayBuffer.
// Intercept and copy to a regular ArrayBuffer-backed Uint8Array first.
{
  const _from = Buffer.from.bind(Buffer)
  ;(Buffer as unknown as { from: typeof Buffer.from }).from = function patchedBufferFrom(
    value: unknown,
    ...args: unknown[]
  ) {
    if (value instanceof SharedArrayBuffer) {
      // Copy SAB → regular ArrayBuffer so the polyfill can handle it
      return _from(Uint8Array.from(new Uint8Array(value)))
    }
    return _from(value, ...args)
  } as typeof Buffer.from
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
