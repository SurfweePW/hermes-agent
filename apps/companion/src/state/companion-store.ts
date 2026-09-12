import { type ConnectionState, JsonRpcGatewayError } from '@hermes/shared'

import { createDirectoryStore, type DirectoryGateway, type DirectoryStore } from '../features/directory/directory-store'
import type { LibraryGateway } from '../features/library/library-types'
import type { Teammate } from '../features/roster/roster'
import { createWorkStore, type WorkStore } from '../features/work/work-store'
import {
  COMPANION_TERMINAL_ERROR_MESSAGE,
  COMPANION_TERMINAL_TEXT_MAX_LENGTH,
  CompanionClient
} from '../gateway/companion-client'
import {
  buildGatewayWebSocketUrl,
  GATEWAY_BASE_URL_STORAGE_KEY,
  parseGatewayBaseUrl,
  persistGatewayBaseUrl
} from '../gateway/connection'
import type { OrganizationGateway } from '../gateway/organization-types'
import type {
  ApprovalChoice,
  ApprovalRequestPayload,
  ApprovalRespondResult,
  AttentionListResult,
  CompanionEvent,
  CompanionEventHandler,
  CompanionProjectRef,
  CompanionSessionCreationReceipt,
  CompanionSessionHistoryResult,
  CompanionSessionTarget,
  ContinueCompanionSessionOptions,
  ContinueCompanionSessionResult,
  CreateCompanionSessionRequest,
  CreateSessionOptions,
  GatewayAttentionItem,
  GatewaySessionSummary,
  PendingApprovalsResult,
  ProfilesListResult,
  PromptSubmitResult,
  ReconcileCompanionSessionOptions,
  ReconcileCompanionSessionResult,
  SessionInterruptResult,
  SessionListOptions,
  SessionListResult,
  SessionMessage,
  SessionResult,
  SetPinnedResult
} from '../gateway/types'
import type { WorkGateway } from '../gateway/work-types'
import { getOwnerAuthBridge, type OwnerAuthBridge } from '../security/owner-auth'
import { createDefaultSecretStore, type SessionSecretStore } from '../security/secret-store'

import { createSessionDraftStore, type LocalSessionDraftIdentity, type SessionDraftIdentity } from './session-drafts'
import { createSessionOperationRetryStore, type CreationRetryEntry } from './session-operation-retries'

export type CompanionPhase = 'setup' | 'connecting' | 'ready' | 'disconnected' | 'recovering'
export type CompanionConnectionMode = 'shared' | 'owner'
export type TurnStatus = 'idle' | 'sending' | 'submitting' | 'streaming' | 'stopping' | 'interrupted' | 'uncertain' | 'error'
export type MessageRole = 'user' | 'assistant' | 'system'
type PresentationIdentity = ({ kind: 'session' } & SessionDraftIdentity) | { kind: 'pending'; operation: number }
export type CompanionMessageKind = 'message' | 'tool' | 'internal' | 'compression'
export type ToolStatus = 'running' | 'progress' | 'complete'

export interface CompanionMessage {
  id: string
  role: MessageRole
  text: string
  kind?: CompanionMessageKind
  label?: string
  toolId?: string
  toolStatus?: ToolStatus
}

export interface PendingApproval {
  requestId: string
  sessionId: string
  title: string
  description: string
  command?: string
  choices: readonly ApprovalChoice[]
  responding: boolean
}

type TerminalCompanionEvent = Extract<CompanionEvent, { type: 'message.complete' | 'error' }>
const MAX_BUFFERED_CONTINUATION_TERMINAL_EVENTS = 64

export interface CompanionActiveSession {
  /** Exact durable identity for a continued persisted session. */
  target: CompanionSessionTarget | null
  title: string | null
  titleStatus: 'available' | 'unavailable'
  agent: Teammate
  project: CompanionProjectRef | null | undefined
  transcriptKey: string
}

export interface CompanionSnapshot {
  phase: CompanionPhase
  baseUrl: string
  warnings: readonly string[]
  teammates: readonly Teammate[]
  selectedTeammateId: string | null
  runtimeSessionId: string | null
  storedSessionId: string | null
  activeSession: CompanionActiveSession | null
  messages: readonly CompanionMessage[]
  streamingText: string
  pendingApproval: PendingApproval | null
  attentionItems: readonly GatewayAttentionItem[]
  attentionScope: string
  recentSessions: readonly GatewaySessionSummary[]
  sessionsLoading: boolean
  draft: string
  turnStatus: TurnStatus
  error: string | null
  hasSavedToken: boolean
  canForgetSavedToken: boolean
  storesTokenEncrypted: boolean
  ownerAuthAvailable: boolean
  connectionMode: CompanionConnectionMode
}

export interface CompanionGateway extends Partial<WorkGateway>, Partial<OrganizationGateway>, Partial<DirectoryGateway>, Partial<LibraryGateway> {
  readonly connectionState: ConnectionState
  connect(wsUrl: string): Promise<void>
  close(): void
  onEvent(handler: CompanionEventHandler): () => void
  onState(handler: (state: ConnectionState) => void): () => void
  listProfiles(): Promise<ProfilesListResult>
  createSession(options?: CreateSessionOptions): Promise<SessionResult>
  resumeSession(storedSessionId: string, profile?: string): Promise<SessionResult>
  getCompanionSessionHistory(profile: string, id: string, cursor?: string, expectedSource?: string): Promise<CompanionSessionHistoryResult>
  continueCompanionSession(options: ContinueCompanionSessionOptions): Promise<ContinueCompanionSessionResult>
  reconcileCompanionSession(options: ReconcileCompanionSessionOptions): Promise<ReconcileCompanionSessionResult>
  createCompanionSession?(options: CreateCompanionSessionRequest): Promise<CompanionSessionCreationReceipt>
  reconcileCompanionSessionCreation?(options: { operation_kind: 'create'; backend_namespace: string; profile: string; client_request_id: string }): Promise<CompanionSessionCreationReceipt>
  listSessions(options: SessionListOptions): Promise<SessionListResult>
  setSessionPinned(profile: string, sessionId: string, pinned: boolean): Promise<SetPinnedResult>
  listAttention(): Promise<AttentionListResult>
  submitPrompt(runtimeSessionId: string, text: string): Promise<PromptSubmitResult>
  interruptSession(runtimeSessionId: string): Promise<SessionInterruptResult>
  listPendingApprovals(runtimeSessionId: string): Promise<PendingApprovalsResult>
  respondToApproval(runtimeSessionId: string, requestId: string, choice: ApprovalChoice): Promise<ApprovalRespondResult>
}

export type CompanionGatewayFactory = () => CompanionGateway

export interface CompanionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

export interface CompanionStoreOptions {
  gatewayFactory?: CompanionGatewayFactory
  storage?: CompanionStorage
  secretStore?: SessionSecretStore
  ownerAuthBridge?: OwnerAuthBridge
  creationLock?: CreationLockManager
}

interface CreationLockManager {
  request<T>(name: string, options: { ifAvailable: true; mode: 'exclusive' }, callback: (lock: { name: string } | null) => Promise<T>): Promise<T>
}

export interface CompanionStore {
  work: WorkStore
  directory: DirectoryStore
  library: LibraryGateway
  getSnapshot(): CompanionSnapshot
  subscribe(listener: () => void): () => void
  configure(input: { baseUrl: string; token: string }): Promise<void>
  configureOwner(input: { baseUrl: string }): Promise<void>
  connectOwner(): Promise<void>
  signOutOwner(): Promise<void>
  selectTeammate(teammateId: string, storedSessionId?: string): Promise<void>
  openPersistedSession(target: CompanionSessionTarget, text: string, title?: string): Promise<void>
  refreshAttention(): Promise<void>
  openAttention(item: GatewayAttentionItem): Promise<void>
  refreshSessions(): Promise<void>
  setSessionPinned(sessionId: string, pinned: boolean): Promise<void>
  openBotChat(teammateId?: string): Promise<void>
  submitQuickTask(teammateId: string, text: string): Promise<void>
  activateSessionDraft(target: CompanionSessionTarget): void
  setDraft(draft: string): void
  submitDraft(): Promise<void>
  interrupt(): Promise<void>
  respondToApproval(choice: ApprovalChoice): Promise<void>
  recover(): Promise<void>
  forgetSavedToken(): Promise<void>
  destroy(): void
}

const TOKEN_SECRET_NAME = 'gateway-token'
const LOCAL_PINS_STORAGE_KEY = 'hermes.companion.localPins'
const CONTINUITY_RETRY_STORAGE_KEY = 'hermes.companion.continuityRetry.v1'
const MAX_CONTINUATION_TEXT_LENGTH = 1_000_000
const MAX_CONTINUITY_RETRY_STORAGE_LENGTH = 16_384

interface ContinuityRetryMetadata {
  target: CompanionSessionTarget
  messageSha256: string | null
  clientRequestId: string
}

const teammateMetadata: Record<string, Pick<Teammate, 'name' | 'role' | 'initials'>> = {
  atlas: { name: 'Atlas', role: 'Chief of Staff', initials: 'A' },
  mentor: { name: 'Mentor', role: 'Investments', initials: 'M' },
  maven: { name: 'Maven', role: 'Data Operations', initials: 'MV' },
  scout: { name: 'Scout', role: 'Research', initials: 'S' }
}

function browserStorage(): CompanionStorage | undefined {
  if (typeof window === 'undefined') {return undefined}

  return window.localStorage
}

function safeStoredBaseUrl(storage?: CompanionStorage): string {
  if (!storage) {return ''}

  try {
    return storage.getItem(GATEWAY_BASE_URL_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function validBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim()
}

function readContinuityRetry(storage?: CompanionStorage): ContinuityRetryMetadata | null {
  if (!storage) {return null}

  try {
    const raw = storage.getItem(CONTINUITY_RETRY_STORAGE_KEY)

    if (!raw) {return null}

    if (raw.length > MAX_CONTINUITY_RETRY_STORAGE_LENGTH) {
      clearContinuityRetry(storage)

      return null
    }

    const value = JSON.parse(raw) as Partial<ContinuityRetryMetadata>
    const target = value.target

    if (!target || typeof target !== 'object'
      || !validBoundedString(target.backend_namespace, 4_096)
      || !validBoundedString(target.profile, 4_096)
      || !validBoundedString(target.stored_session_id, 512)
      || (value.messageSha256 !== null
        && (typeof value.messageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.messageSha256)))
      || !validBoundedString(value.clientRequestId, 256)) {
      clearContinuityRetry(storage)

      return null
    }

    return { target: { ...target }, messageSha256: value.messageSha256, clientRequestId: value.clientRequestId }
  } catch {
    clearContinuityRetry(storage)

    return null
  }
}

function clearContinuityRetry(storage?: CompanionStorage) {
  if (!storage) {return}

  try {
    if (storage.removeItem) {storage.removeItem(CONTINUITY_RETRY_STORAGE_KEY)} else {storage.setItem(CONTINUITY_RETRY_STORAGE_KEY, '')}
  } catch { /* Best effort when clearing already-settled local retry state. */ }
}

function persistContinuityRetry(storage: CompanionStorage | undefined, retry: ContinuityRetryMetadata) {
  if (!storage) {throw new Error('Local storage is required to continue a saved conversation safely.')}
  const serialized = JSON.stringify(retry)

  if (serialized.length > MAX_CONTINUITY_RETRY_STORAGE_LENGTH) {throw new Error('Local storage is required to continue a saved conversation safely.')}

  try {
    storage.setItem(CONTINUITY_RETRY_STORAGE_KEY, serialized)

    if (storage.getItem(CONTINUITY_RETRY_STORAGE_KEY) !== serialized) {throw new Error('continuity retry was not persisted')}
  } catch {
    throw new Error('Local storage is required to continue a saved conversation safely.')
  }
}

async function continuationMessageDigest(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle

  if (!subtle) {throw new Error('Cryptographic retry support is unavailable.')}
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))

  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function sameContinuationTarget(left: CompanionSessionTarget, right: CompanionSessionTarget): boolean {
  return left.backend_namespace === right.backend_namespace
    && left.profile === right.profile
    && left.stored_session_id === right.stored_session_id
}

