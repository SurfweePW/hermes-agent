import type { ConnectionState } from '@hermes/shared'

import type { Teammate } from '../features/roster/roster'
import { createWorkStore, type WorkStore } from '../features/work/work-store'
import { CompanionClient } from '../gateway/companion-client'
import {
  buildGatewayWebSocketUrl,
  GATEWAY_BASE_URL_STORAGE_KEY,
  parseGatewayBaseUrl,
  persistGatewayBaseUrl
} from '../gateway/connection'
import type {
  ApprovalChoice,
  ApprovalRequestPayload,
  ApprovalRespondResult,
  AttentionListResult,
  CompanionEvent,
  CompanionEventHandler,
  CreateSessionOptions,
  GatewayAttentionItem,
  GatewaySessionSummary,
  PendingApprovalsResult,
  ProfilesListResult,
  PromptSubmitResult,
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

export type CompanionPhase = 'setup' | 'connecting' | 'ready' | 'disconnected' | 'recovering'
export type CompanionConnectionMode = 'shared' | 'owner'
export type TurnStatus = 'idle' | 'submitting' | 'streaming' | 'uncertain'
export type MessageRole = 'user' | 'assistant' | 'system'

export interface CompanionMessage {
  id: string
  role: MessageRole
  text: string
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

export interface CompanionSnapshot {
  phase: CompanionPhase
  baseUrl: string
  warnings: readonly string[]
  teammates: readonly Teammate[]
  selectedTeammateId: string | null
  runtimeSessionId: string | null
  storedSessionId: string | null
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

export interface CompanionGateway extends Partial<WorkGateway> {
  readonly connectionState: ConnectionState
  connect(wsUrl: string): Promise<void>
  close(): void
  onEvent(handler: CompanionEventHandler): () => void
  onState(handler: (state: ConnectionState) => void): () => void
  listProfiles(): Promise<ProfilesListResult>
  createSession(options?: CreateSessionOptions): Promise<SessionResult>
  resumeSession(storedSessionId: string, profile?: string): Promise<SessionResult>
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
}

export interface CompanionStoreOptions {
  gatewayFactory?: CompanionGatewayFactory
  storage?: CompanionStorage
  secretStore?: SessionSecretStore
  ownerAuthBridge?: OwnerAuthBridge
}

export interface CompanionStore {
  work: WorkStore
  getSnapshot(): CompanionSnapshot
  subscribe(listener: () => void): () => void
  configure(input: { baseUrl: string; token: string }): Promise<void>
  configureOwner(input: { baseUrl: string }): Promise<void>
  connectOwner(): Promise<void>
  signOutOwner(): Promise<void>
  selectTeammate(teammateId: string, storedSessionId?: string): Promise<void>
  refreshAttention(): Promise<void>
  openAttention(item: GatewayAttentionItem): Promise<void>
  refreshSessions(): Promise<void>
  setSessionPinned(sessionId: string, pinned: boolean): Promise<void>
  openBotChat(teammateId?: string): Promise<void>
  submitQuickTask(teammateId: string, text: string): Promise<void>
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

  if (state.turnStatus === 'streaming' || state.turnStatus === 'submitting') {
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

class SecureCredentialError extends Error {
  constructor() {
    super(SECURE_CREDENTIAL_ERROR)
    this.name = 'SecureCredentialError'
  }
}

function publicError(error: unknown): string {
  if (error instanceof SecureCredentialError) { return error.message }

  if (error instanceof Error && /url|required|http|gateway/i.test(error.message) && !/[?&](token|ticket)=/i.test(error.message)) {
    return error.message
  }

  return 'Companion could not reach the gateway. Check the connection and try again.'
}

function isUnsupportedMethod(error: unknown): boolean {
  if (!(error instanceof Error)) {return false}

  const code = 'code' in error ? (error as Error & { code?: unknown }).code : undefined

  return code === -32601 || /(?:method not found|unknown method|-32601)/i.test(error.message)
}

function hasExistingOwnerSession(status: unknown): boolean {
  return typeof status === 'object'
    && status !== null
    && 'signedIn' in status
    && (status as { signedIn?: unknown }).signedIn === true
}

export function createCompanionStore(options: CompanionStoreOptions = {}): CompanionStore {
  const work = createWorkStore()
  const gatewayFactory = options.gatewayFactory ?? (() => new CompanionClient())
  const storage = options.storage ?? browserStorage()
  const secrets = options.secretStore ?? createDefaultSecretStore()
  const ownerAuth = options.ownerAuthBridge ?? getOwnerAuthBridge()
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
    userRecorded: boolean
    completed: boolean
  } | null = null

  let snapshot = freezeSnapshot({
    phase: 'setup',
    baseUrl: safeStoredBaseUrl(storage),
    warnings: [],
    teammates: [],
    selectedTeammateId: null,
    runtimeSessionId: null,
    storedSessionId: null,
    messages: [],
    streamingText: '',
    pendingApproval: null,
    attentionItems: [],
    attentionScope: 'This gateway runtime only',
    recentSessions: [],
    sessionsLoading: false,
    draft: '',
    turnStatus: 'idle',
    error: savedTokenError,
    hasSavedToken: Boolean(savedToken),
    canForgetSavedToken: Boolean(savedToken || savedTokenError),
    storesTokenEncrypted: secrets.persistent,
    ownerAuthAvailable: Boolean(ownerAuth),
    connectionMode
  })

  const publish = (changes: Partial<CompanionSnapshot>) => {
    if (destroyed) {return}
    const next = { ...snapshot, ...changes }

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
    completedSessionId = null
    sessionGeneration += 1
  }

  const handleEvent = (event: CompanionEvent) => {
    if (event.type === 'approval.request' || event.type === 'message.complete' || event.type === 'error') {
      const client = gateway

      if (client) {
        void loadAttention(client, connectionGeneration).catch(() => undefined)
      }
    }

    if (event.session_id !== snapshot.runtimeSessionId) {return}

    if (event.type === 'message.delta') {
      publish({ streamingText: snapshot.streamingText + event.payload.text, turnStatus: 'streaming' })

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
      completedSessionId = event.session_id
      publish({
        draft: submittedTurn && snapshot.draft === submittedTurn.text ? '' : snapshot.draft,
        messages,
        streamingText: '',
        turnStatus: 'idle'
      })

      return
    }

    if (event.type === 'approval.request') {
      publish({ pendingApproval: approvalFromPayload(event.session_id, event.payload) })
    }
  }

  const handleState = (state: ConnectionState) => {
    if (state !== 'closed' && state !== 'error') {return}
    work.disconnect()
    publish({
      phase: 'disconnected',
      turnStatus: snapshot.turnStatus === 'streaming' || snapshot.turnStatus === 'submitting'
        ? 'uncertain'
        : snapshot.turnStatus,
      error: null
    })
  }

  const installGateway = (generation: number) => {
    const replaced = gateway
    work.disconnect()
    detachGateway()
    replaced?.close()
    const client = gatewayFactory()
    gateway = client
    attentionSupported = true
    pinsSupported = true
    canonicalSessions.clear()
    sessionGeneration += 1
    completedSessionId = null
    pendingSubmit = null
    publish({ runtimeSessionId: null, pendingApproval: null, streamingText: '', turnStatus: 'idle' })
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
    sessionOperation: number
  ) => {
    if (!isCurrentConnection(client, connectionOperation) || sessionGeneration !== sessionOperation) {return false}
    completedSessionId = null
    publish({
      runtimeSessionId: result.session_id,
      storedSessionId: result.stored_session_id,
      messages: toMessages(result.messages),
      streamingText: '',
      pendingApproval: null,
      turnStatus: 'idle'
    })
    const pending = await client.listPendingApprovals(result.session_id)

    if (!isCurrentConnection(client, connectionOperation)
      || sessionGeneration !== sessionOperation
      || snapshot.runtimeSessionId !== result.session_id) {return false}

    publish({ pendingApproval: pending.approvals[0] ? approvalFromPayload(result.session_id, pending.approvals[0]) : null })

    return true
  }

  const resolveBotChat = async (client: CompanionGateway, profile: string) => {
    const inFlight = canonicalSessions.get(profile)

    if (inFlight) {return inFlight}

    const operation = (async () => {
      const found = await client.listSessions({
        profile,
        limit: 1,
        include_hidden: true,
        include_archived: true,
        title: 'Bot Chat'
      })

      const exact = found.sessions.find((session) => session.title === 'Bot Chat')

      if (exact) {return client.resumeSession(exact.resolved_id ?? exact.id, profile)}

      try {
        return await client.createSession({ profile, title: 'Bot Chat', hidden: true, source: 'companion' })
      } catch (error) {
        // Another client may have won the unique-title race, or an archived
        // canonical row may exist on a gateway that ignores include_archived.
        try {return await client.resumeSession('Bot Chat', profile)} catch {throw error}
      }
    })()

    canonicalSessions.set(profile, operation)

    try {return await operation} finally {
      if (canonicalSessions.get(profile) === operation) {canonicalSessions.delete(profile)}
    }
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
    await work.attach(client, [...profileIds.values()])

    if (!isCurrentConnection(client, operation)) {return null}

    connectionMode = mode
    publish({ connectionMode: mode })

    return client
  }

  return {
    work,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    async configure(input) {
      const operation = ++connectionGeneration
      work.reset()

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
      work.reset()
      const operation = ++connectionGeneration

      try {
        const configuration = parseGatewayBaseUrl(input.baseUrl)

        if (!ownerAuth) {throw new Error('Owner authentication is unavailable.')}
        publish({ phase: 'connecting', baseUrl: configuration.baseUrl, warnings: configuration.warnings, error: null })
        const ownerStatus = await ownerAuth.ownerStatus({ baseUrl: configuration.baseUrl })

        if (connectionGeneration !== operation || destroyed) {return}

        if (!hasExistingOwnerSession(ownerStatus)) {
          await ownerAuth.ownerSignIn({ baseUrl: configuration.baseUrl })
        }

        if (connectionGeneration !== operation || destroyed) {return}
        const client = await connect('connecting', operation, 'owner')

        if (client && isCurrentConnection(client, operation)) {
          if (storage) {persistGatewayBaseUrl(storage, { baseUrl: configuration.baseUrl, token: '' })}
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
      const operation = ++connectionGeneration

      try {
        const client = await connect('recovering', operation, 'owner')

        if (client && isCurrentConnection(client, operation)) {publish({ phase: 'ready', error: null })}
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
      work.disconnect()
      connectionMode = 'shared'
      publish({ phase: 'disconnected', connectionMode: 'shared', error: null })

      try {await ownerAuth?.ownerSignOut({ baseUrl: snapshot.baseUrl })} catch {
        publish({ error: 'Owner sign-out could not be verified. The connection was closed.' })
      }
    },
    async selectTeammate(teammateId, storedSessionId) {
      const client = gateway

      if (!client || snapshot.phase !== 'ready') {return}
      const profileId = profileIds.get(teammateId)
      const teammate = snapshot.teammates.find((item) => item.id === teammateId)

      if (!profileId || !teammate) {return}
      const connectionOperation = connectionGeneration
      const sessionOperation = ++sessionGeneration
      completedSessionId = null
      pendingSubmit = null
      publish({
        selectedTeammateId: teammateId,
        runtimeSessionId: null,
        storedSessionId: null,
        messages: [],
        streamingText: '',
        pendingApproval: null,
        recentSessions: [],
        sessionsLoading: true,
        turnStatus: 'idle',
        error: null
      })
      void loadSessions(client, teammateId)

      try {
        const result = storedSessionId
          ? await client.resumeSession(storedSessionId, profileId)
          : await resolveBotChat(client, profileId)

        const applied = await applySession(client, result, connectionOperation, sessionOperation)

        if (applied) {void loadSessions(client, teammateId)}
      } catch (error) {
        if (isCurrentConnection(client, connectionOperation) && sessionGeneration === sessionOperation) {
          publish({ error: publicError(error) })
        }
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
      const sessionOperation = ++sessionGeneration
      publish({ selectedTeammateId: teammateId, runtimeSessionId: null, storedSessionId: null, messages: [], pendingApproval: null, error: null })

      try {
        const result = await client.resumeSession(item.stored_session_id, item.profile)
        await applySession(client, result, connectionOperation, sessionOperation)
        void loadSessions(client, teammateId)
      } catch (error) { publish({ error: publicError(error) }) }
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

      try {
        if (pinsSupported) {
          try {
            await client.setSessionPinned(profile, sessionId, pinned)
          } catch (error) {
            if (!isUnsupportedMethod(error)) {throw error}
            pinsSupported = false
          }
        }

        const key = localPinKey(profile, sessionId)

        if (pinsSupported) {localPins.delete(key)}
        else if (pinned) {localPins.add(key)}
        else {localPins.delete(key)}

        persistLocalPins()
        publish({ recentSessions: snapshot.recentSessions.map((session) => session.id === sessionId ? { ...session, pinned } : session) })
      } catch (error) {publish({ error: publicError(error) })}
    },
    async openBotChat(teammateId = snapshot.selectedTeammateId ?? 'atlas') {
      const client = gateway
      const profile = profileIds.get(teammateId)

      if (!client || !profile || snapshot.phase !== 'ready') {return}
      const connectionOperation = connectionGeneration
      const sessionOperation = ++sessionGeneration
      publish({ selectedTeammateId: teammateId, runtimeSessionId: null, storedSessionId: null, messages: [], pendingApproval: null, error: null })

      try {
        const result = await resolveBotChat(client, profile)
        await applySession(client, result, connectionOperation, sessionOperation)
        void loadSessions(client, teammateId)
      } catch (error) {publish({ error: publicError(error) })}
    },
    async submitQuickTask(teammateId, text) {
      const client = gateway
      const profile = profileIds.get(teammateId)
      const task = text.trim()

      if (!client || !profile || !task || snapshot.phase !== 'ready') {return}
      const connectionOperation = connectionGeneration
      const sessionOperation = ++sessionGeneration
      publish({ selectedTeammateId: teammateId, runtimeSessionId: null, storedSessionId: null, messages: [], pendingApproval: null, error: null })

      try {
        const result = await resolveBotChat(client, profile)

        if (!await applySession(client, result, connectionOperation, sessionOperation)) {return}

        const submittedTurn = {
          client,
          connectionGeneration: connectionOperation,
          sessionGeneration: sessionOperation,
          runtimeSessionId: result.session_id,
          text: task,
          userRecorded: false,
          completed: false
        }

        pendingSubmit = submittedTurn
        publish({ turnStatus: 'submitting', error: null })

        try {
          await client.submitPrompt(result.session_id, task)

          if (!isCurrentConnection(client, connectionOperation)
            || sessionGeneration !== sessionOperation
            || snapshot.runtimeSessionId !== result.session_id) {return}

          const messages = submittedTurn.userRecorded
            ? snapshot.messages
            : [...snapshot.messages, { id: `message-${++messageSequence}`, role: 'user' as const, text: task }]

          submittedTurn.userRecorded = true
          publish({ messages, turnStatus: submittedTurn.completed ? 'idle' : isDisconnected() ? 'uncertain' : 'streaming' })
        } catch (error) {
          if (isCurrentConnection(client, connectionOperation)
            && sessionGeneration === sessionOperation
            && !submittedTurn.completed) {publish({ turnStatus: 'idle', error: publicError(error) })}
        } finally {
          if (pendingSubmit === submittedTurn) {pendingSubmit = null}
        }
      } catch (error) {publish({ turnStatus: 'idle', error: publicError(error) })}
    },
    setDraft(draft) { publish({ draft }) },
    async submitDraft() {
      const client = gateway
      const runtimeId = snapshot.runtimeSessionId
      const text = snapshot.draft.trim()

      if (!client || !runtimeId || !text || snapshot.phase !== 'ready') {return}

      const submittedTurn = {
        client,
        connectionGeneration,
        sessionGeneration,
        runtimeSessionId: runtimeId,
        text,
        userRecorded: false,
        completed: false
      }

      pendingSubmit = submittedTurn
      publish({ turnStatus: 'submitting', error: null })

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
          draft: snapshot.draft === text ? '' : snapshot.draft,
          messages,
          turnStatus: submittedTurn.completed ? 'idle' : disconnected ? 'uncertain' : 'streaming'
        })
      } catch (error) {
        if (gateway === client
          && connectionGeneration === submittedTurn.connectionGeneration
          && sessionGeneration === submittedTurn.sessionGeneration
          && !isDisconnected()
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

      if (!client || !runtimeId) {return}

      try { await client.interruptSession(runtimeId) } catch (error) {
        if (isCurrentConnection(client, connectionOperation) && sessionGeneration === sessionOperation) {
          publish({ error: publicError(error) })
        }
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
      const profileId = selectedId ? profileIds.get(selectedId) : undefined
      const storedId = snapshot.storedSessionId

      const connectionOperation = ++connectionGeneration

      try {
        const client = await connect('recovering', connectionOperation, connectionMode)

        if (!client || !isCurrentConnection(client, connectionOperation)) {return}

        if (selectedId && profileId) {
          const sessionOperation = ++sessionGeneration

          const result = storedId
            ? await client.resumeSession(storedId, profileId)
            : await resolveBotChat(client, profileId)

          if (!await applySession(client, result, connectionOperation, sessionOperation)) {return}
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
        publish({ hasSavedToken: false, canForgetSavedToken: false, error: null })
      } catch {
        publish({ error: SECURE_CREDENTIAL_ERROR })
      }
    },
    destroy() {
      if (destroyed) {return}
      destroyed = true
      work.disconnect()
      connectionGeneration += 1
      sessionGeneration += 1
      detachGateway()
      gateway?.close()
      gateway = null
      void secrets.clear()
      listeners.clear()
    }
  }
}
