import path from 'path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const base = env.VITE_BASE_PATH || '/'

  return {
    plugins: [react(), tailwindcss(), nodePolyfills({ include: ['buffer'], globals: { Buffer: true } })],
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
