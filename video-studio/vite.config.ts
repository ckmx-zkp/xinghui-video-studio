import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4174,
    proxy: {
      '/api': 'http://127.0.0.1:4175',
      '/media': 'http://127.0.0.1:4175',
    },
  },
})
