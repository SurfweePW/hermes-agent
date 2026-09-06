import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { GatewayTokenStore, SecureStorageError } from './secure-store'

const TOKEN = 'unit-test-placeholder-value'

function directory(): string {
  return mkdtempSync(join(tmpdir(), 'companion-secure-store-'))
}

const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from([...value].reverse().join(''), 'utf8'),
  decryptString: (value: Buffer) => {
    const decoded = value.toString('utf8')

    if (decoded === 'corrupt') { throw new Error('invalid ciphertext') }

    return [...decoded].reverse().join('')
  }
}

describe('GatewayTokenStore', () => {
  it('round trips through encryption without writing plaintext', () => {
    const userData = directory()
    const store = new GatewayTokenStore(userData, crypto)

    store.set(TOKEN)

    expect(store.get()).toBe(TOKEN)
    expect(readFileSync(store.filePath).toString('utf8')).not.toContain(TOKEN)
    expect(statSync(store.filePath).mode & 0o777).toBe(0o600)
  })

  it('fails closed when platform encryption is unavailable', () => {
    const store = new GatewayTokenStore(directory(), {
      ...crypto,
      isEncryptionAvailable: () => false
    })

    expect(() => store.set(TOKEN)).toThrow(SecureStorageError)
    writeFileSync(store.filePath, 'ciphertext', { mode: 0o600 })
    expect(() => store.get()).toThrow(SecureStorageError)
  })

  it('does not touch platform encryption on a clean first launch', () => {
    const isEncryptionAvailable = vi.fn(() => { throw new Error('unexpected Keychain access') })
    const store = new GatewayTokenStore(directory(), { ...crypto, isEncryptionAvailable })

    expect(store.get()).toBeUndefined()
    expect(isEncryptionAvailable).not.toHaveBeenCalled()
  })

  it('fails closed for corrupt ciphertext', () => {
    const userData = directory()
    const store = new GatewayTokenStore(userData, crypto)
    store.set(TOKEN)
    writeFileSync(store.filePath, 'corrupt', { mode: 0o600 })

    expect(() => store.get()).toThrow(SecureStorageError)
  })

  it('removes the encrypted blob only on explicit reset', () => {
    const store = new GatewayTokenStore(directory(), crypto)
    store.set(TOKEN)
    store.reset()
    expect(store.get()).toBeUndefined()
  })

  it('rejects a symlinked secure-storage directory', () => {
    const parent = directory()
    const actual = join(parent, 'actual')
    const linked = join(parent, 'linked')
    mkdirSync(actual)
    symlinkSync(actual, linked, 'dir')

    const store = new GatewayTokenStore(linked, crypto)
    expect(() => store.set(TOKEN)).toThrow(SecureStorageError)
  })
})
