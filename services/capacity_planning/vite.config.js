import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'node',
  },
  server: {
    proxy: {
      '/linear-api': {
        target: 'https://api.linear.app',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/linear-api/, ''),
      },
    },
  },
})
