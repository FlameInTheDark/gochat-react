import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Ensure axios resolves from our node_modules even when imported
      // from the jsclient symlink (which lives outside this project)
      axios: path.resolve(__dirname, './node_modules/axios'),
    },
  },
  build: { outDir: 'dist' },
})