function isTerminalCompanionEvent(event: CompanionEvent): event is TerminalCompanionEvent {
  return event.type === 'message.complete' || event.type === 'error'
}

function boundedTerminalCompanionEvent(event: TerminalCompanionEvent): TerminalCompanionEvent {
  if (event.type === 'message.complete') {
    return {
      type: 'message.complete',
      session_id: event.session_id,
      payload: {
        ...(typeof event.payload.text === 'string'
          ? { text: event.payload.text.slice(0, COMPANION_TERMINAL_TEXT_MAX_LENGTH) }
          : {}),
        ...(typeof event.payload.interrupted === 'boolean' ? { interrupted: event.payload.interrupted } : {})
      }
    }
  }

  return {
    type: 'error',
    session_id: event.session_id,
    payload: { message: COMPANION_TERMINAL_ERROR_MESSAGE }
  }
}

function freezeSnapshot(snapshot: CompanionSnapshot): CompanionSnapshot {
  for (const teammate of snapshot.teammates) {Object.freeze(teammate)}

  for (const message of snapshot.messages) {Object.freeze(message)}
  Object.freeze(snapshot.warnings)
  Object.freeze(snapshot.teammates)
  Object.freeze(snapshot.messages)
  Object.freeze(snapshot.attentionItems)
  Object.freeze(snapshot.recentSessions)

  if (snapshot.pendingApproval) {
    Object.freeze(snapshot.pendingApproval.choices)
    Object.freeze(snapshot.pendingApproval)
  }

  return Object.freeze(snapshot)
}

function displayName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {return fallback}

  if (/[\\/]/.test(value) || value.startsWith('.') || value.includes('://')) {return fallback}
  const normalized = value.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')

  if (!normalized || normalized.length > 60) {return fallback}

  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function profileAlias(id: unknown, name: unknown): keyof typeof teammateMetadata | null {
  const candidate = `${typeof id === 'string' ? id : ''} ${typeof name === 'string' ? name : ''}`.toLowerCase()

  for (const alias of Object.keys(teammateMetadata)) {
    if (new RegExp(`(^|[^a-z])${alias}([^a-z]|$)`).test(candidate)) {return alias}
  }

  return null
}

function initialsFor(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'H'
}

function rosterState(
  teammateId: string,
  state: Pick<CompanionSnapshot, 'phase' | 'selectedTeammateId' | 'runtimeSessionId' | 'pendingApproval' | 'turnStatus'>,
  completedSessionId: string | null
): Pick<Teammate, 'status' | 'summary'> {
  if (teammateId !== state.selectedTeammateId) {
    return { status: 'idle', summary: 'No local activity observed.' }
  }

  if (state.phase === 'disconnected' || state.phase === 'recovering' || state.turnStatus === 'uncertain') {
    return { status: 'blocked', summary: 'Connection interrupted.' }
  }

  if (state.pendingApproval?.sessionId === state.runtimeSessionId) {
    return { status: 'needs-approval', summary: 'Waiting for your approval.' }
  }

  if (state.turnStatus === 'streaming' || state.turnStatus === 'sending' || state.turnStatus === 'submitting' || state.turnStatus === 'stopping') {
    return { status: 'working', summary: 'Conversation in progress.' }
  }

  if (state.runtimeSessionId && completedSessionId === state.runtimeSessionId) {
    return { status: 'completed', summary: 'Turn completed.' }
  }

  return { status: 'idle', summary: 'No local activity observed.' }
}

function messageText(message: SessionMessage): string | null {
  const content = message.content

  if (typeof content === 'string') {return content}

  if (Array.isArray(content)) {
    const text = content
      .map((part) => typeof part === 'string' ? part : (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : ''))
      .join('')

    return text || null
  }

  if (typeof message.text === 'string') {return message.text}

  return null
}

function toMessages(messages: SessionMessage[]): CompanionMessage[] {
  return messages.flatMap((message, index) => {
    const text = messageText(message)

    if (!text) {return []}
    const role: MessageRole = message.role === 'user' || message.role === 'system' ? message.role : 'assistant'

    return [{ id: `history-${index}`, role, text }]
  })
}

function toPersistedMessages(history: CompanionSessionHistoryResult): CompanionMessage[] {
  return history.entries.flatMap((entry): CompanionMessage[] => {
    if (entry.kind !== 'message') {
      return [{
        id: entry.id,
        role: 'system',
        text: entry.content,
        kind: entry.kind,
        label: entry.label ?? (entry.kind === 'compression' ? 'Earlier context summary' : entry.kind === 'tool' ? 'Tool activity' : 'Internal event'),
        ...(entry.kind === 'tool' ? { toolStatus: 'complete' as const } : {})
      }]
    }

    if (!entry.content || !entry.role) {return []}
    const role: MessageRole = entry.role === 'user' || entry.role === 'system' ? entry.role : 'assistant'

    return [{ id: entry.id, role, text: entry.content }]
  })
}

function toolPayload(payload: unknown): { toolId: string; label: string; details: string } {
  const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}

  const stringField = (...keys: string[]) => {
    for (const key of keys) {if (typeof value[key] === 'string' && value[key]) {return value[key] as string}}

    return ''
  }

  const toolId = stringField('id', 'tool_call_id', 'call_id') || `tool-${++messageSequenceFallback}`
  const name = stringField('name', 'tool_name') || 'Tool activity'
  const safeName = name.replace(/[<>\r\n]/g, ' ').trim().slice(0, 120) || 'Tool activity'
  let details = ''

  try {details = JSON.stringify(payload, null, 2).slice(0, 20_000)} catch {details = 'Tool details are unavailable.'}

  return { toolId, label: safeName, details }
}

let messageSequenceFallback = 0

function clientRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `companion-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function approvalFromPayload(sessionId: string, payload: ApprovalRequestPayload): PendingApproval {
  const choices = payload.choices?.length
    ? [...payload.choices]
    : (['once', ...(payload.allow_session === false ? [] : ['session'] as const), ...(payload.allow_permanent ? ['always'] as const : []), 'deny'] as ApprovalChoice[])

  return {
    requestId: payload.request_id,
    sessionId,
    title: payload.description || 'Approval requested',
    description: payload.command ? 'Review this action before Hermes continues.' : (payload.description || 'Hermes needs your decision to continue.'),
    ...(payload.command ? { command: payload.command } : {}),
    choices,
    responding: false
  }
}

const SECURE_CREDENTIAL_ERROR = 'Companion could not access encrypted token storage. Forget the saved token or try again.'
const DRAFT_PERSISTENCE_ERROR = 'Companion could not save drafts securely on this device. The current draft is available only until the app closes.'

class SecureCredentialError extends Error {
  constructor() {
    super(SECURE_CREDENTIAL_ERROR)
    this.name = 'SecureCredentialError'
  }
}

class DraftPersistenceError extends Error {
  constructor() {
    super(DRAFT_PERSISTENCE_ERROR)
    this.name = 'DraftPersistenceError'
  }
}

class UncertainContinuationError extends Error {
  constructor() {
    super('The saved conversation may have accepted this message. Retry to reconcile it; Hermes will not submit it twice.')
    this.name = 'UncertainContinuationError'
  }
}

function publicError(error: unknown): string {
  if (error instanceof SecureCredentialError || error instanceof DraftPersistenceError || error instanceof UncertainContinuationError) { return error.message }

  return 'Companion could not reach the gateway. Check the connection and try again.'
}

function isUncertainContinuationFailure(error: unknown): boolean {
  // JSON-RPC errors are authoritative rejections. Plain transport failures
  // may have happened after acceptance, so only those retain the request ID.
  return !(error instanceof JsonRpcGatewayError)
}

function isUncertainCreationFailure(error: unknown): boolean {
  return !(error instanceof JsonRpcGatewayError) || error.code === 5066
}

function isUnsupportedMethod(error: unknown): boolean {
  if (!(error instanceof Error)) {return false}

  const code = 'code' in error ? (error as Error & { code?: unknown }).code : undefined

  return code === -32601 || /(?:method not found|unknown method|-32601)/i.test(error.message)
}

function authenticatedOwnerScope(status: unknown): string | null {
  if (typeof status !== 'object' || status === null
    || !('signedIn' in status) || (status as { signedIn?: unknown }).signedIn !== true
    || !('ownerScope' in status)) {return null}
  const scope = (status as { ownerScope?: unknown }).ownerScope

  return validBoundedString(scope, 512) ? scope : null
}

export function createCompanionStore(options: CompanionStoreOptions = {}): CompanionStore {
  const work = createWorkStore()
  const directory = createDirectoryStore()
  const gatewayFactory = options.gatewayFactory ?? (() => new CompanionClient())
  const storage = options.storage ?? browserStorage()
  const sessionDrafts = createSessionDraftStore(storage)
  const operationRetries = createSessionOperationRetryStore(storage)
  let draftPersistenceWarning = sessionDrafts.hasPersistenceFailure()
  const secrets = options.secretStore ?? createDefaultSecretStore()
  const ownerAuth = options.ownerAuthBridge ?? getOwnerAuthBridge()

  const creationLock = options.creationLock ?? (typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks as unknown as CreationLockManager
    : null)

  const profileIds = new Map<string, string>()
  const listeners = new Set<() => void>()
  const localPins = new Set<string>()

  try {
    const storedPins = storage?.getItem(LOCAL_PINS_STORAGE_KEY)
    const parsed = storedPins ? JSON.parse(storedPins) : []

    if (Array.isArray(parsed)) {
      for (const key of parsed) {if (typeof key === 'string') {localPins.add(key)}}
    }
  } catch { /* Ignore corrupt optional fallback state. */ }

  let attentionSupported = true
  let pinsSupported = true
  const canonicalSessions = new Map<string, Promise<SessionResult>>()
  let gateway: CompanionGateway | null = null
  let removeEventListener: (() => void) | null = null
  let removeStateListener: (() => void) | null = null
  let destroyed = false
  let messageSequence = 0
  let connectionGeneration = 0
  let sessionGeneration = 0
  let sessionListGeneration = 0
  let completedSessionId: string | null = null
  let savedToken: string | undefined
  let savedTokenError: string | null = null
  let pendingSavedToken: Promise<string | undefined> | null = null
  let secretMutationTail: Promise<void> = Promise.resolve()
  let connectionMode: CompanionConnectionMode = 'shared'
  let ownerScope: string | null = null
  let continuityRetry: ContinuityRetryMetadata | null = readContinuityRetry(storage)
  let persistedContinuationTarget: CompanionSessionTarget | null = null
  let activeDraftIdentity: SessionDraftIdentity | null = null
  let activePresentationIdentity: PresentationIdentity | null = null

  const backendNamespaceForProfile = (profile: string) => directory.getSnapshot().coverage
    .find((item) => item.profile === profile)?.backendNamespace ?? null

  let pendingContinuation: {
    client: CompanionGateway
    connectionGeneration: number
    sessionGeneration: number
    terminalEvents: Map<string, TerminalCompanionEvent>
  } | null = null

  const getPendingContinuation = () => pendingContinuation

  let handledTerminal: {
    client: CompanionGateway
    connectionGeneration: number
    sessionGeneration: number
    runtimeSessionId: string
  } | null = null

  const clearContinuationEventState = () => {
    pendingContinuation?.terminalEvents.clear()
    pendingContinuation = null
    handledTerminal = null
  }

  const beginSessionOperation = () => {
    clearContinuationEventState()

    return ++sessionGeneration
  }

  try {
    const candidate = secrets.get(TOKEN_SECRET_NAME)

    if (candidate && typeof (candidate as Promise<string | undefined>).then === 'function') {
      pendingSavedToken = Promise.resolve(candidate)
    } else {
      savedToken = candidate as string | undefined
    }
  } catch {
    savedTokenError = SECURE_CREDENTIAL_ERROR
  }

  let pendingSubmit: {
    client: CompanionGateway
    connectionGeneration: number
    sessionGeneration: number
    runtimeSessionId: string
    text: string
    draftAtSubmission: string | null
    userRecorded: boolean
    completed: boolean
  } | null = null

  let pendingInterrupt: {
    client: CompanionGateway
    connectionGeneration: number
    sessionGeneration: number
    runtimeSessionId: string
    previousTurnStatus: 'sending' | 'submitting' | 'streaming'
  } | null = null

  let interruptedTurn: {
    client: CompanionGateway
    connectionGeneration: number
    sessionGeneration: number
    runtimeSessionId: string
  } | null = null

  let snapshot = freezeSnapshot({
    phase: 'setup',
    baseUrl: safeStoredBaseUrl(storage),
    warnings: [],
    teammates: [],
    selectedTeammateId: null,
    runtimeSessionId: null,
    storedSessionId: null,
    activeSession: null,
    messages: [],
    streamingText: '',
    pendingApproval: null,
    attentionItems: [],
    attentionScope: 'This gateway runtime only',
    recentSessions: [],
    sessionsLoading: false,
    draft: '',
    turnStatus: 'idle',
    error: savedTokenError ?? (draftPersistenceWarning ? DRAFT_PERSISTENCE_ERROR : null),
    hasSavedToken: Boolean(savedToken),
    canForgetSavedToken: Boolean(savedToken || savedTokenError),
    storesTokenEncrypted: secrets.persistent,
    ownerAuthAvailable: Boolean(ownerAuth),
    connectionMode
  })

  const publish = (changes: Partial<CompanionSnapshot>) => {
    if (destroyed) {return}
    const hadDraftPersistenceWarning = draftPersistenceWarning

    if (Object.prototype.hasOwnProperty.call(changes, 'draft') && activeDraftIdentity) {
      try {
        draftPersistenceWarning = !sessionDrafts.set(activeDraftIdentity, changes.draft ?? '')
      } catch {
        draftPersistenceWarning = true
      }
    }

    const next = { ...snapshot, ...changes }

    if (draftPersistenceWarning && next.error === null) {next.error = DRAFT_PERSISTENCE_ERROR}
    else if (hadDraftPersistenceWarning
      && !draftPersistenceWarning
      && next.error === DRAFT_PERSISTENCE_ERROR) {next.error = null}

    if (next.phase === 'disconnected') {next.attentionItems = []}

    const teammates = next.teammates.map((teammate) => ({
      ...teammate,
      ...rosterState(teammate.id, next, completedSessionId)
    }))

    snapshot = freezeSnapshot({ ...next, teammates })

    for (const listener of listeners) {listener()}
  }

  const savedTokenHydrationGeneration = connectionGeneration

  const savedTokenReady = pendingSavedToken
    ? pendingSavedToken.then((token) => {
        savedToken = token
        savedTokenError = null
        publish({
          hasSavedToken: Boolean(token),
          canForgetSavedToken: Boolean(token),
          ...(connectionGeneration === savedTokenHydrationGeneration ? { error: null } : {})
        })
      }).catch(() => {
        savedToken = undefined
        savedTokenError = SECURE_CREDENTIAL_ERROR
        publish({
          hasSavedToken: false,
          canForgetSavedToken: true,
          ...(connectionGeneration === savedTokenHydrationGeneration ? { error: SECURE_CREDENTIAL_ERROR } : {})
        })
      })
    : Promise.resolve()

  const isDisconnected = () => snapshot.phase === 'disconnected'

  const activateDraft = (identity: SessionDraftIdentity) => {
    activeDraftIdentity = identity

    return sessionDrafts.get(identity)
  }

  const activatePersistedDraft = (target: CompanionSessionTarget) => activateDraft({
    backendNamespace: target.backend_namespace,
    profile: target.profile,
    sessionId: target.stored_session_id,
    sessionKind: 'stored'
  })

  const isActivePersistedDraft = (target: CompanionSessionTarget) => Boolean(activeDraftIdentity
    && activeDraftIdentity.backendNamespace === target.backend_namespace
    && activeDraftIdentity.profile === target.profile
    && activeDraftIdentity.sessionId === target.stored_session_id
    && activeDraftIdentity.sessionKind === 'stored')

  const sameDraftIdentity = (left: SessionDraftIdentity | null, right: SessionDraftIdentity) => Boolean(left
    && left.backendNamespace === right.backendNamespace
    && left.profile === right.profile
    && left.sessionId === right.sessionId
    && left.sessionKind === right.sessionKind)

  const presentationIdentityForTarget = (target: CompanionSessionTarget) => ({
    kind: 'session' as const,
    backendNamespace: target.backend_namespace,
    profile: target.profile,
    sessionId: target.stored_session_id,
    sessionKind: 'stored' as const
  })

  const samePresentationIdentity = (
    left: PresentationIdentity | null,
    right: PresentationIdentity
  ) => Boolean(left && (left.kind === 'pending' || right.kind === 'pending'
    ? left.kind === 'pending' && right.kind === 'pending' && left.operation === right.operation
    : sameDraftIdentity(left, right)))

  const presentationSelectsTarget = (
    presentation: PresentationIdentity | null,
    target: CompanionSessionTarget
  ) => Boolean(presentation?.kind === 'session'
    && sameDraftIdentity(presentation, presentationIdentityForTarget(target)))

  const deactivateDraft = () => {
    activeDraftIdentity = null

    return ''
  }

  const activeSessionPresentation = (
    teammate: Teammate,
    target: CompanionSessionTarget | null,
    title: string | null,
    project: CompanionProjectRef | null | undefined = undefined
  ): CompanionActiveSession => ({
    target: target ? { ...target } : null,
    title,
    titleStatus: title === null ? 'unavailable' : 'available',
    agent: { ...teammate },
    project: project ? { ...project } : project,
    transcriptKey: target
      ? JSON.stringify([target.backend_namespace, target.profile, target.stored_session_id])
      : JSON.stringify(['canonical', profileIds.get(teammate.id) ?? teammate.id, 'Bot Chat'])
  })

  const detachGateway = () => {
    removeEventListener?.()
    removeStateListener?.()
    removeEventListener = null
    removeStateListener = null
  }

  const discardGateway = (operation: number) => {
    if (connectionGeneration !== operation) {return}
    const client = gateway

    detachGateway()
    gateway = null
    client?.close()
    profileIds.clear()
    pendingSubmit = null
    pendingInterrupt = null
    interruptedTurn = null
    clearContinuationEventState()
    completedSessionId = null
    sessionGeneration += 1
  }

  const resetOwnerPresentation = (
    { purgeIdentityState = true }: { purgeIdentityState?: boolean } = {}
  ): boolean => {
    work.reset()
    directory.reset()
    profileIds.clear()

    if (purgeIdentityState) {
      localPins.clear()

      try {
        if (storage?.removeItem) {storage.removeItem(LOCAL_PINS_STORAGE_KEY)}
        else {storage?.setItem(LOCAL_PINS_STORAGE_KEY, '[]')}
      } catch { /* Optional identity-scoped fallback state is already cleared in memory. */ }
    }

    sessionListGeneration += 1
    messageSequence = 0
    pendingSubmit = null
    pendingInterrupt = null
    interruptedTurn = null
    clearContinuationEventState()
    completedSessionId = null
    persistedContinuationTarget = null

    if (purgeIdentityState) {
      continuityRetry = null
      clearContinuityRetry(storage)

      try {
        sessionDrafts.clear()
        draftPersistenceWarning = false
      } catch {
        draftPersistenceWarning = true
      }
    }

    activeDraftIdentity = null
    activePresentationIdentity = null
    publish({
      phase: 'disconnected',
      connectionMode: 'shared',
      teammates: [],
      selectedTeammateId: null,
      runtimeSessionId: null,
      storedSessionId: null,
      activeSession: null,
      messages: [],
      streamingText: '',
      pendingApproval: null,
      attentionItems: [],
      attentionScope: 'This gateway runtime only',
      recentSessions: [],
      sessionsLoading: false,
      draft: '',
      turnStatus: 'idle',
      error: draftPersistenceWarning ? DRAFT_PERSISTENCE_ERROR : null
    })

    return !sessionDrafts.hasUnsafePlaintext()
  }

  const handleEvent = (event: CompanionEvent) => {
    if (isTerminalCompanionEvent(event)) {event = boundedTerminalCompanionEvent(event)}

    if (event.type === 'approval.request' || event.type === 'message.complete' || event.type === 'error') {
      const client = gateway

      if (client) {
        void loadAttention(client, connectionGeneration).catch(() => undefined)
      }
    }

    const continuation = getPendingContinuation()

    if (isTerminalCompanionEvent(event)
      && continuation
      && continuation.client === gateway
      && continuation.connectionGeneration === connectionGeneration
      && continuation.sessionGeneration === sessionGeneration) {
      // A runtime has one terminal outcome. Keep the first one so duplicate
      // delivery cannot append the same assistant result more than once, while
      // retaining enough distinct runtime IDs to correlate the admission reply.
      if (!continuation.terminalEvents.has(event.session_id)) {
        if (continuation.terminalEvents.size >= MAX_BUFFERED_CONTINUATION_TERMINAL_EVENTS) {
          const oldestSessionId = continuation.terminalEvents.keys().next().value

          if (oldestSessionId !== undefined) {continuation.terminalEvents.delete(oldestSessionId)}
        }

        continuation.terminalEvents.set(event.session_id, boundedTerminalCompanionEvent(event))
      }

      return
    }

    if (event.session_id !== snapshot.runtimeSessionId) {return}

    if (isTerminalCompanionEvent(event)
      && handledTerminal?.client === gateway
      && handledTerminal.connectionGeneration === connectionGeneration
      && handledTerminal.sessionGeneration === sessionGeneration
      && handledTerminal.runtimeSessionId === event.session_id) {return}

    const isStoppedTurn = interruptedTurn?.runtimeSessionId === event.session_id
      && interruptedTurn.client === gateway
      && interruptedTurn.connectionGeneration === connectionGeneration
      && interruptedTurn.sessionGeneration === sessionGeneration

    if (isStoppedTurn
      && (event.type === 'message.delta' || event.type === 'message.complete' || event.type === 'error')) {return}

    if (isTerminalCompanionEvent(event) && gateway) {
      // The first terminal outcome wins for this runtime/session lifecycle.
      // This also suppresses redelivery after a pre-admission event is replayed.
      handledTerminal = { client: gateway, connectionGeneration, sessionGeneration, runtimeSessionId: event.session_id }
    }

    if (event.type === 'message.delta') {
      publish({
        streamingText: snapshot.streamingText + event.payload.text,
        turnStatus: snapshot.turnStatus === 'stopping' ? 'stopping' : 'streaming'
      })

      return
    }

    if (event.type === 'message.complete') {
      const text = event.payload.text ?? snapshot.streamingText

      const submittedTurn = pendingSubmit?.runtimeSessionId === event.session_id
        && pendingSubmit.client === gateway
        && pendingSubmit.connectionGeneration === connectionGeneration
        && pendingSubmit.sessionGeneration === sessionGeneration
        ? pendingSubmit
        : null

      const messages = [...snapshot.messages]

      if (submittedTurn && !submittedTurn.userRecorded) {
        messages.push({ id: `message-${++messageSequence}`, role: 'user', text: submittedTurn.text })
        submittedTurn.userRecorded = true
      }

      if (text) {messages.push({ id: `message-${++messageSequence}`, role: 'assistant', text })}

      if (submittedTurn) {submittedTurn.completed = true}

      if (pendingInterrupt?.runtimeSessionId === event.session_id
        && pendingInterrupt.client === gateway
        && pendingInterrupt.connectionGeneration === connectionGeneration
        && pendingInterrupt.sessionGeneration === sessionGeneration) {
        pendingInterrupt = null
      }

      if (event.payload.interrupted && gateway) {
        interruptedTurn = {
          client: gateway,
          connectionGeneration,
          sessionGeneration,
          runtimeSessionId: event.session_id
        }
      }

      completedSessionId = event.session_id
      publish({
        draft: submittedTurn
          && submittedTurn.draftAtSubmission !== null
          && snapshot.draft === submittedTurn.draftAtSubmission
          ? ''
          : snapshot.draft,
        messages,
        streamingText: '',
        pendingApproval: null,
        turnStatus: event.payload.interrupted ? 'interrupted' : 'idle'
      })

      return
    }

    if (event.type === 'tool.start' || event.type === 'tool.progress' || event.type === 'tool.complete') {
      const tool = toolPayload(event.payload)
      const status: ToolStatus = event.type === 'tool.start' ? 'running' : event.type === 'tool.progress' ? 'progress' : 'complete'
      const existing = snapshot.messages.findIndex((message) => message.kind === 'tool' && message.toolId === tool.toolId)
      const previous = existing >= 0 ? snapshot.messages[existing] : null

      const row: CompanionMessage = {
        id: previous?.id ?? `message-${++messageSequence}`,
        role: 'system',
        text: tool.details,
        kind: 'tool',
        label: tool.label === 'Tool activity' ? previous?.label ?? tool.label : tool.label,
        toolId: tool.toolId,
        toolStatus: status
      }

      const messages = [...snapshot.messages]

      if (existing >= 0) {messages[existing] = row} else {messages.push(row)}
      publish({ messages })

      return
    }

    if (event.type === 'approval.request') {
      publish({ pendingApproval: approvalFromPayload(event.session_id, event.payload) })

      return
    }

    if (event.type === 'error') {
      publish({ streamingText: '', pendingApproval: null, turnStatus: 'error', error: COMPANION_TERMINAL_ERROR_MESSAGE })
    }
  }

  const handleState = (state: ConnectionState) => {
    if (state !== 'closed' && state !== 'error') {return}
    work.disconnect()
    directory.disconnect()
    publish({
      phase: 'disconnected',
      turnStatus: snapshot.turnStatus === 'streaming' || snapshot.turnStatus === 'sending' || snapshot.turnStatus === 'submitting' || snapshot.turnStatus === 'stopping'
        ? 'uncertain'
        : snapshot.turnStatus,
      error: null
    })
  }

  const installGateway = (generation: number) => {
    const replaced = gateway
    work.disconnect()
    directory.disconnect()
    detachGateway()
    replaced?.close()
    const client = gatewayFactory()
    gateway = client
    attentionSupported = true
    pinsSupported = true
    clearContinuationEventState()
    sessionGeneration += 1
    completedSessionId = null
    pendingSubmit = null
    pendingInterrupt = null
    interruptedTurn = null
    publish({ runtimeSessionId: null, pendingApproval: null, streamingText: '' })
    removeEventListener = client.onEvent((event) => {
      if (gateway === client && connectionGeneration === generation) {handleEvent(event)}
    })
    removeStateListener = client.onState((state) => {
      if (gateway === client && connectionGeneration === generation) {handleState(state)}
    })

    return client
  }

  const isCurrentConnection = (client: CompanionGateway, generation: number) => (
    !destroyed && gateway === client && connectionGeneration === generation
  )

  const mutateSecret = async <T>(mutation: () => T | Promise<T>): Promise<T> => {
    const previous = secretMutationTail
    let release!: () => void

    secretMutationTail = new Promise<void>((resolve) => {release = resolve})
    await previous.catch(() => undefined)

    try {return await mutation()} finally {release()}
  }

  const persistSharedToken = async (
    client: CompanionGateway,
    operation: number,
    replacementToken: string
  ): Promise<boolean> => mutateSecret(async () => {
    if (!isCurrentConnection(client, operation)) {return false}
    const previousToken = savedToken

    try {
      await secrets.set(TOKEN_SECRET_NAME, replacementToken)
    } catch {
      throw new SecureCredentialError()
    }

    if (!isCurrentConnection(client, operation)) {
      // The native write cannot be cancelled once dispatched. Restore the value
      // this attempt replaced before allowing a newer token mutation to proceed.
      try {
        if (previousToken) {await secrets.set(TOKEN_SECRET_NAME, previousToken)}
        else {await secrets.delete(TOKEN_SECRET_NAME)}
      } catch {
        throw new SecureCredentialError()
      }

      return false
    }

    savedToken = replacementToken
    savedTokenError = null

    return true
  })

  const loadRoster = async (client: CompanionGateway, generation: number) => {
    const result = await client.listProfiles()

    if (!isCurrentConnection(client, generation)) {return false}
    const nextProfileIds = new Map<string, string>()
    const idCounts = new Map<string, number>()

    const teammates = result.profiles.flatMap((profile, index): Teammate[] => {
      if (typeof profile.name !== 'string' || !profile.name) {return []}
      const alias = profileAlias(profile.id, profile.name)
      const metadata = alias ? teammateMetadata[alias] : null
      const name = metadata?.name ?? displayName(profile.name, `Hermes Teammate ${index + 1}`)
      const baseId = alias ?? `teammate-${index + 1}`
      const count = (idCounts.get(baseId) ?? 0) + 1
      idCounts.set(baseId, count)
      const id = count === 1 ? baseId : `${baseId}-${count}`
      nextProfileIds.set(id, profile.name)

      return [{
        id,
        name,
        initials: metadata?.initials ?? initialsFor(name),
        role: metadata?.role ?? 'Hermes Teammate',
        status: 'idle',
        summary: 'No local activity observed.'
      }]
    })

    if (!isCurrentConnection(client, generation)) {return false}
    profileIds.clear()

    for (const [id, profile] of nextProfileIds) {profileIds.set(id, profile)}
    publish({ teammates })

    return true
  }

  const loadAttention = async (client: CompanionGateway, generation: number) => {
    if (!attentionSupported) {return true}

    try {
      const result = await client.listAttention()

      if (!isCurrentConnection(client, generation)) {return false}

      const scope = typeof result.scope === 'string'
        ? result.scope
        : result.scope?.label || 'This gateway runtime only'

      publish({ attentionItems: result.items, attentionScope: scope })

      return true
    } catch (error) {
      if (isUnsupportedMethod(error) && isCurrentConnection(client, generation)) {
        attentionSupported = false
        publish({ attentionItems: [], attentionScope: 'Unavailable on this gateway version' })

        return true
      }

      throw error
    }
  }

  const localPinKey = (profile: string, sessionId: string) => `${profile}\u0000${sessionId}`

  const persistLocalPins = () => {
    try {storage?.setItem(LOCAL_PINS_STORAGE_KEY, JSON.stringify([...localPins]))} catch { /* Optional fallback. */ }
  }

  const loadSessions = async (client: CompanionGateway, teammateId: string) => {
    const profile = profileIds.get(teammateId)

    if (!profile) {return}
    const requestGeneration = ++sessionListGeneration
    publish({ sessionsLoading: true })

    try {
      const result = await client.listSessions({ profile, limit: 20 })

      if (gateway === client && snapshot.selectedTeammateId === teammateId && sessionListGeneration === requestGeneration) {
        publish({
          recentSessions: result.sessions.map((session) => ({
            ...session,
            pinned: session.pinned || localPins.has(localPinKey(profile, session.id))
          })),
          sessionsLoading: false
        })
      }
    } catch (error) {
      if (gateway === client && snapshot.selectedTeammateId === teammateId && sessionListGeneration === requestGeneration) {
        publish({ sessionsLoading: false, error: publicError(error) })
      }
    }
  }

  const applySession = async (
    client: CompanionGateway,
    result: SessionResult,
    connectionOperation: number,
    sessionOperation: number,
    preservedMessages?: readonly CompanionMessage[],
    beforePendingApprovals?: () => void
  ) => {
    if (!isCurrentConnection(client, connectionOperation) || sessionGeneration !== sessionOperation) {return false}
    pendingInterrupt = null
    interruptedTurn = null
    completedSessionId = null

    const profile = typeof result.profile === 'string'
      ? result.profile
      : snapshot.selectedTeammateId ? profileIds.get(snapshot.selectedTeammateId) : undefined

    const backendNamespace = typeof result.backend_namespace === 'string'
      ? result.backend_namespace
      : persistedContinuationTarget?.stored_session_id === result.stored_session_id
        ? persistedContinuationTarget.backend_namespace
        : snapshot.baseUrl

    const resolvedIdentity: SessionDraftIdentity | null = profile
      ? {
          backendNamespace,
          profile,
          sessionId: result.stored_session_id ?? result.session_id,
          sessionKind: result.stored_session_id ? 'stored' : 'runtime'
        }
      : null

    const draft = resolvedIdentity ? activateDraft(resolvedIdentity) : deactivateDraft()
    activePresentationIdentity = resolvedIdentity ? { kind: 'session', ...resolvedIdentity } : null

    publish({
      runtimeSessionId: result.session_id,
      storedSessionId: result.stored_session_id,
      messages: preservedMessages ? [...preservedMessages] : toMessages(result.messages),
      streamingText: '',
      pendingApproval: null,
      draft,
      turnStatus: 'idle'
    })
    beforePendingApprovals?.()
    const pending = await client.listPendingApprovals(result.session_id)

    if (!isCurrentConnection(client, connectionOperation)
      || sessionGeneration !== sessionOperation
      || snapshot.runtimeSessionId !== result.session_id) {return false}

    publish({ pendingApproval: pending.approvals[0] ? approvalFromPayload(result.session_id, pending.approvals[0]) : null })

    return true
  }


  const resolveLegacyBotChat = async (client: CompanionGateway, profile: string) => {
    const inFlight = canonicalSessions.get(profile)

    if (inFlight) {return inFlight}

    const operation = (async () => {
      const found = await client.listSessions({ profile, limit: 1, include_hidden: true, include_archived: true, title: 'Bot Chat' })
      const exact = found.sessions.find((session) => session.title === 'Bot Chat')

      if (exact) {return client.resumeSession(exact.resolved_id ?? exact.id, profile)}

      try {return await client.createSession({ profile, title: 'Bot Chat', hidden: true, source: 'companion' })}
      catch (error) {try {return await client.resumeSession('Bot Chat', profile)} catch {throw error}}
    })()

    canonicalSessions.set(profile, operation)

    try {return await operation} finally {if (canonicalSessions.get(profile) === operation) {canonicalSessions.delete(profile)}}
  }

  const connect = async (
    phase: 'connecting' | 'recovering',
    operation: number,
    mode: CompanionConnectionMode,
    token: string | undefined = savedToken
  ) => {
    if (mode === 'shared' && !token) {
      publish({ phase: 'setup', error: 'Enter a gateway session token to connect.' })

      return null
    }

    publish({ phase, error: null })

    const wsUrl = mode === 'owner'
      ? await ownerAuth?.ownerWebSocketUrl({ baseUrl: snapshot.baseUrl })
      : buildGatewayWebSocketUrl({ baseUrl: snapshot.baseUrl, token: token! })

    if (!wsUrl) {throw new Error('Owner authentication is unavailable.')}

    if (connectionGeneration !== operation || destroyed) {return null}
    const client = installGateway(operation)
    await client.connect(wsUrl)

    if (!isCurrentConnection(client, operation)) {return null}

    if (!await loadRoster(client, operation)) {return null}

    if (!await loadAttention(client, operation)) {return null}
    await work.attach(client, [...profileIds.values()], mode === 'owner')
    await directory.attach(client, [...profileIds.values()])

    if (!isCurrentConnection(client, operation)) {return null}

    connectionMode = mode
    publish({ connectionMode: mode })

    return client
  }

  const reconcileContinuityAfterReconnect = async (
    client: CompanionGateway,
    connectionOperation: number,
    retry: ContinuityRetryMetadata,
    preservedActiveSession: CompanionActiveSession | null
  ) => {
    const target = retry.target

    const draftIdentity: SessionDraftIdentity = {
      backendNamespace: target.backend_namespace,
      profile: target.profile,
      sessionId: target.stored_session_id,
      sessionKind: 'stored'
    }

    const selectedPresentationIdentity = activePresentationIdentity ? { ...activePresentationIdentity } : null

    const background = Boolean(selectedPresentationIdentity
      && !presentationSelectsTarget(selectedPresentationIdentity, target))

    const sessionOperation = background ? sessionGeneration : beginSessionOperation()

    const isCurrentReconciliation = () => isCurrentConnection(client, connectionOperation)
      && sessionGeneration === sessionOperation
      && (!background || samePresentationIdentity(activePresentationIdentity, selectedPresentationIdentity!))

    const result = await client.reconcileCompanionSession({
      ...target,
      client_request_id: retry.clientRequestId
    })

    if (!isCurrentReconciliation()) {return false}

    const teammateId = [...profileIds].find(([, profile]) => profile === target.profile)?.[0]
    const teammate = teammateId ? snapshot.teammates.find((item) => item.id === teammateId) : undefined

    if (!teammateId || !teammate) {throw new Error('The saved conversation profile is unavailable after reconnect.')}

    const activeSession = preservedActiveSession?.target
      && sameContinuationTarget(preservedActiveSession.target, target)
      ? preservedActiveSession
      : activeSessionPresentation(teammate, target, null)

    const history = await client.getCompanionSessionHistory(
      target.profile,
      target.stored_session_id,
      undefined,
      target.backend_namespace
    )

    if (!isCurrentReconciliation()) {return false}

    const running = result.operation_status === 'claimed'
      || result.operation_status === 'admitted'
      || result.operation_status === 'running'

    const completed = result.operation_status === 'completed'

    const outcomeUnknown = result.operation_status === 'interrupted_outcome_unknown'
      || result.operation_status === 'legacy_unknown'

    if (!running && !outcomeUnknown) {
      continuityRetry = null
      clearContinuityRetry(storage)
    }

    let draft = sessionDrafts.get(draftIdentity)

    if (completed && retry.messageSha256 && draft) {
      const digestCandidate = draft
      const currentDigest = await continuationMessageDigest(digestCandidate).catch(() => null)

      if (!isCurrentReconciliation()) {return false}
      const currentDraft = sessionDrafts.get(draftIdentity)
      draft = currentDraft === digestCandidate && currentDigest === retry.messageSha256
        ? ''
        : currentDraft
    }

    if (background) {
      if (completed && sessionDrafts.get(draftIdentity) !== draft) {
        try {
          if (!sessionDrafts.set(draftIdentity, draft)) {draftPersistenceWarning = true}
        } catch {draftPersistenceWarning = true}
      }

      return true
    }

    persistedContinuationTarget = { ...target }
    activeDraftIdentity = draftIdentity
    activePresentationIdentity = presentationIdentityForTarget(target)
    publish({
      selectedTeammateId: teammateId,
      runtimeSessionId: result.runtime_session_id ?? null,
      storedSessionId: target.stored_session_id,
      activeSession,
      messages: toPersistedMessages(history),
      streamingText: '',
      pendingApproval: null,
      draft,
      turnStatus: completed ? 'idle'
        : running ? (result.runtime_session_id ? 'streaming' : 'sending')
          : outcomeUnknown ? 'uncertain' : 'idle',
      error: completed || running
        ? null
        : outcomeUnknown
          ? new UncertainContinuationError().message
          : `The previous continuation ended with status: ${result.operation_status}.`
    })

    if (result.runtime_session_id) {
      const pending = await client.listPendingApprovals(result.runtime_session_id)

      if (!isCurrentConnection(client, connectionOperation)
        || sessionGeneration !== sessionOperation
        || snapshot.runtimeSessionId !== result.runtime_session_id) {return false}

      publish({ pendingApproval: pending.approvals[0] ? approvalFromPayload(result.runtime_session_id, pending.approvals[0]) : null })
    }

    return true
  }

  const library: LibraryGateway = {
    libraryCapabilities: () => {
      if (!gateway?.libraryCapabilities) {return Promise.reject(new Error('Library is not supported by this gateway.'))}

      return gateway.libraryCapabilities()
    },
    libraryProfiles: () => {
      if (!gateway?.libraryProfiles) {return Promise.reject(new Error('Library profile discovery is not supported by this gateway.'))}

      return gateway.libraryProfiles()
    },
    resolveLibraryReference: (reference, profile) => {
      if (!gateway?.resolveLibraryReference) {return Promise.reject(new Error('Exact Library reference resolution is not supported by this gateway.'))}

      return gateway.resolveLibraryReference(reference, profile)
    },
    listLibrary: (options) => {
      if (!gateway?.listLibrary) {return Promise.reject(new Error('Library is not supported by this gateway.'))}

      return gateway.listLibrary(options)
    },
    getLibraryArtifact: (artifactId, profile) => {
      if (!gateway?.getLibraryArtifact) {return Promise.reject(new Error('Library is not supported by this gateway.'))}

      return gateway.getLibraryArtifact(artifactId, profile)
    },
    previewLibraryArtifact: (options) => {
      if (!gateway?.previewLibraryArtifact) {return Promise.reject(new Error('Library previews are not supported by this gateway.'))}

      return gateway.previewLibraryArtifact(options)
    },
    downloadLibraryArtifact: (options) => {
      if (!gateway?.downloadLibraryArtifact) {return Promise.reject(new Error('Library downloads are not supported by this gateway.'))}

      return gateway.downloadLibraryArtifact(options)
    },
    pinReviewedLibraryArtifact: (options) => {
      if (!gateway?.pinReviewedLibraryArtifact) {return Promise.reject(new Error('Library review pinning is not supported by this gateway.'))}

      return gateway.pinReviewedLibraryArtifact(options)
    }
  }

  const creationTarget = (receipt: CompanionSessionCreationReceipt): CompanionSessionTarget | null => receipt.stored_session_id
    ? { backend_namespace: receipt.backend_namespace, profile: receipt.profile, stored_session_id: receipt.stored_session_id }
    : null

  const selectCreatedTarget = (receipt: CompanionSessionCreationReceipt) => {
    const target = creationTarget(receipt)

    if (!target) {return false}
    const teammateId = [...profileIds].find(([, profile]) => profile === target.profile)?.[0]
    const teammate = teammateId ? snapshot.teammates.find((item) => item.id === teammateId) : undefined

    if (!teammateId || !teammate) {return false}
    const identity: SessionDraftIdentity = { backendNamespace: target.backend_namespace, profile: target.profile, sessionId: target.stored_session_id, sessionKind: 'stored' }
    persistedContinuationTarget = target
    activePresentationIdentity = { kind: 'session', ...identity }
    publish({ selectedTeammateId: teammateId, storedSessionId: target.stored_session_id, runtimeSessionId: receipt.runtime_session_id,
      activeSession: activeSessionPresentation(teammate, target, null) })

    return true
  }

  const completeCreation = (retry: CreationRetryEntry, receipt: CompanionSessionCreationReceipt, error: string | null = null) => {
    selectCreatedTarget(receipt)
    operationRetries.remove(retry)

    if (activeDraftIdentity?.sessionKind === 'local' && activeDraftIdentity.sessionId === retry.draftId
      && activeDraftIdentity.revision === retry.draftRevision) {
      sessionDrafts.set(activeDraftIdentity, '')
      activeDraftIdentity = receipt.stored_session_id ? {
        backendNamespace: receipt.backend_namespace, profile: receipt.profile,
        sessionId: receipt.stored_session_id, sessionKind: 'stored'
      } : activeDraftIdentity
    }

    publish({ draft: activeDraftIdentity ? sessionDrafts.get(activeDraftIdentity) : '', turnStatus: error ? 'error' : 'idle', error })
  }

  const retainCreation = (retry: CreationRetryEntry, receipt: CompanionSessionCreationReceipt, message: string) => {
    const target = creationTarget(receipt)
    operationRetries.put({ ...retry, operationStatus: receipt.operation_status === 'recovery_required' ? 'recovery_required' : receipt.operation_status,
      storedSessionId: target?.stored_session_id ?? retry.storedSessionId })

    if (target) {selectCreatedTarget(receipt)}
    publish({ turnStatus: 'uncertain', error: message })
  }

  const creationReceiptHandlers: Record<CompanionSessionCreationReceipt['operation_status'], (retry: CreationRetryEntry, receipt: CompanionSessionCreationReceipt) => void> = {
    preparing: (retry, receipt) => {
      operationRetries.put({ ...retry, operationStatus: receipt.operation_status, storedSessionId: receipt.stored_session_id })

      if (receipt.stored_session_id) {selectCreatedTarget(receipt)}
      publish({ turnStatus: 'submitting', error: null })
    },
    claimed: (retry, receipt) => creationReceiptHandlers.preparing(retry, receipt),
    admitted: (retry, receipt) => {
      operationRetries.put({ ...retry, operationStatus: receipt.operation_status, storedSessionId: receipt.stored_session_id })
      selectCreatedTarget(receipt)
      publish({ turnStatus: 'streaming', error: null })
    },
    running: (retry, receipt) => creationReceiptHandlers.admitted(retry, receipt),
    completed: (retry, receipt) => completeCreation(retry, receipt),
    failed: (retry, receipt) => completeCreation(retry, receipt, 'The new conversation failed after it was created.'),
    cancelled: (retry, receipt) => completeCreation(retry, receipt, 'The new conversation was cancelled after it was created.'),
    not_admitted: (retry, receipt) => receipt.row_state === 'present'
      ? completeCreation(retry, receipt, 'The conversation was created, but the first message was not admitted.')
      : (() => {
          operationRetries.remove(retry)
          publish({ turnStatus: 'idle', error: 'The conversation was not created. Try again when capacity is available.' })
        })(),
    interrupted_outcome_unknown: (retry, receipt) => retainCreation(retry, receipt, 'Creation was interrupted after durable binding. Reconnect to reconcile it.'),
    recovery_required: (retry, receipt) => retainCreation(retry, receipt, 'Creation recovery is required. The original request ID is retained.'),
    not_found: (retry, receipt) => retainCreation(retry, receipt, 'Creation was not found. Retry will reuse the original request ID.')
  }

  const applyCreationReceipt = (retry: CreationRetryEntry, receipt: CompanionSessionCreationReceipt) => creationReceiptHandlers[receipt.operation_status](retry, receipt)

  const reconcileCreationsAfterReconnect = async (client: CompanionGateway, connectionOperation: number) => {
    if (!ownerScope) {return}
    const entries = operationRetries.list(ownerScope).filter((entry): entry is CreationRetryEntry => entry.operationKind === 'create')

    for (const retry of entries) {
      if (!isCurrentConnection(client, connectionOperation)) {return}

      try {
        if (!client.reconcileCompanionSessionCreation) {return}

        const receipt = await client.reconcileCompanionSessionCreation({ operation_kind: 'create', backend_namespace: retry.backendNamespace,
          profile: retry.profile, client_request_id: retry.clientRequestId })

        applyCreationReceipt(retry, receipt)
      } catch (error) {
        if (isUncertainCreationFailure(error)) {
          publish({ turnStatus: 'uncertain', error: 'Creation reconciliation is uncertain. The original request ID is retained.' })
        } else {
          operationRetries.remove(retry)
          publish({ turnStatus: 'error', error: publicError(error) })
        }
      }
    }
  }

  const submitLocalCreation = async (identity: LocalSessionDraftIdentity, text: string) => {
    if (!creationLock || !ownerScope || !gateway?.createCompanionSession || connectionMode !== 'owner') {
      publish({ turnStatus: 'error', error: 'Secure exclusive creation is unavailable on this device.' })

      return
    }

    const create = gateway.createCompanionSession.bind(gateway)
    const lockName = `hermes.companion.create:${identity.ownerScope}:${identity.backendNamespace}:${identity.sessionId}`
    await creationLock.request(lockName, { ifAvailable: true, mode: 'exclusive' }, async (lock) => {
      if (!lock) {publish({ turnStatus: 'error', error: 'This draft is already being submitted.' });

 return}

      let retry = operationRetries.list(identity.ownerScope, identity.backendNamespace).find((entry): entry is CreationRetryEntry => entry.operationKind === 'create'
        && entry.ownerScope === identity.ownerScope && entry.backendNamespace === identity.backendNamespace
        && entry.draftId === identity.sessionId && entry.draftRevision === identity.revision)

      const payloadDigest = await continuationMessageDigest(text)

      if (!retry) {
        retry = { version: 2, operationKind: 'create', ownerScope: identity.ownerScope, backendNamespace: identity.backendNamespace,
          profile: identity.profile, clientRequestId: crypto.randomUUID(), draftId: identity.sessionId,
          draftRevision: identity.revision, projectId: null, messageSha256: payloadDigest,
          storedSessionId: null, operationStatus: 'untransmitted' }
        try {
          operationRetries.put(retry)
        } catch (error) {
          publish({ turnStatus: 'error', error: error instanceof Error ? error.message : 'Companion could not durably save creation retry metadata.' })

          return
        }
        const verified = operationRetries.get(retry)

        if (!verified || verified.messageSha256 !== payloadDigest) {
          publish({ turnStatus: 'error', error: 'Companion could not durably save creation retry metadata.' });

 return
        }
      } else if (retry.messageSha256 !== payloadDigest) {
        publish({ turnStatus: 'error', error: 'The submitted draft revision no longer matches its retry metadata.' });

 return
      }

      retry = { ...retry, operationStatus: 'uncertain' }
      operationRetries.put(retry)

      if (operationRetries.get(retry)?.operationStatus !== 'uncertain') {
        publish({ turnStatus: 'error', error: 'Companion could not mark creation uncertain before transmission.' });

 return
      }

      publish({ turnStatus: 'uncertain', error: null,
        messages: [...snapshot.messages, { id: `message-${++messageSequence}`, role: 'user', text }] })

      try {
        const receipt = await create({ version: 1, backend_namespace: retry.backendNamespace, profile: retry.profile,
          client_request_id: retry.clientRequestId, project_id: retry.projectId, text })

        applyCreationReceipt(retry, receipt)
      } catch (error) {
        if (isUncertainCreationFailure(error)) {
          publish({ turnStatus: 'uncertain', error: 'The new conversation may have been created. Reconnect to reconcile it; Hermes will not create it twice.' })
        } else {
          operationRetries.remove(retry)
          publish({ turnStatus: 'error', error: publicError(error) })
        }
      }
    })
  }

  const api: CompanionStore = {
    work,
    directory,
    library,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    async configure(input) {
      const operation = ++connectionGeneration
      work.reset()
      directory.reset()

      try {
        const configuration = parseGatewayBaseUrl(input.baseUrl)
        publish({ phase: 'connecting', baseUrl: configuration.baseUrl, warnings: configuration.warnings, error: null })

        if (pendingSavedToken) {await savedTokenReady}

        if (connectionGeneration !== operation || destroyed) {return}
        const replacementToken = input.token
        const token = replacementToken || savedToken

        if (!token) { throw new Error('A gateway session token is required.') }
        publish({ baseUrl: configuration.baseUrl, warnings: configuration.warnings, error: null })
        const client = await connect('connecting', operation, 'shared', token)

        if (client && isCurrentConnection(client, operation)) {
          if (replacementToken && !await persistSharedToken(client, operation, replacementToken)) {return}

          if (!isCurrentConnection(client, operation)) {return}

          if (storage) {persistGatewayBaseUrl(storage, input)}

          if (!isCurrentConnection(client, operation)) {return}

          publish({ phase: 'ready', hasSavedToken: Boolean(savedToken), canForgetSavedToken: Boolean(savedToken) })
        }
      } catch (error) {
        if (connectionGeneration === operation) {
          discardGateway(operation)
          publish({
            phase: 'setup',
            teammates: [],
            selectedTeammateId: null,
            runtimeSessionId: null,
            storedSessionId: null,
            messages: [],
            pendingApproval: null,
            streamingText: '',
            turnStatus: 'idle',
            error: publicError(error)
          })
        }
      }
    },
    async configureOwner(input) {
      const operation = ++connectionGeneration
      discardGateway(operation)
      connectionMode = 'shared'
      const identityStatePurged = resetOwnerPresentation()

      try {
        const configuration = parseGatewayBaseUrl(input.baseUrl)

        if (!identityStatePurged) {throw new DraftPersistenceError()}

        if (!ownerAuth) {throw new Error('Owner authentication is unavailable.')}
        publish({ phase: 'connecting', baseUrl: configuration.baseUrl, warnings: configuration.warnings, error: null })
        // Persist only the validated, non-secret endpoint before opening the
        // system browser so Activity recreation can resume this exact flow.
        if (storage) {persistGatewayBaseUrl(storage, { baseUrl: configuration.baseUrl, token: '' })}
        // The setup button is an explicit reauthentication request. Persisted
        // session reuse is handled by cold-start bootstrap below; preflighting
        // status here can stall on stale macOS safeStorage before browser launch.
        const status = await ownerAuth.ownerSignIn({ baseUrl: configuration.baseUrl })
        ownerScope = authenticatedOwnerScope(status)
        if (!ownerScope) {throw new Error('Authenticated owner identity is unavailable.')}

        if (connectionGeneration !== operation || destroyed) {return}
        const client = await connect('connecting', operation, 'owner')

        if (client && isCurrentConnection(client, operation)) {
          if (storage) {persistGatewayBaseUrl(storage, { baseUrl: configuration.baseUrl, token: '' })}
          await reconcileCreationsAfterReconnect(client, operation)

          if (!isCurrentConnection(client, operation)) {return}
          publish({ phase: 'ready', connectionMode: 'owner', error: null })
        }
      } catch (error) {
        if (connectionGeneration === operation) {
          discardGateway(operation)
          connectionMode = 'shared'
          publish({
            phase: 'setup',
            connectionMode: 'shared',
            teammates: [],
            selectedTeammateId: null,
            runtimeSessionId: null,
            storedSessionId: null,
            messages: [],
            pendingApproval: null,
            streamingText: '',
            turnStatus: 'idle',
            error: publicError(error)
          })
        }
      }
    },
    async connectOwner() {
      const preservedActiveSession = snapshot.activeSession
      const retry = continuityRetry
      const operation = ++connectionGeneration

      try {
        if (!ownerScope) {
          if (!ownerAuth) {throw new Error('Owner authentication is unavailable.')}
          ownerScope = authenticatedOwnerScope(await ownerAuth.ownerStatus({ baseUrl: snapshot.baseUrl }))
          if (!ownerScope) {throw new Error('Authenticated owner identity is unavailable.')}
        }
        const client = await connect('recovering', operation, 'owner')

        if (!client || !isCurrentConnection(client, operation)) {return}

        if (retry && !await reconcileContinuityAfterReconnect(client, operation, retry, preservedActiveSession)) {return}
        await reconcileCreationsAfterReconnect(client, operation)

        if (isCurrentConnection(client, operation)) {publish({ phase: 'ready', error: null })}
      } catch (error) {
        if (connectionGeneration === operation) {
          discardGateway(operation)
          publish({ phase: 'disconnected', error: publicError(error) })
        }

        throw error
      }
    },
    async signOutOwner() {
      const operation = ++connectionGeneration
      discardGateway(operation)
      connectionMode = 'shared'
      const identityStatePurged = resetOwnerPresentation()

      ownerScope = null

      try {await ownerAuth?.ownerSignOut({ baseUrl: snapshot.baseUrl })} catch {
        publish({ error: 'Owner sign-out could not be verified. The connection was closed.' })
      }

      if (!identityStatePurged && snapshot.error === null) {publish({ error: DRAFT_PERSISTENCE_ERROR })}
    },
    async selectTeammate(teammateId, storedSessionId) {
      const client = gateway

      if (!client || snapshot.phase !== 'ready') {return}
      const profileId = profileIds.get(teammateId)
      const teammate = snapshot.teammates.find((item) => item.id === teammateId)

      if (!profileId || !teammate) {return}

      if (!storedSessionId) {
        await api.openBotChat(teammateId)

        return
      }

      const connectionOperation = connectionGeneration
      const sessionOperation = beginSessionOperation()
      activePresentationIdentity = { kind: 'pending', operation: sessionOperation }
      persistedContinuationTarget = null
      completedSessionId = null
      pendingSubmit = null
      const draft = deactivateDraft()

      const selectedSummary = storedSessionId
        ? snapshot.recentSessions.find((session) => session.id === storedSessionId || session.resolved_id === storedSessionId)
        : null

      publish({
        selectedTeammateId: teammateId,
        runtimeSessionId: null,
        storedSessionId: null,
        activeSession: activeSessionPresentation(teammate, null, storedSessionId ? selectedSummary?.title ?? null : 'Bot Chat'),
        messages: [],
        streamingText: '',
        pendingApproval: null,
        draft,
        recentSessions: [],
        sessionsLoading: true,
        turnStatus: 'idle',
        error: null
      })
      void loadSessions(client, teammateId)

      try {
        const result = await client.resumeSession(storedSessionId, profileId)

        const applied = await applySession(client, result, connectionOperation, sessionOperation)

        if (applied) {void loadSessions(client, teammateId)}
      } catch (error) {
        if (isCurrentConnection(client, connectionOperation) && sessionGeneration === sessionOperation) {
          publish({ error: publicError(error) })
        }
      }
    },
    async openPersistedSession(target, submittedText, authoritativeTitle) {
      const client = gateway
      const rawText = submittedText
      const text = rawText.trim()

      if (!client || snapshot.phase !== 'ready') {throw new Error('Companion is not connected.')}

      if (connectionMode !== 'owner') {throw new Error('Owner authentication is required to continue a saved conversation.')}

      if (!text || text.length > MAX_CONTINUATION_TEXT_LENGTH) {throw new Error('Enter a bounded message to continue this conversation.')}

      if (!validBoundedString(target.backend_namespace, 4_096)
        || !validBoundedString(target.profile, 4_096)
        || !validBoundedString(target.stored_session_id, 512)) {throw new Error('The saved conversation target is invalid.')}

      const teammateId = [...profileIds].find(([, profile]) => profile === target.profile)?.[0]

      if (!teammateId) {throw new Error('The saved conversation profile is unavailable.')}
      const teammate = snapshot.teammates.find((item) => item.id === teammateId)

      if (!teammate) {throw new Error('The saved conversation agent is unavailable.')}
      const directorySnapshot = directory.getSnapshot()

      const directorySession = [directorySnapshot.selectedSession, ...directorySnapshot.sessions]
        .find((item) => item?.id === target.stored_session_id
          && item.profile === target.profile
          && item.source === target.backend_namespace)

      const title = typeof authoritativeTitle === 'string' && authoritativeTitle.length
        ? authoritativeTitle
        : directorySession?.title ?? null

      if (!isActivePersistedDraft(target)) {
        activatePersistedDraft(target)
      }

      // Bind the persisted target and durable operation identity before the
      // first asynchronous boundary. Once an outcome is uncertain this method
      // may only reconcile that operation; it must never submit a fresh turn.
      persistedContinuationTarget = { ...target }
      activePresentationIdentity = presentationIdentityForTarget(target)
      const activeSession = activeSessionPresentation(teammate, target, title, directorySession?.project)
      const connectionOperation = connectionGeneration
      const sessionOperation = beginSessionOperation()
      const existingRetry = continuityRetry

      if (existingRetry) {
        if (!sameContinuationTarget(existingRetry.target, target)) {throw new UncertainContinuationError()}
        pendingSubmit = null
        publish({
          selectedTeammateId: teammateId,
          runtimeSessionId: null,
          storedSessionId: target.stored_session_id,
          activeSession,
          streamingText: '',
          pendingApproval: null,
          draft: rawText,
          turnStatus: 'sending',
          error: null
        })

        try {
          const result = await client.reconcileCompanionSession({
            ...target, client_request_id: existingRetry.clientRequestId
          })

          if (!isCurrentConnection(client, connectionOperation) || sessionGeneration !== sessionOperation) {
            throw new Error('The saved conversation changed before reconciliation completed.')
          }

          if (result.operation_status === 'claimed'
            || result.operation_status === 'admitted'
            || result.operation_status === 'running') {
            throw new UncertainContinuationError()
          }

          continuityRetry = null
          clearContinuityRetry(storage)

          if (result.operation_status !== 'completed') {
            throw new Error('The previous continuation was not completed. Send again to start a new turn.')
          }

          const reconciledHistory = await client.getCompanionSessionHistory(
            target.profile, target.stored_session_id, undefined, target.backend_namespace
          )

          if (!isCurrentConnection(client, connectionOperation) || sessionGeneration !== sessionOperation) {return}
          const digestCandidate = snapshot.draft

          const currentDigest = existingRetry.messageSha256 && digestCandidate
            ? await continuationMessageDigest(digestCandidate).catch(() => null)
            : null

          if (!isCurrentConnection(client, connectionOperation) || sessionGeneration !== sessionOperation) {return}

          const draft = existingRetry.messageSha256
            && snapshot.draft === digestCandidate
            && currentDigest === existingRetry.messageSha256
            ? ''
            : snapshot.draft

          publish({
            messages: toPersistedMessages(reconciledHistory),
            draft,
            turnStatus: 'idle',
            error: null
          })

          return
        } catch (error) {
          if (isCurrentConnection(client, connectionOperation) && sessionGeneration === sessionOperation) {
            const uncertain = isUncertainContinuationFailure(error)

            if (!uncertain) {
              continuityRetry = null
              clearContinuityRetry(storage)
            }

            publish({ draft: snapshot.draft, turnStatus: uncertain ? 'uncertain' : 'idle', error: publicError(error) })
          }

          throw error
        }
      }

      const retry: ContinuityRetryMetadata = {
        target: { ...target }, messageSha256: null, clientRequestId: clientRequestId()
      }

      const isCurrentDraftSession = () => isCurrentConnection(client, connectionOperation)
        && sessionGeneration === sessionOperation
        && isActivePersistedDraft(target)

      const abandonUnsentRetry = () => {
        if (continuityRetry !== retry) {return}
        continuityRetry = null
        clearContinuityRetry(storage)
      }

      let continuationOperation: NonNullable<typeof pendingContinuation> | null = null
      let submitted = false

      try {
        continuityRetry = retry
        persistContinuityRetry(storage, retry)
        pendingSubmit = null
        publish({
          selectedTeammateId: teammateId,
          runtimeSessionId: null,
          storedSessionId: target.stored_session_id,
          activeSession,
          streamingText: '',
          pendingApproval: null,
          draft: rawText,
          turnStatus: 'sending',
          error: null
        })

        const messageSha256 = await continuationMessageDigest(rawText)

        if (!isCurrentDraftSession()) {
          abandonUnsentRetry()
          throw new Error('The saved conversation changed before continuation completed.')
        }

        retry.messageSha256 = messageSha256
        persistContinuityRetry(storage, retry)
        const loadedHistory = directory.getSnapshot().history

        const history = loadedHistory?.profile === target.profile
          && loadedHistory.source === target.backend_namespace
          && loadedHistory.session_id === target.stored_session_id
          ? loadedHistory
          : await client.getCompanionSessionHistory(
              target.profile, target.stored_session_id, undefined, target.backend_namespace
            )

        if (!isCurrentDraftSession()) {
          abandonUnsentRetry()
          throw new Error('The saved conversation changed before continuation completed.')
        }

        const preservedMessages = toPersistedMessages(history)
        publish({ messages: preservedMessages })

        const activeContinuationOperation = {
          client,
          connectionGeneration: connectionOperation,
          sessionGeneration: sessionOperation,
          terminalEvents: new Map<string, TerminalCompanionEvent>()
        }

        continuationOperation = activeContinuationOperation
        pendingContinuation = activeContinuationOperation
        submitted = true

        const result = await client.continueCompanionSession({
          ...target, text, client_request_id: retry.clientRequestId
        })

        if (result.status === 'uncertain') {throw new UncertainContinuationError()}

        if (!isCurrentConnection(client, connectionOperation) || sessionGeneration !== sessionOperation) {
          throw new Error('The saved conversation changed before continuation completed.')
        }

        if (!await applySession(client, result, connectionOperation, sessionOperation, preservedMessages, () => {
          continuityRetry = null
          clearContinuityRetry(storage)
          persistedContinuationTarget = { ...target }
          publish({
            draft: snapshot.draft === rawText ? '' : snapshot.draft,
            messages: [...snapshot.messages, { id: `message-${++messageSequence}`, role: 'user', text }],
            turnStatus: 'streaming'
          })

          if (pendingContinuation === activeContinuationOperation) {pendingContinuation = null}
          const terminalEvent = activeContinuationOperation.terminalEvents.get(result.session_id)
          activeContinuationOperation.terminalEvents.clear()

          if (terminalEvent) {handleEvent(terminalEvent)}
        })) {
          throw new Error('The saved conversation changed before continuation completed.')
        }
      } catch (error) {
        if (!submitted) {abandonUnsentRetry()}

        if (isCurrentConnection(client, connectionOperation) && sessionGeneration === sessionOperation) {
          const uncertain = submitted && isUncertainContinuationFailure(error)

          if (!uncertain) {
            continuityRetry = null
            clearContinuityRetry(storage)
          }

          publish({ draft: snapshot.draft, turnStatus: uncertain ? 'uncertain' : 'idle', error: publicError(error) })
        }

        throw error
      } finally {
        if (continuationOperation && pendingContinuation === continuationOperation) {pendingContinuation = null}
      }
    },
    async refreshAttention() {
      const client = gateway

      if (!client || snapshot.phase !== 'ready') {return}

      try { await loadAttention(client, connectionGeneration) } catch (error) { publish({ error: publicError(error) }) }
    },
    async openAttention(item) {
      const client = gateway

      if (!client || snapshot.phase !== 'ready' || !item.stored_session_id) {return}
      const teammateId = [...profileIds].find(([, profile]) => profile === item.profile)?.[0]

      if (!teammateId) {return}
      const connectionOperation = connectionGeneration
      const sessionOperation = beginSessionOperation()
      activePresentationIdentity = { kind: 'pending', operation: sessionOperation }
      persistedContinuationTarget = null
      const draft = deactivateDraft()
      publish({
        selectedTeammateId: teammateId,
        runtimeSessionId: null,
        storedSessionId: null,
        activeSession: activeSessionPresentation(snapshot.teammates.find((teammate) => teammate.id === teammateId)!, null, item.title || null),
        messages: [], pendingApproval: null, draft, error: null
      })

      try {
        const result = await client.resumeSession(item.stored_session_id, item.profile)
        const applied = await applySession(client, result, connectionOperation, sessionOperation)

        if (applied) {void loadSessions(client, teammateId)}
      } catch (error) {
        if (isCurrentConnection(client, connectionOperation) && sessionGeneration === sessionOperation) {
          publish({ error: publicError(error) })
        }
      }
    },
    async refreshSessions() {
      const client = gateway
      const teammateId = snapshot.selectedTeammateId

      if (client && teammateId) {await loadSessions(client, teammateId)}
    },
    async setSessionPinned(sessionId, pinned) {
      const client = gateway
      const teammateId = snapshot.selectedTeammateId
      const profile = teammateId ? profileIds.get(teammateId) : undefined

      if (!client || !profile) {return}
      const connectionOperation = connectionGeneration
      const sessionOperation = sessionGeneration

      const isCurrentPinOperation = () => isCurrentConnection(client, connectionOperation)
        && sessionGeneration === sessionOperation
        && snapshot.selectedTeammateId === teammateId
        && profileIds.get(teammateId!) === profile

      try {
        if (pinsSupported) {
          try {
            await client.setSessionPinned(profile, sessionId, pinned)
          } catch (error) {
            if (!isCurrentPinOperation()) {return}

            if (!isUnsupportedMethod(error)) {throw error}
            pinsSupported = false
          }
        }

        if (!isCurrentPinOperation()) {return}

        const key = localPinKey(profile, sessionId)

        if (pinsSupported) {localPins.delete(key)}
        else if (pinned) {localPins.add(key)}
        else {localPins.delete(key)}

        persistLocalPins()
        publish({ recentSessions: snapshot.recentSessions.map((session) => session.id === sessionId ? { ...session, pinned } : session) })
      } catch (error) {
        if (isCurrentPinOperation()) {publish({ error: publicError(error) })}
      }
    },
    async openBotChat(teammateId = snapshot.selectedTeammateId ?? 'atlas') {
      const profile = profileIds.get(teammateId)
      const client = gateway

      if (client && profile && !client.createCompanionSession && snapshot.phase === 'ready') {
        const connectionOperation = connectionGeneration
        const sessionOperation = beginSessionOperation()
        activePresentationIdentity = { kind: 'pending', operation: sessionOperation }
        persistedContinuationTarget = null
        const draft = deactivateDraft()
        const teammate = snapshot.teammates.find((item) => item.id === teammateId)!
        publish({ selectedTeammateId: teammateId, runtimeSessionId: null, storedSessionId: null,
          activeSession: activeSessionPresentation(teammate, null, 'Bot Chat'), messages: [], pendingApproval: null, draft, error: null })
        void loadSessions(client, teammateId)

        try {
          const result = await resolveLegacyBotChat(client, profile)
          const applied = await applySession(client, result, connectionOperation, sessionOperation)

          if (applied) {void loadSessions(client, teammateId)}
        } catch (error) {
          if (isCurrentConnection(client, connectionOperation) && sessionGeneration === sessionOperation) {publish({ error: publicError(error) })}
        }

        return
      }

      const backendNamespace = profile ? backendNamespaceForProfile(profile) : null
      const teammate = snapshot.teammates.find((item) => item.id === teammateId)

      if (!gateway || !profile || !teammate || !ownerScope || !backendNamespace
        || connectionMode !== 'owner' || snapshot.phase !== 'ready' || !creationLock) {
        publish({ error: 'Durable conversation creation is unavailable for this connection.' })

        return
      }

      beginSessionOperation()
      persistedContinuationTarget = null
      deactivateDraft()
      activeDraftIdentity = { ownerScope, backendNamespace, profile, projectId: null,
        sessionId: crypto.randomUUID(), sessionKind: 'local', revision: 1 }
      activePresentationIdentity = { kind: 'session', ...activeDraftIdentity }
      publish({ selectedTeammateId: teammateId, runtimeSessionId: null, storedSessionId: null,
        activeSession: activeSessionPresentation(teammate, null, 'New conversation'), messages: [], pendingApproval: null,
        draft: sessionDrafts.get(activeDraftIdentity), turnStatus: 'idle', error: null })
    },
    async submitQuickTask(teammateId, text) {
      const task = text.trim()

      if (!task) {return}
      const sessionOperation = sessionGeneration + 1
      await api.openBotChat(teammateId)

      if (sessionGeneration !== sessionOperation) {return}
      api.setDraft(text)
      await api.submitDraft()
    },
    activateSessionDraft(target) {
      if (!isActivePersistedDraft(target)) {
        beginSessionOperation()
        activePresentationIdentity = presentationIdentityForTarget(target)
        persistedContinuationTarget = null
        pendingSubmit = null
        pendingInterrupt = null
        interruptedTurn = null
        completedSessionId = null
        publish({
          runtimeSessionId: null,
          storedSessionId: target.stored_session_id,
          activeSession: snapshot.activeSession?.target
            && sameContinuationTarget(snapshot.activeSession.target, target)
            ? snapshot.activeSession
            : null,
          streamingText: '',
          pendingApproval: null,
          turnStatus: 'idle',
          error: null
        })
      }

      activePresentationIdentity = presentationIdentityForTarget(target)
      publish({ draft: activatePersistedDraft(target) })
    },
    setDraft(draft) {
      if (activeDraftIdentity?.sessionKind === 'local' && draft !== snapshot.draft) {
        const previous = activeDraftIdentity
        const next: LocalSessionDraftIdentity = { ...previous, revision: previous.revision + 1 }

        const submitted = operationRetries.list(previous.ownerScope, previous.backendNamespace).some((entry) => entry.operationKind === 'create'
          && entry.draftId === previous.sessionId && entry.draftRevision === previous.revision)

        if (submitted) {sessionDrafts.set(next, draft)} else {sessionDrafts.rekey(previous, next, draft)}
        activeDraftIdentity = next
        activePresentationIdentity = { kind: 'session', ...next }
      }

      publish({ draft })
    },
    async submitDraft() {
      const client = gateway
      const runtimeId = snapshot.runtimeSessionId
      const draftAtSubmission = snapshot.draft
      const text = draftAtSubmission.trim()

      if (!client || !text || snapshot.phase !== 'ready') {return}

      if (activeDraftIdentity?.sessionKind === 'local') {
        await submitLocalCreation(activeDraftIdentity, draftAtSubmission)

        return
      }

      if (persistedContinuationTarget) {
        await api.openPersistedSession(persistedContinuationTarget, draftAtSubmission, snapshot.activeSession?.title ?? undefined)

        return
      }

      if (!runtimeId) {return}

      const submittedTurn = {
        client,
        connectionGeneration,
        sessionGeneration,
        runtimeSessionId: runtimeId,
        text,
        draftAtSubmission,
        userRecorded: false,
        completed: false
      }

      pendingSubmit = submittedTurn
      interruptedTurn = null
      handledTerminal = null
      publish({ streamingText: '', turnStatus: 'submitting', error: null })

      try {
        await client.submitPrompt(runtimeId, text)

        if (gateway !== client
          || connectionGeneration !== submittedTurn.connectionGeneration
          || sessionGeneration !== submittedTurn.sessionGeneration
          || snapshot.runtimeSessionId !== runtimeId) {return}

        const disconnected = isDisconnected() || gateway !== client

        const messages = submittedTurn.userRecorded
          ? snapshot.messages
          : [...snapshot.messages, { id: `message-${++messageSequence}`, role: 'user' as const, text }]

        submittedTurn.userRecorded = true

        publish({
          draft: snapshot.draft === draftAtSubmission ? '' : snapshot.draft,
          messages,
          turnStatus: snapshot.turnStatus === 'interrupted'
            ? 'interrupted'
            : submittedTurn.completed
            ? 'idle'
            : snapshot.turnStatus === 'stopping'
              ? 'stopping'
              : disconnected ? 'uncertain' : 'streaming'
        })
      } catch (error) {
        if (gateway === client
          && connectionGeneration === submittedTurn.connectionGeneration
          && sessionGeneration === submittedTurn.sessionGeneration
          && !isDisconnected()
          && snapshot.turnStatus !== 'interrupted'
          && !submittedTurn.completed) {publish({ turnStatus: 'idle', error: publicError(error) })}
      } finally {
        if (pendingSubmit === submittedTurn) {pendingSubmit = null}
      }
    },
    async interrupt() {
      const client = gateway
      const runtimeId = snapshot.runtimeSessionId
      const connectionOperation = connectionGeneration
      const sessionOperation = sessionGeneration

      if (!client
        || !runtimeId
        || snapshot.phase !== 'ready'
        || (snapshot.turnStatus !== 'submitting' && snapshot.turnStatus !== 'streaming')
        || pendingInterrupt) {return}

      const operation = {
        client,
        connectionGeneration: connectionOperation,
        sessionGeneration: sessionOperation,
        runtimeSessionId: runtimeId,
        previousTurnStatus: snapshot.turnStatus
      } as const

      pendingInterrupt = operation
      publish({ turnStatus: 'stopping', error: null })

      try {
        await client.interruptSession(runtimeId)

        if (pendingInterrupt === operation
          && isCurrentConnection(client, connectionOperation)
          && sessionGeneration === sessionOperation
          && snapshot.runtimeSessionId === runtimeId) {
          pendingInterrupt = null
          interruptedTurn = {
            client,
            connectionGeneration: connectionOperation,
            sessionGeneration: sessionOperation,
            runtimeSessionId: runtimeId
          }
          publish({ turnStatus: 'interrupted' })
        }
      } catch {
        if (pendingInterrupt === operation
          && isCurrentConnection(client, connectionOperation)
          && sessionGeneration === sessionOperation
          && snapshot.runtimeSessionId === runtimeId
          && snapshot.phase === 'ready') {
          pendingInterrupt = null
          publish({
            turnStatus: operation.previousTurnStatus,
            error: 'Stop failed. The turn may still be running; try again.'
          })
        }
      } finally {
        if (pendingInterrupt === operation) {pendingInterrupt = null}
      }
    },
    async respondToApproval(choice) {
      const approval = snapshot.pendingApproval
      const client = gateway

      if (!approval || !client || snapshot.phase !== 'ready') {return}
      const connectionOperation = connectionGeneration
      const sessionOperation = sessionGeneration
      publish({ pendingApproval: { ...approval, responding: true }, error: null })

      try {
        const result = await client.respondToApproval(approval.sessionId, approval.requestId, choice)

        const isSameApproval = isCurrentConnection(client, connectionOperation)
          && sessionGeneration === sessionOperation
          && snapshot.pendingApproval?.sessionId === approval.sessionId
          && snapshot.pendingApproval.requestId === approval.requestId

        if (result.resolved > 0 && isSameApproval) {
          publish({ pendingApproval: null })
          void loadAttention(client, connectionOperation).catch(() => undefined)
        } else if (isSameApproval) {
          publish({ pendingApproval: { ...approval, responding: false }, error: 'The approval is still pending.' })
        }
      } catch (error) {
        if (isCurrentConnection(client, connectionOperation)
          && sessionGeneration === sessionOperation
          && snapshot.pendingApproval?.sessionId === approval.sessionId
          && snapshot.pendingApproval.requestId === approval.requestId) {
          publish({ pendingApproval: { ...approval, responding: false }, error: publicError(error) })
        }
      }
    },
    async recover() {
      const selectedId = snapshot.selectedTeammateId
      const preservedActiveSession = snapshot.activeSession

      const selectedDraftTarget = activeDraftIdentity?.sessionKind === 'stored'
        && activeDraftIdentity.sessionId === snapshot.storedSessionId
        ? {
            backend_namespace: activeDraftIdentity.backendNamespace,
            profile: activeDraftIdentity.profile,
            stored_session_id: activeDraftIdentity.sessionId
          }
        : null

      const activeTarget = preservedActiveSession?.target ?? persistedContinuationTarget
      const recoveryTarget = activeTarget ?? selectedDraftTarget
      const profileId = recoveryTarget?.profile ?? (selectedId ? profileIds.get(selectedId) : undefined)
      const storedId = recoveryTarget?.stored_session_id ?? snapshot.storedSessionId
      const retry = continuityRetry

      const connectionOperation = ++connectionGeneration

      try {
        const client = await connect('recovering', connectionOperation, connectionMode)

        if (!client || !isCurrentConnection(client, connectionOperation)) {return}

        if (retry) {
          if (!await reconcileContinuityAfterReconnect(client, connectionOperation, retry, preservedActiveSession)) {return}
        } else if (selectedId && profileId) {
          const sessionOperation = beginSessionOperation()

          if (!storedId) {throw new Error('Creation recovery requires request reconciliation.')}
          const result = await client.resumeSession(storedId, profileId)

          const recoveredResult = recoveryTarget
            ? {
                ...result,
                backend_namespace: typeof result.backend_namespace === 'string'
                  ? result.backend_namespace
                  : recoveryTarget.backend_namespace,
                profile: typeof result.profile === 'string' ? result.profile : recoveryTarget.profile
              }
            : result

          if (!await applySession(client, recoveredResult, connectionOperation, sessionOperation)) {return}

          if (activeTarget && preservedActiveSession) {
            persistedContinuationTarget = { ...activeTarget }
            publish({ storedSessionId: activeTarget.stored_session_id, activeSession: preservedActiveSession })
          }
        } else {
          publish({ runtimeSessionId: null, storedSessionId: null, messages: [], pendingApproval: null, turnStatus: 'idle' })
        }

        if (isCurrentConnection(client, connectionOperation)) {publish({ phase: 'ready', error: null })}
      } catch (error) {
        if (connectionGeneration === connectionOperation) {
          discardGateway(connectionOperation)
          publish({ phase: 'disconnected', error: publicError(error) })
        }
      }
    },
    async forgetSavedToken() {
      try {
        await mutateSecret(() => secrets.delete(TOKEN_SECRET_NAME))
        savedToken = undefined
        savedTokenError = null

        try {
          sessionDrafts.clear()
          draftPersistenceWarning = false
        } catch {
          draftPersistenceWarning = true
        }

        activeDraftIdentity = null
        activePresentationIdentity = null
        publish({
          draft: '', hasSavedToken: false, canForgetSavedToken: false,
          error: draftPersistenceWarning ? DRAFT_PERSISTENCE_ERROR : null
        })
      } catch {
        publish({ error: SECURE_CREDENTIAL_ERROR })
      }
    },
    destroy() {
      if (destroyed) {return}
      destroyed = true
      work.disconnect()
      directory.disconnect()
      connectionGeneration += 1
      sessionGeneration += 1
      clearContinuationEventState()
      detachGateway()
      gateway?.close()
      gateway = null
      void secrets.clear()
      listeners.clear()
    }
  }

  if (ownerAuth && snapshot.baseUrl) {
    const bootstrapBaseUrl = snapshot.baseUrl
    const bootstrapGeneration = connectionGeneration

    void ownerAuth.ownerStatus({ baseUrl: bootstrapBaseUrl }).then((status) => {
      const authenticatedScope = authenticatedOwnerScope(status)

      if (destroyed
        || connectionGeneration !== bootstrapGeneration
        || snapshot.phase !== 'setup'
        || !authenticatedScope) {return}

      ownerScope = authenticatedScope
      return api.connectOwner()
    }).catch((error: unknown) => {
      if (!destroyed && connectionGeneration === bootstrapGeneration && snapshot.phase === 'setup') {
        publish({ error: publicError(error) })
      }
    })
  }

  return api
}
