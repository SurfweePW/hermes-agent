import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { listPackage } from '@electron/asar'

const ARCH = 'arm64'
const OS = 'mac'
const MODES = new Set(['dogfood', 'release'])

export function assertAsarContents(entries) {
  const unexpected = entries.filter((entry) => {
    const path = entry.replace(/^\//, '')
    const expectedRuntime = path === 'package.json'
      || path === 'dist'
      || path === 'dist/web'
      || path.startsWith('dist/web/')
      || path === 'dist/electron-main.mjs'
      || path === 'dist/electron-preload.cjs'

    return !expectedRuntime || /(^|\/)node_modules(\/|$)|(^|\/)(src|electron|scripts)(\/|$)|\.test\./.test(path)
  })
  if (unexpected.length > 0) { throw new Error(`Unexpected ASAR content: ${unexpected.join(', ')}`) }
}

export function assertPackagedRenderer(entries) {
  if (!entries.includes('/dist/web/index.html')) {
    throw new Error('Packaged renderer HTML is missing from ASAR')
  }
}

export function createInstallStamp(packageJson, gitCommit, packagedAt = new Date().toISOString(), dirty = false) {
  if (!/^[0-9a-f]{40}$/.test(gitCommit)) { throw new Error('Install stamp requires a full Git commit') }

  return {
    product: requireString(packageJson.productName, 'package.json productName'),
    version: requireString(packageJson.version, 'package.json version'),
    gitCommit: dirty ? `${gitCommit}-dirty` : gitCommit,
    sourceCommit: gitCommit,
    dirty,
    packagedAt
  }
}

export function createPackageManifest({ mode, packageJson, gitCommit, packagedAt, artifact, bytes, sha256 }) {
  if (!MODES.has(mode)) { throw new Error('macOS packaging mode must be release or dogfood') }
  if (!/^[0-9a-f]{40}$/.test(gitCommit)) { throw new Error('Package manifest requires a full Git commit') }

  const release = mode === 'release'
  return {
    product: requireString(packageJson.productName, 'package.json productName'),
    version: requireString(packageJson.version, 'package.json version'),
    gitCommit,
    sourceCommit: gitCommit,
    dirty: false,
    packagedAt,
    artifact,
    bytes,
    sha256,
    mode,
    distribution: release ? 'external-release' : 'internal-dogfood',
    signing: release ? 'Developer ID Application' : 'ad-hoc',
    hardenedRuntime: release,
    notarized: release,
    stapled: release,
    gatekeeperAccepted: release,
    warning: release ? null : 'NON-NOTARIZED DOGFOOD BUILD — INTERNAL USE ONLY'
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value.trim()
}

export function requireReleaseCredentials(credentials = {}) {
  const identity = requireString(credentials.identity, 'HERMES_MACOS_SIGNING_IDENTITY')
  if (!identity.startsWith('Developer ID Application:')) {
    throw new Error('HERMES_MACOS_SIGNING_IDENTITY must name a Developer ID Application identity')
  }
  const notarizationProfile = requireString(
    credentials.notarizationProfile,
    'HERMES_MACOS_NOTARIZATION_PROFILE'
  )
  return { identity, notarizationProfile }
}

export function assertExplicitSigningIdentity(identity, securityOutput) {
  const identities = [...securityOutput.matchAll(/^\s*\d+\)\s+[0-9a-f]+\s+"([^"]+)"/gim)]
    .map((match) => match[1])
  if (!identities.includes(identity)) {
    throw new Error('Configured Developer ID Application identity is not a valid codesigning identity in the current keychain')
  }
}

export function verifyReleaseCredentials(credentials, capture) {
  const validated = requireReleaseCredentials(credentials)
  const identityOutput = capture('security', ['find-identity', '-v', '-p', 'codesigning'])
  assertExplicitSigningIdentity(validated.identity, identityOutput)
  capture(
    'xcrun',
    ['notarytool', 'history', '--keychain-profile', validated.notarizationProfile, '--output-format', 'json'],
    { redactAfter: '--keychain-profile' }
  )
  return validated
}

export function createPackagingPlan({ mode, credentials, root, packageJson, nodePath, builderCli }) {
  if (!MODES.has(mode)) {
    throw new Error('macOS packaging mode must be explicitly set to release or dogfood')
  }

  const productName = requireString(packageJson.productName, 'package.json productName')
  const version = requireString(packageJson.version, 'package.json version')
  const artifactName = requireString(packageJson.build?.artifactName, 'package.json build.artifactName')
  const outputDirectory = requireString(packageJson.build?.directories?.output, 'package.json build.directories.output')
  const executableName = requireString(packageJson.build?.executableName, 'package.json build.executableName')

  const outputPath = resolve(root, outputDirectory)
  const appPath = resolve(outputPath, `mac-${ARCH}`, `${productName}.app`)
  const executablePath = resolve(appPath, 'Contents', 'MacOS', executableName)
  const entitlementsPath = resolve(root, 'build', 'entitlements.mac.plist')
  const zipName = artifactName
    .replaceAll('${version}', version)
    .replaceAll('${os}', OS)
    .replaceAll('${arch}', ARCH)
    .replaceAll('${ext}', 'zip')
  const zipPath = resolve(outputPath, zipName)
  const manifestPath = resolve(outputPath, `mac-${mode}-manifest.json`)
  const builderArgs = [builderCli, '--mac', `--${ARCH}`, '--dir', '--publish', 'never']

  let commands
  if (mode === 'dogfood') {
    commands = [
      { command: 'npm', args: ['run', 'build'] },
      {
        command: nodePath,
        args: [
          ...builderArgs,
          '--config.mac.identity=null',
          '--config.mac.hardenedRuntime=false',
          '--config.mac.entitlements=null',
          '--config.mac.entitlementsInherit=null'
        ],
        env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
      },
      { command: 'codesign', args: ['--force', '--deep', '--sign', '-', appPath] },
      { command: 'codesign', args: ['--verify', '--deep', '--strict', appPath] },
      { command: 'lipo', args: [executablePath, '-verify_arch', ARCH] },
      { command: 'ditto', args: ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath] }
    ]
  } else {
    const { identity, notarizationProfile } = requireReleaseCredentials(credentials)
    commands = [
      { command: 'npm', args: ['run', 'build'] },
      {
        command: nodePath,
        args: [
          ...builderArgs,
          `--config.mac.identity=${identity}`,
          '--config.mac.hardenedRuntime=true',
          `--config.mac.entitlements=${entitlementsPath}`,
          `--config.mac.entitlementsInherit=${entitlementsPath}`
        ],
        env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
      },
      {
        command: 'codesign',
        args: ['--force', '--options', 'runtime', '--entitlements', entitlementsPath, '--sign', identity, appPath]
      },
      { command: 'codesign', args: ['--verify', '--deep', '--strict', '--verbose=2', appPath] },
      {
        command: 'codesign',
        args: ['-d', '--verbose=4', appPath],
        expectedOutput: /flags=.*runtime/i
      },
      { command: 'lipo', args: [executablePath, '-verify_arch', ARCH] },
      { command: 'ditto', args: ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath] },
      {
        command: 'xcrun',
        args: [
          'notarytool', 'submit', zipPath, '--keychain-profile', notarizationProfile,
          '--wait', '--output-format', 'json'
        ],
        expectedOutput: /"status"\s*:\s*"Accepted"/i,
        redactAfter: '--keychain-profile'
      },
      { command: 'xcrun', args: ['stapler', 'staple', appPath] },
      { command: 'xcrun', args: ['stapler', 'validate', appPath] },
      { command: 'spctl', args: ['--assess', '--type', 'execute', '--verbose=2', appPath] },
      { command: 'rm', args: ['-f', zipPath] },
      { command: 'ditto', args: ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath] }
    ]
  }

  return {
    appPath,
    executablePath,
    manifestPath,
    mode,
    outputPath,
    productName,
    zipPath,
    commands
  }
}

