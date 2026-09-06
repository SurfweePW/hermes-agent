import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export class SecureStorageError extends Error {
  constructor() {
    super('Companion secure storage is unavailable.')
    this.name = 'SecureStorageError'
  }
}

export class GatewayTokenStore {
  readonly filePath: string
  private readonly safeStorage: SafeStorageAdapter

  constructor(userDataDirectory: string, safeStorage: SafeStorageAdapter, fileName: 'gateway-token.encrypted' | 'owner-session.encrypted' = 'gateway-token.encrypted') {
    this.filePath = join(userDataDirectory, fileName)
    this.safeStorage = safeStorage
  }

  get(): string | undefined {
    if (!this.safeStorage.isEncryptionAvailable()) { throw new SecureStorageError() }

    if (!existsSync(this.filePath)) { return undefined }

    try {
      const token = this.safeStorage.decryptString(readFileSync(this.filePath))

      if (typeof token !== 'string' || token.length === 0) { throw new Error('invalid result') }

      return token
    } catch {
      throw new SecureStorageError()
    }
  }

  set(token: string): void {
    if (typeof token !== 'string' || token.length === 0 || !this.safeStorage.isEncryptionAvailable()) {
      throw new SecureStorageError()
    }

    let encrypted: Buffer

    try {
      encrypted = this.safeStorage.encryptString(token)

      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) { throw new Error('invalid result') }
    } catch {
      throw new SecureStorageError()
    }

    const directory = dirname(this.filePath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const directoryStat = lstatSync(directory)

    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) { throw new SecureStorageError() }
    chmodSync(directory, 0o700)
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    let descriptor: number | undefined

    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600)
      writeFileSync(descriptor, encrypted)
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporaryPath, this.filePath)
      chmodSync(this.filePath, 0o600)
      const directoryDescriptor = openSync(directory, 'r')

      try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
    } catch {
      if (descriptor !== undefined) { closeSync(descriptor) }
      rmSync(temporaryPath, { force: true })
      throw new SecureStorageError()
    }
  }

  reset(): void {
    rmSync(this.filePath, { force: true })
  }
}
