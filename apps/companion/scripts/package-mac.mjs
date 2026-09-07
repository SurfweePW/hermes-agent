import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { listPackage } from '@electron/asar'

const ARCH = 'arm64'
const OS = 'mac'

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
    product: requireString(packageJson.productName, 'productName'),
    version: requireString(packageJson.version, 'version'),
    gitCommit: dirty ? `${gitCommit}-dirty` : gitCommit,
    sourceCommit: gitCommit,
    dirty,
    packagedAt
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`package.json ${field} must be a non-empty string`)
  }
  return value
}

export function createPackagingPlan({ root, packageJson, nodePath, builderCli }) {
  const productName = requireString(packageJson.productName, 'productName')
  const version = requireString(packageJson.version, 'version')
  const artifactName = requireString(packageJson.build?.artifactName, 'build.artifactName')
  const outputDirectory = requireString(packageJson.build?.directories?.output, 'build.directories.output')
  const executableName = requireString(packageJson.build?.executableName, 'build.executableName')

  const outputPath = resolve(root, outputDirectory)
  const appPath = resolve(outputPath, `mac-${ARCH}`, `${productName}.app`)
  const executablePath = resolve(appPath, 'Contents', 'MacOS', executableName)
  const zipName = artifactName
    .replaceAll('${version}', version)
    .replaceAll('${os}', OS)
    .replaceAll('${arch}', ARCH)
    .replaceAll('${ext}', 'zip')
  const zipPath = resolve(outputPath, zipName)

  return {
    appPath,
    executablePath,
    outputPath,
    productName,
    zipPath,
    commands: [
      { command: 'npm', args: ['run', 'build'] },
      {
        command: nodePath,
        args: [builderCli, '--mac', `--${ARCH}`, '--dir', '--publish', 'never']
      },
      { command: 'codesign', args: ['--force', '--deep', '--sign', '-', appPath] },
      { command: 'codesign', args: ['--verify', '--deep', '--strict', appPath] },
      { command: 'lipo', args: [executablePath, '-verify_arch', ARCH] },
      {
        command: 'ditto',
        args: ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath]
      }
    ]
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

  return [
    { command: 'ditto', args: ['-x', '-k', plan.zipPath, extractionDirectory] },
    { command: 'codesign', args: ['--verify', '--deep', '--strict', extractedAppPath] },
    { command: 'lipo', args: [extractedExecutablePath, '-verify_arch', ARCH] }
  ]
}

function run({ command, args }, cwd) {
  console.log(`> ${JSON.stringify([command, ...args])}`)
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit'
  })

  if (result.error) {
    throw new Error(`Failed to start ${command}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`)
  }
}

async function requireArtifact(path, kind) {
  let details
  try {
    details = await stat(path)
  } catch (error) {
    throw new Error(`Missing ${kind}: ${path}`, { cause: error })
  }

  if (kind === 'app' && !details.isDirectory()) {
    throw new Error(`Expected app directory at ${path}`)
  }
  if (kind === 'ZIP' && (!details.isFile() || details.size === 0)) {
    throw new Error(`Expected non-empty ZIP file at ${path}`)
  }
}

export async function packageMac() {
  if (process.platform !== 'darwin') {
    throw new Error(`macOS packaging requires darwin; received ${process.platform}`)
  }

  const root = resolve(import.meta.dirname, '..')
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const repoRoot = resolve(root, '../..')
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const gitStatus = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const dirty = Boolean(gitStatus)
  if (dirty) {
    throw new Error('Refusing to package a release from a dirty worktree. Commit the reviewed snapshot first.')
  }
  const require = createRequire(import.meta.url)
  const builderCli = require.resolve('electron-builder/cli.js')
  const plan = createPackagingPlan({
    root,
    packageJson,
    nodePath: process.execPath,
    builderCli
  })

  await mkdir(plan.outputPath, { recursive: true })
  await Promise.all([
    rm(resolve(root, 'dist'), { force: true, recursive: true }),
    rm(plan.appPath, { force: true, recursive: true }),
    rm(plan.zipPath, { force: true })
  ])

  run(plan.commands[0], root)
  run(plan.commands[1], root)
  await requireArtifact(plan.appPath, 'app')
  const asarPath = resolve(plan.appPath, 'Contents', 'Resources', 'app.asar')
  const asarEntries = listPackage(asarPath)
  assertAsarContents(asarEntries)
  assertPackagedRenderer(asarEntries)
  const installStamp = createInstallStamp(packageJson, gitCommit, new Date().toISOString(), dirty)
  await writeFile(
    resolve(plan.appPath, 'Contents', 'Resources', 'install-stamp.json'),
    `${JSON.stringify(installStamp, null, 2)}\n`,
    { mode: 0o644 }
  )
  run(plan.commands[2], root)
  run(plan.commands[3], root)
  run(plan.commands[4], root)
  run(plan.commands[5], root)
  await requireArtifact(plan.zipPath, 'ZIP')

  const verificationDirectory = await mkdtemp(join(tmpdir(), 'hermes-companion-zip-'))
  try {
    const verificationCommands = createZipVerificationCommands(plan, verificationDirectory)
    run(verificationCommands[0], root)
    await requireArtifact(join(verificationDirectory, basename(plan.appPath)), 'app')
    run(verificationCommands[1], root)
    run(verificationCommands[2], root)
  } finally {
    await rm(verificationDirectory, { force: true, recursive: true })
  }

  console.log(`Packaged app: ${plan.appPath}`)
  console.log(`Packaged ZIP: ${plan.zipPath}`)
  return plan
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  packageMac().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
