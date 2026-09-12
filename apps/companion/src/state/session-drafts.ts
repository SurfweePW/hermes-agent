export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

export interface SessionDraftIdentity {
  backendNamespace: string
  profile: string
  sessionId: string
  sessionKind: 'stored' | 'runtime'
}

const DRAFTS_STORAGE_KEY = 'hermes.companion.sessionDrafts.v1'
const MAX_DRAFT_LENGTH = 1_000_000
const MAX_STORED_DRAFTS = 100
const MAX_SERIALIZED_LENGTH = 4_000_000
const MAX_IDENTITY_KEY_LENGTH = 16_384

function validIdentityParts(identity: unknown): identity is [string, string, 'stored' | 'runtime', string] {
  return Array.isArray(identity)
    && identity.length === 4
    && identity.every((part) => typeof part === 'string' && part.length > 0)
    && (identity[2] === 'stored' || identity[2] === 'runtime')
}

function identityKey(identity: SessionDraftIdentity): string | null {
  if (!identity || typeof identity !== 'object') {return null}

  const parts = [
    identity.backendNamespace,
    identity.profile,
    identity.sessionKind,
    identity.sessionId
  ]

  if (!validIdentityParts(parts)) {return null}

  const key = JSON.stringify(parts)

  return key.length <= MAX_IDENTITY_KEY_LENGTH ? key : null
}

function validIdentityKey(key: string): boolean {
  if (key.length > MAX_IDENTITY_KEY_LENGTH) {return false}

  try {
    const identity = JSON.parse(key) as unknown

    return validIdentityParts(identity)
      && JSON.stringify(identity) === key
  } catch {
    return false
  }
}

function boundDrafts(entries: Array<[string, string]>): Record<string, string> {
  const bounded = entries.slice(-MAX_STORED_DRAFTS)
  const entryLengths = bounded.map(([key, value]) => JSON.stringify(key).length + JSON.stringify(value).length + 1)

  let serializedLength = 2 + entryLengths.reduce((total, length) => total + length, 0)
    + Math.max(0, entryLengths.length - 1)

  while (bounded.length > 1 && serializedLength > MAX_SERIALIZED_LENGTH) {
    serializedLength -= entryLengths.shift()!

    if (bounded.length > 1) {serializedLength -= 1}
    bounded.shift()
  }

  if (bounded.length === 1 && serializedLength > MAX_SERIALIZED_LENGTH) {
    const [key, value] = bounded[0]
    const valueBudget = MAX_SERIALIZED_LENGTH - JSON.stringify(key).length - 3
    let serializedValueLength = 2
    let retainedLength = 0

    for (const character of value) {
      const nextLength = serializedValueLength + JSON.stringify(character).length - 2

      if (nextLength > valueBudget) {break}
      serializedValueLength = nextLength
      retainedLength += character.length
    }

    const fittedValue = value.slice(0, retainedLength)

    if (!fittedValue) {return {}}
    bounded[0] = [key, fittedValue]
  }

  return Object.fromEntries(bounded)
}

interface ReadDraftsResult {
  drafts: Record<string, string>
  persistenceFailed: boolean
  unsafePlaintext: boolean
}

function emptyReadResult(): ReadDraftsResult {
  return { drafts: {}, persistenceFailed: false, unsafePlaintext: false }
}

function purgeInvalidInput(storage: DraftStorage): ReadDraftsResult {
  try {
    purgePersistedDrafts(storage)

    return { drafts: {}, persistenceFailed: true, unsafePlaintext: false }
  } catch {
    return { drafts: {}, persistenceFailed: true, unsafePlaintext: true }
  }
}

