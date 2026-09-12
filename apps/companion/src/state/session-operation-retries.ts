export interface RetryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

export type CreationRetryStatus =
  | 'untransmitted'
  | 'uncertain'
  | 'not_found'
  | 'preparing'
  | 'claimed'
  | 'admitted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'not_admitted'
  | 'interrupted_outcome_unknown'
  | 'recovery_required'

export interface CreationRetryEntry {
  version: 2
  operationKind: 'create'
  ownerScope: string
  backendNamespace: string
  profile: string
  projectId: string | null
  draftId: string
  draftRevision: number
  clientRequestId: string
  messageSha256: string
  storedSessionId: string | null
  operationStatus: CreationRetryStatus
}

export interface ContinuationRetryEntry {
  version: 2
  operationKind: 'continue'
  ownerScope: string
  backendNamespace: string
  profile: string
  storedSessionId: string
  clientRequestId: string
  messageSha256: string
  operationStatus: 'untransmitted' | 'uncertain'
}

export type SessionOperationRetryEntry = CreationRetryEntry | ContinuationRetryEntry

const RETRIES_STORAGE_KEY = 'hermes.companion.sessionOperationRetries.v2'
const MAX_SERIALIZED_LENGTH = 65_536
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/
const CREATE_STATUSES = new Set<CreationRetryStatus>([
  'untransmitted', 'uncertain', 'not_found', 'preparing', 'claimed', 'admitted', 'running',
  'completed', 'failed', 'cancelled', 'not_admitted', 'interrupted_outcome_unknown', 'recovery_required'
])

const bounded = (value: unknown, maximum: number): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= maximum && value === value.trim()

function validEntry(value: unknown): value is SessionOperationRetryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return false}
  const entry = value as Partial<SessionOperationRetryEntry>
  const common = entry.version === 2
    && bounded(entry.ownerScope, 512)
    && bounded(entry.backendNamespace, 4_096)
    && bounded(entry.profile, 64)
    && UUID_V4.test(entry.clientRequestId ?? '')
    && SHA256.test(entry.messageSha256 ?? '')
  if (!common) {return false}

  if (entry.operationKind === 'continue') {
    return Object.keys(entry).length === 9
      && bounded(entry.storedSessionId, 512)
      && (entry.operationStatus === 'untransmitted' || entry.operationStatus === 'uncertain')
  }
  if (entry.operationKind !== 'create') {return false}
  return Object.keys(entry).length === 12
    && (entry.projectId === null || bounded(entry.projectId, 512))
    && UUID_V4.test(entry.draftId ?? '')
    && Number.isSafeInteger(entry.draftRevision)
    && (entry.draftRevision ?? -1) >= 0
    && (entry.storedSessionId === null || bounded(entry.storedSessionId, 512))
    && CREATE_STATUSES.has(entry.operationStatus as CreationRetryStatus)
}

const keyOf = (entry: Pick<SessionOperationRetryEntry, 'ownerScope' | 'backendNamespace' | 'operationKind' | 'clientRequestId'>) =>
  JSON.stringify([entry.ownerScope, entry.backendNamespace, entry.operationKind, entry.clientRequestId])

export function createSessionOperationRetryStore(storage?: RetryStorage) {
  let entries = new Map<string, SessionOperationRetryEntry>()
  try {
    const raw = storage?.getItem(RETRIES_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) as unknown : []
    if (!Array.isArray(parsed) || parsed.length > 100 || !parsed.every(validEntry)) {throw new Error('invalid retries')}
    entries = new Map(parsed.map((entry) => [keyOf(entry), { ...entry }]))
  } catch {
    try {storage?.removeItem?.(RETRIES_STORAGE_KEY)} catch { /* Fail closed on subsequent writes. */ }
  }

  const persist = () => {
    if (!storage) {throw new Error('Local storage is required to send safely.')}
    const serialized = JSON.stringify([...entries.values()])
    if (serialized.length > MAX_SERIALIZED_LENGTH) {throw new Error('Local storage is required to send safely.')}
    try {
      storage.setItem(RETRIES_STORAGE_KEY, serialized)
      if (storage.getItem(RETRIES_STORAGE_KEY) !== serialized) {throw new Error('retry readback mismatch')}
    } catch {
      throw new Error('Local storage is required to send safely.')
    }
  }

  return {
    put(entry: SessionOperationRetryEntry): void {
      if (!validEntry(entry)) {throw new Error('Invalid retry metadata.')}
      entries.set(keyOf(entry), { ...entry })
      persist()
    },
    get(identity: Pick<SessionOperationRetryEntry, 'ownerScope' | 'backendNamespace' | 'operationKind' | 'clientRequestId'>): SessionOperationRetryEntry | null {
      const entry = entries.get(keyOf(identity))
      return entry ? { ...entry } : null
    },
    list(ownerScope: string, backendNamespace?: string): SessionOperationRetryEntry[] {
      return [...entries.values()]
        .filter((entry) => entry.ownerScope === ownerScope
          && (backendNamespace === undefined || entry.backendNamespace === backendNamespace))
        .map((entry) => ({ ...entry }))
    },
    remove(identity: Pick<SessionOperationRetryEntry, 'ownerScope' | 'backendNamespace' | 'operationKind' | 'clientRequestId'>): void {
      entries.delete(keyOf(identity))
      persist()
    },
    clearOwner(ownerScope: string): void {
      entries = new Map([...entries].filter(([, entry]) => entry.ownerScope !== ownerScope))
      persist()
    }
  }
}

export { RETRIES_STORAGE_KEY }
