import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertAsarContents,
  assertPackagedRenderer,
  createPackagingPlan,
  createZipVerificationCommands
} from './package-mac.mjs'

const root = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

describe('macOS packaging workflow', () => {
  it('is the single package:mac entrypoint', () => {
    expect(packageJson.scripts['package:mac']).toBe('node scripts/package-mac.mjs')
  })

  it('packages only bundled dist output and package metadata', () => {
    expect(packageJson.build.files).toEqual([
      'dist/**',
      'package.json',
      '!node_modules/**',
      '!src/**',
      '!electron/**',
      '!scripts/**',
      '!**/*.test.*'
    ])
    const validEntries = [
      '/dist',
      '/dist/web',
      '/dist/web/index.html',
      '/dist/electron-main.mjs',
      '/package.json'
    ]
    expect(() => assertAsarContents(validEntries)).not.toThrow()
    expect(() => assertPackagedRenderer(validEntries)).not.toThrow()
    expect(() => assertPackagedRenderer(['/dist/index.html'])).toThrow(/renderer HTML is missing/i)
    expect(() => assertAsarContents([...validEntries, '/dist/index.html'])).toThrow(/unexpected ASAR content/i)
    expect(() => assertAsarContents([...validEntries, '/dist/assets/stale.js'])).toThrow(/unexpected ASAR content/i)
    expect(() => assertAsarContents(['/dist/web/index.html', '/node_modules/react/index.js'])).toThrow(/unexpected ASAR content/i)
    expect(() => assertAsarContents(['/dist/web/index.html', '/src/main.tsx'])).toThrow(/unexpected ASAR content/i)
    expect(() => assertAsarContents(['/dist/web/index.html', '/dist/main.test.js'])).toThrow(/unexpected ASAR content/i)
  })

  it('derives deterministic artifacts and safe argument-array commands from package metadata', () => {
    const plan = createPackagingPlan({
      root,
      packageJson,
      nodePath: '/usr/bin/node',
      builderCli: '/repo/node_modules/electron-builder/cli.js'
    })

    const appPath = resolve(root, 'release/mac-arm64/Hermes Companion.app')
    const executablePath = resolve(appPath, 'Contents/MacOS/Hermes Companion')
    const zipPath = resolve(root, 'release/Hermes-Companion-0.1.0-mac-arm64.zip')

    expect(plan).toMatchObject({ appPath, executablePath, zipPath })
    expect(plan.commands).toEqual([
      { command: 'npm', args: ['run', 'build'] },
      {
        command: '/usr/bin/node',
        args: ['/repo/node_modules/electron-builder/cli.js', '--mac', '--arm64', '--dir', '--publish', 'never']
      },
      { command: 'codesign', args: ['--force', '--deep', '--sign', '-', appPath] },
      { command: 'codesign', args: ['--verify', '--deep', '--strict', appPath] },
      { command: 'lipo', args: [executablePath, '-verify_arch', 'arm64'] },
      {
        command: 'ditto',
        args: ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath]
      }
    ])

    const extractedAppPath = '/tmp/package-verification/Hermes Companion.app'
    expect(createZipVerificationCommands(plan, '/tmp/package-verification')).toEqual([
      { command: 'ditto', args: ['-x', '-k', zipPath, '/tmp/package-verification'] },
      { command: 'codesign', args: ['--verify', '--deep', '--strict', extractedAppPath] },
      {
        command: 'lipo',
        args: [`${extractedAppPath}/Contents/MacOS/Hermes Companion`, '-verify_arch', 'arm64']
      }
    ])
  })
})