export function createZipVerificationCommands(plan, extractionDirectory) {
  const extractedAppPath = join(extractionDirectory, basename(plan.appPath))
  const extractedExecutablePath = join(
    extractedAppPath,
    'Contents',
    'MacOS',
    basename(plan.executablePath)
  )
  const commands = [
    { command: 'ditto', args: ['-x', '-k', plan.zipPath, extractionDirectory] },
    {
      command: 'codesign',
      args: plan.mode === 'release'
        ? ['--verify', '--deep', '--strict', '--verbose=2', extractedAppPath]
        : ['--verify', '--deep', '--strict', extractedAppPath]
    }
  ]

  if (plan.mode === 'release') {
    commands.push(
      { command: 'xcrun', args: ['stapler', 'validate', extractedAppPath] },
      { command: 'spctl', args: ['--assess', '--type', 'execute', '--verbose=2', extractedAppPath] }
    )
  }
  commands.push({ command: 'lipo', args: [extractedExecutablePath, '-verify_arch', ARCH] })
  return commands
}

function redactedArgs(args, marker) {
  const safe = [...args]
  const index = marker ? safe.indexOf(marker) : -1
  if (index >= 0 && index + 1 < safe.length) safe[index + 1] = '<redacted>'
  return safe
}

export function runCommand({ command, args, env, expectedOutput, redactAfter }, cwd, spawn = spawnSync) {
  console.log(`> ${JSON.stringify([command, ...redactedArgs(args, redactAfter)])}`)
  const captureOutput = expectedOutput instanceof RegExp
  const result = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: captureOutput ? 'utf8' : undefined,
    stdio: captureOutput ? 'pipe' : 'inherit'
  })

  if (captureOutput) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
  if (result.error) throw new Error(`Failed to start ${command}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`)
  if (captureOutput && !expectedOutput.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) {
    throw new Error(`${command} output did not confirm the required packaging result`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function captureCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: process.env, encoding: 'utf8' })
  if (result.error) throw new Error(`Failed to start ${command}: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${command} credential preflight failed; verify the configured keychain identity/profile`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

async function requireArtifact(path, kind) {
  let details
  try {
    details = await stat(path)
  } catch (error) {
    throw new Error(`Missing ${kind}: ${path}`, { cause: error })
  }

  if (kind === 'app' && !details.isDirectory()) throw new Error(`Expected app directory at ${path}`)
  if (kind === 'ZIP' && (!details.isFile() || details.size === 0)) {
    throw new Error(`Expected non-empty ZIP file at ${path}`)
  }
  return details
}

export async function packageMac(mode, env = process.env) {
  if (process.platform !== 'darwin') {
    throw new Error(`macOS packaging requires darwin; received ${process.platform}`)
  }

  const root = resolve(import.meta.dirname, '..')
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const repoRoot = resolve(root, '../..')
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const gitStatus = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  if (gitStatus) {
    throw new Error('Refusing to package from a dirty worktree. Commit the reviewed snapshot first.')
  }

  const credentials = mode === 'release'
    ? verifyReleaseCredentials(
        {
          identity: env.HERMES_MACOS_SIGNING_IDENTITY,
          notarizationProfile: env.HERMES_MACOS_NOTARIZATION_PROFILE
        },
        (command, args) => captureCommand(command, args, root)
      )
    : undefined
  const require = createRequire(import.meta.url)
  const builderCli = require.resolve('electron-builder/cli.js')
  const plan = createPackagingPlan({
    mode,
    credentials,
    root,
    packageJson,
    nodePath: process.execPath,
    builderCli
  })

  await mkdir(plan.outputPath, { recursive: true })
  await Promise.all([
    rm(resolve(root, 'dist'), { force: true, recursive: true }),
    rm(plan.appPath, { force: true, recursive: true }),
    rm(plan.zipPath, { force: true }),
    rm(plan.manifestPath, { force: true })
  ])

  runCommand(plan.commands[0], root)
  runCommand(plan.commands[1], root)
  await requireArtifact(plan.appPath, 'app')
  const asarPath = resolve(plan.appPath, 'Contents', 'Resources', 'app.asar')
  const asarEntries = listPackage(asarPath)
  assertAsarContents(asarEntries)
  assertPackagedRenderer(asarEntries)
  const packagedAt = new Date().toISOString()
  const installStamp = createInstallStamp(packageJson, gitCommit, packagedAt)
  await writeFile(
    resolve(plan.appPath, 'Contents', 'Resources', 'install-stamp.json'),
    `${JSON.stringify(installStamp, null, 2)}\n`,
    { mode: 0o644 }
  )

  for (const command of plan.commands.slice(2)) runCommand(command, root)
  const zipDetails = await requireArtifact(plan.zipPath, 'ZIP')

  const verificationDirectory = await mkdtemp(join(tmpdir(), 'hermes-companion-zip-'))
  try {
    const verificationCommands = createZipVerificationCommands(plan, verificationDirectory)
    runCommand(verificationCommands[0], root)
    await requireArtifact(join(verificationDirectory, basename(plan.appPath)), 'app')
    for (const command of verificationCommands.slice(1)) runCommand(command, root)
  } finally {
    await rm(verificationDirectory, { force: true, recursive: true })
  }

  const zipBytes = await readFile(plan.zipPath)
  const manifest = createPackageManifest({
    mode,
    packageJson,
    gitCommit,
    packagedAt,
    artifact: basename(plan.zipPath),
    bytes: zipDetails.size,
    sha256: createHash('sha256').update(zipBytes).digest('hex')
  })
  await writeFile(plan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  console.log(JSON.stringify(manifest, null, 2))
  console.log(`Packaged app: ${plan.appPath}`)
  console.log(`Packaged ZIP: ${plan.zipPath}`)
  console.log(`Package manifest: ${plan.manifestPath}`)
  return plan
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  packageMac(process.argv[2]).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
