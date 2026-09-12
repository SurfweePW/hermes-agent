import { describe, expect, it } from 'vitest'

import { createSessionOperationRetryStore, type CreationRetryEntry, RETRIES_STORAGE_KEY } from './session-operation-retries'

function retry(index: number): CreationRetryEntry {
  return {
    version: 2,
    operationKind: 'create',
    ownerScope: 'owner-account-a',
    backendNamespace: 'backend-a',
    profile: 'atlas',
    projectId: null,
    draftId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    draftRevision: 1,
    clientRequestId: `10000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    messageSha256: 'a'.repeat(64),
    storedSessionId: null,
    operationStatus: 'uncertain'
  }
}

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()

  if (initial !== undefined) {values.set(RETRIES_STORAGE_KEY, initial)}

  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {values.set(key, value)},
      removeItem: (key: string) => {values.delete(key)}
    }
  }
}

describe('session operation retry ledger', () => {
  it('refuses a new send at 100 entries without dropping unresolved retries', () => {
    const { storage, values } = memoryStorage()
    const store = createSessionOperationRetryStore(storage)

    for (let index = 0; index < 100; index += 1) {store.put(retry(index))}
    const persistedAtLimit = values.get(RETRIES_STORAGE_KEY)

    expect(() => store.put(retry(100))).toThrow('Retry ledger is full')
    expect(store.list('owner-account-a', 'backend-a')).toHaveLength(100)
    expect(values.get(RETRIES_STORAGE_KEY)).toBe(persistedAtLimit)
    expect(createSessionOperationRetryStore(storage).list('owner-account-a', 'backend-a')).toHaveLength(100)
  })

  it('quarantines an over-limit ledger without deleting its unresolved metadata', () => {
    const persisted = JSON.stringify(Array.from({ length: 101 }, (_, index) => retry(index)))
    const { storage, values } = memoryStorage(persisted)
    const store = createSessionOperationRetryStore(storage)

    expect(store.list('owner-account-a', 'backend-a')).toEqual([])
    expect(() => store.put(retry(101))).toThrow(/quarantined/i)
    expect(values.get(RETRIES_STORAGE_KEY)).toBe(persisted)
  })
})
