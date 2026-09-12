import { describe, expect, it, vi } from 'vitest'

import { createSessionDraftStore, DRAFTS_STORAGE_KEY, type PersistedSessionDraftIdentity, type SessionDraftIdentity } from './session-drafts'

function memoryStorage(initial = new Map<string, string>()) {
  return {
    values: initial,
    storage: {
      getItem: (key: string) => initial.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => { initial.set(key, value) }),
      removeItem: vi.fn((key: string) => { initial.delete(key) })
    }
  }
}

const identity = (change: Partial<PersistedSessionDraftIdentity> = {}): SessionDraftIdentity => ({
  backendNamespace: 'desktop-a',
  profile: 'atlas',
  sessionId: 'logical-a',
  sessionKind: 'stored',
  ...change
})

describe('session drafts', () => {
  it('persists A → B → A drafts and isolates every identity component across restarts', () => {
    const { storage } = memoryStorage()
    const drafts = createSessionDraftStore(storage)
    const a = identity()

    const variants = [
      identity({ sessionId: 'logical-b' }),
      identity({ profile: 'mentor' }),
      identity({ backendNamespace: 'desktop-b' }),
      identity({ sessionKind: 'runtime' })
    ]

    drafts.set(a, 'draft A')
    variants.forEach((item, index) => drafts.set(item, `isolated ${index}`))

    const restarted = createSessionDraftStore(storage)
    expect(restarted.get(a)).toBe('draft A')
    expect(variants.map((item) => restarted.get(item))).toEqual([
      'isolated 0', 'isolated 1', 'isolated 2', 'isolated 3'
    ])
  })

  it('removes empty drafts and clears all identity-bound plaintext', () => {
    const { values, storage } = memoryStorage()
    const drafts = createSessionDraftStore(storage)

    drafts.set(identity(), 'private A')
    drafts.set(identity({ profile: 'mentor' }), 'private B')
    drafts.set(identity(), '')
    expect(drafts.get(identity())).toBe('')
    expect(values.get(DRAFTS_STORAGE_KEY)).not.toContain('private A')

    drafts.clear()
    expect(values.has(DRAFTS_STORAGE_KEY)).toBe(false)
    expect(drafts.get(identity({ profile: 'mentor' }))).toBe('')
  })

  it('fails closed and purges malformed or oversized persisted input', () => {
    const empty = memoryStorage(new Map([[DRAFTS_STORAGE_KEY, '']]))
    expect(createSessionDraftStore(empty.storage).get(identity())).toBe('')
    expect(empty.values.has(DRAFTS_STORAGE_KEY)).toBe(false)

    const malformed = memoryStorage(new Map([[DRAFTS_STORAGE_KEY, '{not-json']]))
    expect(createSessionDraftStore(malformed.storage).get(identity())).toBe('')
    expect(malformed.values.has(DRAFTS_STORAGE_KEY)).toBe(false)

    const oversized = memoryStorage(new Map([[DRAFTS_STORAGE_KEY, 'x'.repeat(4_000_001)]]))
    expect(createSessionDraftStore(oversized.storage).get(identity())).toBe('')
    expect(oversized.values.has(DRAFTS_STORAGE_KEY)).toBe(false)
  })

  it('surfaces an unpurgeable malformed restart without loading its plaintext', () => {
    const values = new Map([[DRAFTS_STORAGE_KEY, '{private malformed plaintext']])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => { throw new Error('write blocked') },
      removeItem: () => { throw new Error('remove blocked') }
    }

    const drafts = createSessionDraftStore(storage)

    expect(drafts.get(identity())).toBe('')
    expect(drafts.hasPersistenceFailure()).toBe(true)
    expect(drafts.hasUnsafePlaintext()).toBe(true)
    expect(values.get(DRAFTS_STORAGE_KEY)).toBe('{private malformed plaintext')
  })

  it('purges the whole persisted payload when any entry is not a valid bounded draft identity', () => {
    const validKey = JSON.stringify(['desktop-a', 'atlas', 'stored', 'logical-a'])
    const invalid = memoryStorage(new Map([[DRAFTS_STORAGE_KEY, JSON.stringify({
      [validKey]: 'private valid-looking draft',
      'not-an-identity': 'private invalid draft'
    })]]))

    const drafts = createSessionDraftStore(invalid.storage)

    expect(drafts.get(identity())).toBe('')
    expect(invalid.values.has(DRAFTS_STORAGE_KEY)).toBe(false)
  })

  it('keeps the durable payload bounded while retaining the newest drafts', () => {
    const { values, storage } = memoryStorage()
    const drafts = createSessionDraftStore(storage)

    for (let index = 0; index < 110; index += 1) {
      drafts.set(identity({ sessionId: `logical-${index}` }), index < 5 ? 'x'.repeat(999_999) : `draft ${index}`)
    }

    const persisted = values.get(DRAFTS_STORAGE_KEY)!
    expect(persisted.length).toBeLessThanOrEqual(4_000_000)
    expect(Object.keys(JSON.parse(persisted))).toHaveLength(100)
    expect(drafts.get(identity({ sessionId: 'logical-0' }))).toBe('')
    expect(drafts.get(identity({ sessionId: 'logical-109' }))).toBe('draft 109')
  })

  it('moves an updated draft to the newest end before bounded eviction', () => {
    const { storage } = memoryStorage()
    const drafts = createSessionDraftStore(storage)

    for (let index = 0; index < 100; index += 1) {
      drafts.set(identity({ sessionId: `logical-${index}` }), `draft ${index}`)
    }

    drafts.set(identity({ sessionId: 'logical-0' }), 'updated')
    drafts.set(identity({ sessionId: 'logical-100' }), 'newest')

    expect(drafts.get(identity({ sessionId: 'logical-0' }))).toBe('updated')
    expect(drafts.get(identity({ sessionId: 'logical-1' }))).toBe('')
  })

  it('purges stale plaintext when storage rejects a draft write', () => {
    const values = new Map<string, string>()
    let rejectWrites = false

    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (rejectWrites) {throw new Error('quota')}
        values.set(key, value)
      },
      removeItem: (key: string) => { values.delete(key) }
    }

    const drafts = createSessionDraftStore(storage)

    drafts.set(identity(), 'stale private plaintext')
    rejectWrites = true

    expect(() => drafts.set(identity(), 'memory only')).not.toThrow()
    expect(values.has(DRAFTS_STORAGE_KEY)).toBe(false)
    expect([...values.values()].join('')).not.toContain('stale private plaintext')
    expect(drafts.get(identity())).toBe('memory only')
  })

  it('reads writes back and purges stale plaintext when storage silently ignores them', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => undefined,
      removeItem: (key: string) => { values.delete(key) }
    }
    values.set(DRAFTS_STORAGE_KEY, JSON.stringify({
      [JSON.stringify(['desktop-a', 'atlas', 'stored', 'logical-a'])]: 'stale private plaintext'
    }))
    const drafts = createSessionDraftStore(storage)

    expect(() => drafts.set(identity(), 'replacement')).not.toThrow()
    expect(values.has(DRAFTS_STORAGE_KEY)).toBe(false)
    expect(drafts.get(identity())).toBe('replacement')
  })

  it('reports a silent purge failure after verifying both deletion paths', () => {
    const stale = JSON.stringify({
      [JSON.stringify(['desktop-a', 'atlas', 'stored', 'logical-a'])]: 'stale private plaintext'
    })
    const values = new Map([[DRAFTS_STORAGE_KEY, stale]])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => undefined,
      removeItem: () => undefined
    }

    const drafts = createSessionDraftStore(storage)

    expect(() => drafts.clear()).toThrowError('Draft plaintext could not be purged.')
    expect(values.get(DRAFTS_STORAGE_KEY)).toBe(stale)
  })

  it('reports when stale plaintext cannot be purged after a rejected write', () => {
    const values = new Map<string, string>()
    let rejectStorage = false

    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (rejectStorage) {throw new Error('write blocked')}
        values.set(key, value)
      },
      removeItem: (key: string) => {
        if (rejectStorage) {throw new Error('remove blocked')}
        values.delete(key)
      }
    }

    const drafts = createSessionDraftStore(storage)

    drafts.set(identity(), 'stale private plaintext')
    rejectStorage = true

    expect(() => drafts.set(identity(), 'memory only')).toThrowError(
      'Draft persistence failed and stale plaintext could not be purged.'
    )
    expect(values.get(DRAFTS_STORAGE_KEY)).toContain('stale private plaintext')
  })

  it('falls back to an empty atomic payload when removeItem fails during clear', () => {
    const values = new Map<string, string>()

    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: () => { throw new Error('remove unavailable') }
    }

    const drafts = createSessionDraftStore(storage)
    drafts.set(identity(), 'private')

    expect(() => drafts.clear()).not.toThrow()
    expect(values.get(DRAFTS_STORAGE_KEY)).toBe('{}')
    expect(createSessionDraftStore(storage).get(identity())).toBe('')
  })

  it('rejects unbounded identity keys without touching storage', () => {
    const { storage } = memoryStorage()
    const drafts = createSessionDraftStore(storage)
    const unbounded = identity({ sessionId: 'x'.repeat(16_384) })

    drafts.set(unbounded, 'private')

    expect(storage.setItem).not.toHaveBeenCalled()
    expect(drafts.get(unbounded)).toBe('')
  })

  it('rejects malformed writer identities without touching storage', () => {
    const { storage } = memoryStorage()
    const drafts = createSessionDraftStore(storage)

    const malformed = [
      identity({ backendNamespace: '' }),
      identity({ profile: '' }),
      identity({ sessionId: '' }),
      { ...identity(), sessionKind: 'ephemeral' },
      { ...identity(), profile: 7 },
      null,
      undefined
    ] as unknown as SessionDraftIdentity[]

    malformed.forEach((item) => drafts.set(item, 'private'))

    expect(storage.setItem).not.toHaveBeenCalled()
    expect(malformed.map((item) => drafts.get(item))).toEqual(['', '', '', '', '', '', ''])
  })

  it('retains a bounded prefix when JSON escaping expands a draft beyond the serialized budget', () => {
    const { values, storage } = memoryStorage()
    const drafts = createSessionDraftStore(storage)
    const escapeHeavy = '\u0000'.repeat(1_000_000)

    drafts.set(identity(), escapeHeavy)

    const persisted = values.get(DRAFTS_STORAGE_KEY)!
    const retained = drafts.get(identity())
    expect(persisted.length).toBeLessThanOrEqual(4_000_000)
    expect(retained.length).toBeGreaterThan(0)
    expect(retained.length).toBeLessThan(escapeHeavy.length)
    expect(escapeHeavy.startsWith(retained)).toBe(true)
    expect(createSessionDraftStore(storage).get(identity())).toBe(retained)
  })

  it('partitions local new-session drafts by owner, backend, UUID, profile, project-null, and revision', () => {
    const { storage } = memoryStorage()
    const drafts = createSessionDraftStore(storage)
    const first = {
      ownerScope: 'owner:https://gateway.test', backendNamespace: 'desktop:mini',
      profile: 'atlas', projectId: null, sessionKind: 'local' as const,
      sessionId: '11111111-1111-4111-8111-111111111111', revision: 1
    }
    const edited = { ...first, revision: 2 }
    const anotherOwner = { ...edited, ownerScope: 'owner:https://other.test' }

    expect(drafts.set(first, 'first revision')).toBe(true)
    expect(drafts.rekey(first, edited, 'second revision')).toBe(true)
    expect(drafts.get(first)).toBe('')
    expect(drafts.get(edited)).toBe('second revision')
    expect(drafts.get(anotherOwner)).toBe('')
  })
})
