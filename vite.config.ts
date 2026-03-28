import path from 'path'
import fs from 'fs'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import type { Plugin } from 'vite'

// @snazzah/davey-wasm32-wasi has "cpu":["wasm32"] so bun on Linux x64 may skip
// installing it. This plugin resolves it to its browser entry when installed,
// and falls back to a minimal stub so the build succeeds either way.
function daveyResolvePlugin(): Plugin {
  const pkgDir = path.resolve(__dirname, './node_modules/@snazzah/davey-wasm32-wasi')
  const browserEntry = path.join(pkgDir, 'davey.wasi-browser.js')
  const installed = fs.existsSync(browserEntry)

  return {
    name: 'vite-plugin-davey-resolve',
    enforce: 'pre',
    resolveId(id) {
      if (id === '@snazzah/davey-wasm32-wasi') {
        return installed ? browserEntry : '\0davey-wasm32-wasi-stub'
      }
      // Sub-path imports from within davey.wasi-browser.js (e.g. worker URL)
      if (installed && id.startsWith('@snazzah/davey-wasm32-wasi/')) {
        return path.join(pkgDir, id.slice('@snazzah/davey-wasm32-wasi/'.length))
      }
      return undefined
    },
    load(id) {
      if (id === '\0davey-wasm32-wasi-stub') {
        // Minimal stub — E2EE voice won't function but the build succeeds.
        return `
          export class DAVESession {}
          export const Codec = Object.freeze({})
          export const MediaType = Object.freeze({})
          export const ProposalsOperationType = Object.freeze({})
          export const SessionStatus = Object.freeze({})
          export default {}
        `
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const base = env.VITE_BASE_PATH || '/'

  return {
    plugins: [daveyResolvePlugin(), react(), tailwindcss(), nodePolyfills({ include: ['buffer'], globals: { Buffer: true } })],
    base,
    resolve: {
      conditions: ['import', 'browser', 'module', 'default'],
      alias: {
        '@': path.resolve(__dirname, './src'),
        // Ensure axios resolves from our node_modules even when imported
        // from the jsclient symlink (which lives outside this project)
        axios: path.resolve(__dirname, './node_modules/axios'),
        // Bypass exports-field resolution failure in bun/Linux environments
        '@tanstack/react-query': path.resolve(__dirname, './node_modules/@tanstack/react-query/build/modern/index.js'),
        // Use npm buffer polyfill instead of the externalized Node.js built-in
        buffer: path.resolve(__dirname, './node_modules/buffer/index.js'),
      },
    },
    build: { outDir: 'dist' },
    optimizeDeps: {
      exclude: ['@snazzah/davey', '@snazzah/davey-wasm32-wasi', '@napi-rs/wasm-runtime'],
      include: ['buffer'],
    },
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
    },
    preview: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test/setup.ts',
    },
  }
})
