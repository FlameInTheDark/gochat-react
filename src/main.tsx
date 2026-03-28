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
    if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
      // Buffer.from(sab, byteOffset?, length?) — honour the offset/length args,
      // then copy the slice into a regular ArrayBuffer so the polyfill can handle it.
      const view = args.length >= 2
        ? new Uint8Array(value, args[0] as number, args[1] as number)
        : args.length === 1
          ? new Uint8Array(value, args[0] as number)
          : new Uint8Array(value)
      return _from(new Uint8Array(view)) // new Uint8Array(view) copies into fresh ArrayBuffer
    }
    return _from(value, ...args)
  } as typeof Buffer.from
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
