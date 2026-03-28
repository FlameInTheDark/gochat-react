import { Buffer } from 'buffer'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import '@/i18n'
import App from './App.tsx'

// @napi-rs/wasm-runtime (used by @snazzah/davey-wasm32-wasi) returns Buffer objects
// as { type: 'Buffer', data: Uint8Array } where data is a TypedArray, not a plain Array.
// The npm `buffer` polyfill's Buffer.from only handles Array (not TypedArray) for this format.
// Patch Buffer.from to accept both.
{
  const _from = Buffer.from.bind(Buffer)
  ;(Buffer as unknown as { from: typeof Buffer.from }).from = function patchedBufferFrom(
    value: unknown,
    ...args: unknown[]
  ) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !ArrayBuffer.isView(value) &&
      !(value instanceof ArrayBuffer)
    ) {
      const v = value as Record<string, unknown>
      // { type: 'Buffer', data: TypedArray } — @napi-rs/wasm-runtime format
      if (v['type'] === 'Buffer' && v['data'] != null && !Array.isArray(v['data']) && ArrayBuffer.isView(v['data'])) {
        const d = v['data'] as Uint8Array
        return _from(new Uint8Array(d.buffer, d.byteOffset, d.byteLength))
      }
      // Cross-realm TypedArray: has buffer/byteOffset/byteLength but fails ArrayBuffer.isView
      if (v['buffer'] instanceof ArrayBuffer && typeof v['byteOffset'] === 'number' && typeof v['byteLength'] === 'number') {
        return _from(new Uint8Array(v['buffer'] as ArrayBuffer, v['byteOffset'] as number, v['byteLength'] as number))
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (_from as (...a: unknown[]) => Buffer)(value, ...args)
  } as typeof Buffer.from
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
