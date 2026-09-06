import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist/web',
    target: 'chrome69'
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts'
  }
})
