import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string
const gitCommit = process.env.HERMES_COMPANION_GIT_COMMIT ?? (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
  catch { return 'development' }
})()

export default defineConfig({
  base: './',
  define: {
    __COMPANION_GIT_COMMIT__: JSON.stringify(gitCommit),
    __COMPANION_VERSION__: JSON.stringify(packageVersion),
  },
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
