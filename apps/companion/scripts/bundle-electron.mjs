import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const external = ['electron']

await build({
  entryPoints: [resolve(root, 'electron/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: resolve(root, 'dist/electron-main.mjs'),
  external,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
})

await build({
  entryPoints: [resolve(root, 'electron/preload.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: resolve(root, 'dist/electron-preload.cjs'),
  external
})