function readDrafts(storage?: DraftStorage): ReadDraftsResult {
  if (!storage) {return emptyReadResult()}

  let raw: string | null

  try {
    raw = storage.getItem(DRAFTS_STORAGE_KEY)
  } catch {
    return { drafts: {}, persistenceFailed: true, unsafePlaintext: false }
  }

  if (raw === null) {return emptyReadResult()}
  if (!raw || raw.length > MAX_SERIALIZED_LENGTH) {return purgeInvalidInput(storage)}

  try {
    const parsed = JSON.parse(raw) as unknown

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {throw new Error('Invalid draft payload.')}
    const entries = Object.entries(parsed)

    if (entries.length > MAX_STORED_DRAFTS || entries.some(([key, value]) => (
      !validIdentityKey(key) || typeof value !== 'string' || !value || value.length > MAX_DRAFT_LENGTH
    ))) {throw new Error('Invalid draft entry.')}

    return { drafts: Object.fromEntries(entries), persistenceFailed: false, unsafePlaintext: false }
  } catch {
    return purgeInvalidInput(storage)
  }
}

function purgePersistedDrafts(storage: DraftStorage): void {
  const failures: unknown[] = []

  if (storage.removeItem) {
    try {
      storage.removeItem(DRAFTS_STORAGE_KEY)

      if (storage.getItem(DRAFTS_STORAGE_KEY) === null) {return}
      failures.push(new Error('Draft deletion was not persisted.'))
    } catch (error) {failures.push(error)}
  }

  try {
    storage.setItem(DRAFTS_STORAGE_KEY, '{}')
    const readback = storage.getItem(DRAFTS_STORAGE_KEY)

    if (readback !== null && readback !== '{}') {
      throw new Error('Empty draft payload was not persisted.')
    }
  } catch (error) {
    failures.push(error)
    throw new Error('Draft plaintext could not be purged.', {
      cause: new AggregateError(failures, 'Every draft purge method failed.')
    })
  }
}

export function createSessionDraftStore(storage?: DraftStorage) {
  const loaded = readDrafts(storage)
  let drafts = loaded.drafts
  let persistenceFailed = loaded.persistenceFailed
  let unsafePlaintext = loaded.unsafePlaintext

  const persist = (): boolean => {
    if (!storage) {return true}

    const serialized = JSON.stringify(drafts)

    if (Object.keys(drafts).length === 0) {
      try {
        purgePersistedDrafts(storage)
        persistenceFailed = false
        unsafePlaintext = false
      } catch (error) {
        persistenceFailed = true
        unsafePlaintext = true
        throw error
      }

      return true
    }

    try {
      if (serialized.length > MAX_SERIALIZED_LENGTH) {throw new Error('Draft payload exceeds the storage bound.')}
      storage.setItem(DRAFTS_STORAGE_KEY, serialized)
      if (storage.getItem(DRAFTS_STORAGE_KEY) !== serialized) {
        throw new Error('Draft payload was not persisted exactly.')
      }
      persistenceFailed = false
      unsafePlaintext = false

      return true
    } catch (writeError) {
      try {purgePersistedDrafts(storage)} catch (purgeError) {
        persistenceFailed = true
        unsafePlaintext = true
        throw new Error('Draft persistence failed and stale plaintext could not be purged.', {
          cause: new AggregateError([writeError, purgeError], 'Draft write and purge failed.')
        })
      }
      persistenceFailed = true
      unsafePlaintext = false

      return false
    }
  }

  return {
    get(identity: SessionDraftIdentity): string {
      const key = identityKey(identity)

      return key ? drafts[key] ?? '' : ''
    },
    set(identity: SessionDraftIdentity, value: string): boolean {
      const key = identityKey(identity)

      if (!key) {return true}
      const entries = Object.entries(drafts).filter(([existingKey]) => existingKey !== key)

      if (value) {entries.push([key, value.slice(0, MAX_DRAFT_LENGTH)])}
      drafts = boundDrafts(entries)

      return persist()
    },
    clear(): void {
      drafts = {}
      persist()
    },
    hasPersistenceFailure(): boolean {
      return persistenceFailed
    },
    hasUnsafePlaintext(): boolean {
      return unsafePlaintext
    }
  }
}

export { DRAFTS_STORAGE_KEY }
