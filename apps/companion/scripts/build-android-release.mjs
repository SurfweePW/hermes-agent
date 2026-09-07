import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(appRoot, '../..')
const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()
if (status) {
  throw new Error('Refusing to build a release from a dirty worktree. Commit the reviewed snapshot first.')
}

const keystore = process.env.HERMES_COMPANION_ANDROID_KEYSTORE
const keyAlias = process.env.HERMES_COMPANION_ANDROID_KEY_ALIAS ?? 'hermes-companion-release'
const keychainService = process.env.HERMES_COMPANION_ANDROID_KEYCHAIN_SERVICE ?? 'hermes-companion-android-release'
const keychainAccount = process.env.HERMES_COMPANION_ANDROID_KEYCHAIN_ACCOUNT ?? 'release-keystore'

if (!keystore) {
  throw new Error('HERMES_COMPANION_ANDROID_KEYSTORE is required.')
}

const keychainPassword = () => execFileSync(
  'security',
  ['find-generic-password', '-s', keychainService, '-a', keychainAccount, '-w'],
  { encoding: 'utf8' },
).trim()
const storePassword = process.env.HERMES_COMPANION_ANDROID_STORE_PASSWORD ?? keychainPassword()
const keyPassword = process.env.HERMES_COMPANION_ANDROID_KEY_PASSWORD ?? storePassword
const env = {
  ...process.env,
  HERMES_COMPANION_ANDROID_KEYSTORE: resolve(keystore.replace(/^~(?=\/)/, homedir())),
  HERMES_COMPANION_ANDROID_STORE_PASSWORD: storePassword,
  HERMES_COMPANION_ANDROID_KEY_ALIAS: keyAlias,
  HERMES_COMPANION_ANDROID_KEY_PASSWORD: keyPassword,
  HERMES_COMPANION_GIT_COMMIT: commit,
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`)
  }
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || '')
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

run('npm', ['run', 'android:sync'], appRoot)
run('./gradlew', ['--no-daemon', 'clean', 'testDebugUnitTest', 'lintRelease', 'assembleRelease'], join(appRoot, 'android'))

const built = join(appRoot, 'android/app/build/outputs/apk/release/app-release.apk')
const releaseDir = join(appRoot, 'release')
const artifact = join(releaseDir, `Hermes-Companion-${pkg.version}-android-release.apk`)
mkdirSync(releaseDir, { recursive: true })
copyFileSync(built, artifact)
const bytes = readFileSync(artifact)
const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
if (!androidHome) { throw new Error('ANDROID_HOME or ANDROID_SDK_ROOT is required for release verification.') }
const buildTools = readdirSync(join(androidHome, 'build-tools'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0]
if (!buildTools) { throw new Error('No Android build-tools installation was found.') }
const tool = (name) => join(androidHome, 'build-tools', buildTools, name)
const signerReport = capture(tool('apksigner'), ['verify', '--verbose', '--print-certs', artifact], appRoot)
capture(tool('zipalign'), ['-c', '-v', '4', artifact], appRoot)
const badging = capture(tool('aapt'), ['dump', 'badging', artifact], appRoot)
const permissionReport = capture(tool('aapt'), ['dump', 'permissions', artifact], appRoot)
const packageMatch = badging.match(/^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m)
const launchMatch = badging.match(/^launchable-activity: name='([^']+)'/m)
const signerMatch = signerReport.match(/Signer #1 certificate SHA-256 digest: ([0-9a-f]+)/i)
if (!packageMatch || packageMatch[1] !== 'com.hermes.companion' || packageMatch[3] !== pkg.version || !launchMatch || !signerMatch) {
  throw new Error('Release APK metadata or signing identity could not be verified.')
}
const permissions = [...permissionReport.matchAll(/uses-permission: name='([^']+)'/g)].map((match) => match[1]).sort()
const manifest = {
  product: pkg.productName,
  packageName: packageMatch[1],
  version: packageMatch[3],
  versionCode: Number(packageMatch[2]),
  launchableActivity: launchMatch[1],
  gitCommit: commit,
  sourceCommit: commit,
  dirty: false,
  artifact: artifact.split('/').at(-1),
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  signing: 'private release keystore',
  signerCertificateSha256: signerMatch[1].toLowerCase(),
  zipAligned: true,
  permissions,
}
writeFileSync(join(releaseDir, 'android-release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
console.log(JSON.stringify(manifest, null, 2))
