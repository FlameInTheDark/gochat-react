import path from 'path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const base = env.VITE_BASE_PATH || '/'

  return {
    plugins: [react(), tailwindcss()],
    base,
    resolve: {
      conditions: ['import', 'browser', 'module', 'default'],
      alias: {
        '@': path.resolve(__dirname, './src'),
        // Ensure axios resolves from our node_modules even when imported
        // from the jsclient symlink (which lives outside this project)
        axios: path.resolve(__dirname, './node_modules/axios'),
      },
    },
    build: { outDir: 'dist' },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test/setup.ts',
    },
  }
})
