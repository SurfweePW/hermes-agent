import { afterEach, describe, expect, it } from 'vitest'

import { createDefaultSecretStore } from './secret-store'

const originalBridge = window.hermesCompanion

afterEach(() => {
  if (originalBridge) {
    window.hermesCompanion = originalBridge
  } else {
    delete window.hermesCompanion
  }
})

describe('native secret store adapter', () => {
  it('selects native storage when the Companion preload is available', async () => {
    let persisted = 'persisted-value'
    window.hermesCompanion = {
      gatewayToken: {
        get: async () => persisted,
        set: async (value) => { persisted = value },
        reset: async () => { persisted = undefined as unknown as string }
      }
    }

    const store = createDefaultSecretStore()
    await expect(store.get('gateway-token')).resolves.toBe('persisted-value')
    await store.set('gateway-token', 'next-value')
    expect(persisted).toBe('next-value')
  })

  it('does not erase the persistent token during ephemeral lifecycle clear', async () => {
    let resetCount = 0
    window.hermesCompanion = {
      gatewayToken: {
        get: async () => 'persisted-value',
        set: async () => undefined,
        reset: async () => { resetCount += 1 }
      }
    }

    const store = createDefaultSecretStore()
    store.clear()
    expect(resetCount).toBe(0)
    await store.delete('gateway-token')
    expect(resetCount).toBe(1)
  })

  it('keeps browser fixtures session-only when no native bridge exists', () => {
    delete window.hermesCompanion
    const first = createDefaultSecretStore()
    const second = createDefaultSecretStore()
    first.set('gateway-token', 'session-value')
    expect(second.get('gateway-token')).toBeUndefined()
  })
})
