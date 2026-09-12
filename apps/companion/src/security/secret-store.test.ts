import { describe, expect, it } from 'vitest'

import { createSessionSecretStore } from './secret-store'

describe('session secret store', () => {
  it('keeps secrets in the current store instance only', () => {
    const first = createSessionSecretStore()
    const second = createSessionSecretStore()

    first.set('gateway-token', 'session-only-token')

    expect(first.get('gateway-token')).toBe('session-only-token')
    expect(second.get('gateway-token')).toBeUndefined()
  })

  it('clears individual secrets and all session secrets', () => {
    const store = createSessionSecretStore()
    store.set('gateway-token', 'one')
    store.set('other', 'two')

    store.delete('gateway-token')
    expect(store.get('gateway-token')).toBeUndefined()
    expect(store.get('other')).toBe('two')

    store.clear()
    expect(store.get('other')).toBeUndefined()
  })

  it('rejects empty secret names and values', () => {
    const store = createSessionSecretStore()

    expect(() => store.set('', 'token')).toThrow(/name/i)
    expect(() => store.set('gateway-token', '')).toThrow(/value/i)
  })

  it('does not expose secret values through serialization or string coercion', () => {
    const store = createSessionSecretStore()
    store.set('gateway-token', 'never-serialize-me')

    expect(JSON.stringify(store)).toBe('{}')
    expect(String(store)).toBe('[SessionSecretStore]')
    expect(JSON.stringify(store)).not.toContain('never-serialize-me')
  })

  it('revokes browser session secrets idempotently', async () => {
    const store = createSessionSecretStore()
    store.set('gateway-token', 'session-only-token')

    await store.revoke('gateway-token')
    await store.revoke('gateway-token')

    expect(store.get('gateway-token')).toBeUndefined()
  })
})
