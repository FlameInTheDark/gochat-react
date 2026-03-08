/**
 * Shared denoiser helpers used by both voiceService (live call pipeline)
 * and MicTest / VAD meter (settings preview).
 *
 * WASM binaries are cached at module level — they are binary blobs, not tied
 * to a specific AudioContext, so one fetch is enough per page load.
 *
 * AudioWorklet modules MUST be registered per-AudioContext; calling addModule()
 * again on the same context is idempotent (the browser no-ops it), so we always
 * call it rather than tracking which contexts have already loaded which module.
 */

import {
  loadRnnoise, RnnoiseWorkletNode,
  loadSpeex,   SpeexWorkletNode,
} from '@sapphi-red/web-noise-suppressor'
import rnnoiseWorkletPath  from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import speexWorkletPath    from '@sapphi-red/web-noise-suppressor/speexWorklet.js?url'
import rnnoiseWasmPath     from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseWasmSimdPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import speexWasmPath       from '@sapphi-red/web-noise-suppressor/speex.wasm?url'

export type DenoiserType = 'default' | 'rnnoise' | 'speex'
export type DenoiserNode = RnnoiseWorkletNode | SpeexWorkletNode

// Cached WASM binaries — loaded once per page session.
let rnnoiseWasm: ArrayBuffer | null = null
let speexWasm: ArrayBuffer | null = null

/**
 * Creates a denoiser AudioNode for the given type and connects `inputNode` to it.
 * Returns null when type is 'default' (caller connects inputNode directly).
 *
 * AudioWorklet module registration is called every time — addModule() is
 * idempotent per spec so duplicate calls on the same context are harmless,
 * while a fresh context (e.g. MicTest) gets the module it needs.
 */
export async function buildDenoiserNode(
  type: DenoiserType,
  ctx: AudioContext,
  inputNode: AudioNode,
): Promise<DenoiserNode | null> {
  if (type === 'rnnoise') {
    await ctx.audioWorklet.addModule(rnnoiseWorkletPath)
    if (!rnnoiseWasm) {
      rnnoiseWasm = await loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseWasmSimdPath })
    }
    const node = new RnnoiseWorkletNode(ctx, { wasmBinary: rnnoiseWasm, maxChannels: 1 })
    inputNode.connect(node)
    return node
  }

  if (type === 'speex') {
    await ctx.audioWorklet.addModule(speexWorkletPath)
    if (!speexWasm) {
      speexWasm = await loadSpeex({ url: speexWasmPath })
    }
    const node = new SpeexWorkletNode(ctx, { wasmBinary: speexWasm, maxChannels: 1 })
    inputNode.connect(node)
    return node
  }

  return null
}

export function destroyDenoiserNode(node: DenoiserNode | null) {
  if (!node) return
  try { node.destroy() } catch { /* already destroyed */ }
  try { node.disconnect() } catch { /* already disconnected */ }
}

/**
 * Resolves the denoiser type that should actually run, accounting for the
 * global noise-suppression toggle. When suppression is disabled, everything
 * falls back to 'default' (no processing).
 */
export function effectiveDenoiserType(type: DenoiserType, enabled: boolean): DenoiserType {
  return enabled ? type : 'default'
}

/**
 * Returns the noiseSuppression value to pass to getUserMedia.
 * When using a custom denoiser the browser-native suppression is disabled
 * to avoid double-processing. When suppression is off entirely it is also off.
 */
export function effectiveNoiseSuppression(
  type: DenoiserType,
  enabled: boolean,
): boolean {
  // Only the 'default' path uses the browser constraint; custom denoisers handle it in the worklet.
  return enabled && type === 'default'
}
