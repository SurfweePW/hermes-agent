import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  assertAsarContents,
  assertPackagedRenderer,
  createInstallStamp,
  createPackageManifest,
  createPackagingPlan,
  createZipVerificationCommands,
  runCommand,
  verifyReleaseCredentials
} from './package-mac.mjs'

const root = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const releaseCredentials = {
  identity: 'Developer ID Application: Example Corp (TEAMID1234)',
  notarizationProfile: 'hermes-notary'
}

function planFor(mode, credentials) {
  return createPackagingPlan({
    mode,
    credentials,
    root,
    packageJson,
    nodePath: '/usr/bin/node',
    builderCli: '/repo/node_modules/electron-builder/cli.js'
  })
}

describe('macOS packaging workflow', () => {
  it('makes release fail-closed by default and dogfood explicit', () => {
    expect(packageJson.scripts['package:mac']).toBe('npm run package:mac:release')
    expect(packageJson.scripts['package:mac:release']).toBe('node scripts/package-mac.mjs release')
    expect(packageJson.scripts['package:mac:dogfood']).toBe('node scripts/package-mac.mjs dogfood')
    expect(packageJson.build.mac).toMatchObject({
      hardenedRuntime: true,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist'
    })
    expect(packageJson.build.mac).not.toHaveProperty('identity')
  })

  it('packages only bundled dist output and requires the current renderer', () => {
    expect(packageJson.build.files).toEqual([
      'dist/**', 'package.json', '!node_modules/**', '!src/**', '!electron/**', '!scripts/**', '!**/*.test.*'
    ])
    const validEntries = [
      '/dist', '/dist/web', '/dist/web/index.html', '/dist/electron-main.mjs', '/package.json'
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

  it('refuses release without an explicit installed Developer ID identity and valid notary profile', () => {
    expect(() => planFor('release')).toThrow(/HERMES_MACOS_SIGNING_IDENTITY/)
    expect(() => planFor('release', { identity: 'Apple Development: Example', notarizationProfile: 'profile' }))
      .toThrow(/Developer ID Application/)
    expect(() => planFor('release', { identity: releaseCredentials.identity }))
      .toThrow(/HERMES_MACOS_NOTARIZATION_PROFILE/)

    const capture = vi.fn()
      .mockReturnValueOnce('  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Developer ID Application: Other (OTHER12345)"')
    expect(() => verifyReleaseCredentials(releaseCredentials, capture)).toThrow(/not a valid codesigning identity/i)
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('preflights the exact configured identity and notary credentials without selecting an identity', () => {
    const capture = vi.fn()
      .mockReturnValueOnce(`  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "${releaseCredentials.identity}"`)
      .mockReturnValueOnce('{"history":[]}')
    expect(verifyReleaseCredentials(releaseCredentials, capture)).toEqual(releaseCredentials)
    expect(capture).toHaveBeenNthCalledWith(1, 'security', ['find-identity', '-v', '-p', 'codesigning'])
    expect(capture).toHaveBeenNthCalledWith(
      2,
      'xcrun',
      ['notarytool', 'history', '--keychain-profile', releaseCredentials.notarizationProfile, '--output-format', 'json'],
      { redactAfter: '--keychain-profile' }
    )
  })

  it('runs the mocked ad-hoc dogfood path with identity discovery disabled and no Apple service calls', () => {
    const plan = planFor('dogfood')
    const spawn = vi.fn(() => ({ status: 0 }))
    for (const command of plan.commands) runCommand(command, root, spawn)

    expect(plan.commands[1]).toMatchObject({
      args: expect.arrayContaining(['--config.mac.identity=null', '--config.mac.hardenedRuntime=false']),
      env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
    })
    expect(plan.commands).toContainEqual({
      command: 'codesign',
      args: ['--force', '--deep', '--sign', '-', plan.appPath]
    })
    expect(plan.commands.some(({ command }) => command === 'xcrun' || command === 'spctl')).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(plan.commands.length)
    expect(createZipVerificationCommands(plan, '/tmp/package-verification').map(({ command }) => command))
      .toEqual(['ditto', 'codesign', 'lipo'])
  })

  it('requires hardened release signing, notarization, stapling, Gatekeeper, and ZIP re-verification', () => {
    const plan = planFor('release', releaseCredentials)
    const entitlementsPath = resolve(root, 'build/entitlements.mac.plist')
    expect(plan.commands[1]).toMatchObject({
      args: expect.arrayContaining([
        `--config.mac.identity=${releaseCredentials.identity}`,
        '--config.mac.hardenedRuntime=true',
        `--config.mac.entitlements=${entitlementsPath}`,
        `--config.mac.entitlementsInherit=${entitlementsPath}`
      ]),
      env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
    })
    expect(plan.commands).toEqual(expect.arrayContaining([
      {
        command: 'codesign',
        args: [
          '--force', '--options', 'runtime', '--entitlements', entitlementsPath,
          '--sign', releaseCredentials.identity, plan.appPath
        ]
      },
      { command: 'codesign', args: ['--verify', '--deep', '--strict', '--verbose=2', plan.appPath] },
      {
        command: 'xcrun',
        args: [
          'notarytool', 'submit', plan.zipPath, '--keychain-profile', releaseCredentials.notarizationProfile,
          '--wait', '--output-format', 'json'
        ],
        expectedOutput: /"status"\s*:\s*"Accepted"/i,
        redactAfter: '--keychain-profile'
      },
      { command: 'xcrun', args: ['stapler', 'staple', plan.appPath] },
      { command: 'xcrun', args: ['stapler', 'validate', plan.appPath] },
      { command: 'spctl', args: ['--assess', '--type', 'execute', '--verbose=2', plan.appPath] }
    ]))
    expect(createZipVerificationCommands(plan, '/tmp/package-verification').map(({ command }) => command))
      .toEqual(['ditto', 'codesign', 'xcrun', 'spctl', 'lipo'])
  })

  it('preserves immutable install provenance and labels dogfood as non-notarized', () => {
    const gitCommit = 'a'.repeat(40)
    expect(createInstallStamp(packageJson, gitCommit, '2026-09-07T12:00:00.000Z')).toEqual({
      product: 'Hermes Companion',
      version: packageJson.version,
      gitCommit,
      sourceCommit: gitCommit,
      dirty: false,
      packagedAt: '2026-09-07T12:00:00.000Z'
    })
    const manifest = createPackageManifest({
      mode: 'dogfood', packageJson, gitCommit, packagedAt: '2026-09-07T12:00:00.000Z',
      artifact: 'Hermes.zip', bytes: 123, sha256: 'b'.repeat(64)
    })
    expect(manifest).toMatchObject({
      mode: 'dogfood', distribution: 'internal-dogfood', signing: 'ad-hoc', hardenedRuntime: false,
      notarized: false, stapled: false, gatekeeperAccepted: false,
      warning: 'NON-NOTARIZED DOGFOOD BUILD — INTERNAL USE ONLY'
    })
    expect(() => createInstallStamp(packageJson, 'short')).toThrow(/full Git commit/i)
  })
})
