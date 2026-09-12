import { type ConnectionState, JsonRpcGatewayError } from '@hermes/shared'
import { describe, expect, it, vi } from 'vitest'

import type { CompanionEvent, CompanionSessionHistoryResult, ContinueCompanionSessionResult, CreateCompanionSessionRequest, GatewaySessionSummary, ProfilesListResult, SessionInterruptResult, SessionResult } from '../gateway/types'
import type { OwnerAuthBridge } from '../security/owner-auth'
import type { SessionSecretStore } from '../security/secret-store'

import { type CompanionGateway, type CompanionGatewayFactory, createCompanionStore } from './companion-store'

class ControlledGateway implements CompanionGateway {
  connectionState: ConnectionState = 'idle'
  readonly calls: Array<[string, ...unknown[]]> = []
  profiles: ProfilesListResult = {
    profiles: [
      { name: 'atlas' },
      { name: 'Operations Assistant' }
    ]
  }
  session: SessionResult = {
    session_id: 'runtime-1',
    stored_session_id: 'stored-1',
    messages: [{ role: 'assistant', content: 'Welcome back.' }]
  }
  submit = Promise.resolve({ status: 'streaming' as const })
  interruptResult: Promise<SessionInterruptResult> = Promise.resolve({ status: 'interrupted' })
  approval = Promise.resolve({ resolved: 1 })
  connectResult: Promise<void> = Promise.resolve()
  profilesResult: Promise<ProfilesListResult> | null = null
  sessionResults: Promise<SessionResult>[] = []
  resumeResults: Promise<SessionResult>[] = []
  continuationResults: Promise<ContinueCompanionSessionResult>[] = []
  reconciliationResults: Promise<Awaited<ReturnType<CompanionGateway['reconcileCompanionSession']>>>[] = []

  sessionListResults: Promise<{ sessions: GatewaySessionSummary[] }>[] = []
  sessions: GatewaySessionSummary[] = []
  attentionResult = { items: [], scope: 'This gateway runtime only' } as Awaited<ReturnType<CompanionGateway['listAttention']>>
  pendingApprovalsResult: Promise<{ approvals: [] }> | null = null
  private eventHandlers = new Set<(event: CompanionEvent) => void>()
  private stateHandlers = new Set<(state: ConnectionState) => void>()

  async connect(url: string) {
    this.calls.push(['connect', url])
    await this.connectResult
    this.setState('open')
  }
  close() { this.calls.push(['close']); this.setState('closed') }
  onEvent(handler: (event: CompanionEvent) => void) { this.eventHandlers.add(handler);

 return () => this.eventHandlers.delete(handler) }
  onState(handler: (state: ConnectionState) => void) { this.stateHandlers.add(handler); handler(this.connectionState);

 return () => this.stateHandlers.delete(handler) }
  async listProfiles() { this.calls.push(['listProfiles']);

 return this.profilesResult ?? this.profiles }
  async createSession(options?: { profile?: string; title?: string }) { this.calls.push(['createSession', options]);

 return this.sessionResults.shift() ?? this.session }
  async resumeSession(id: string, profile?: string) { this.calls.push(['resumeSession', id, profile]);

 return this.resumeResults.shift() ?? this.session }
  async getCompanionSessionHistory(profile: string, id: string, cursor?: string, expectedSource?: string): Promise<CompanionSessionHistoryResult> {
    this.calls.push(['getCompanionSessionHistory', profile, id, cursor, expectedSource])

    return {
      session_id: id, profile, source: expectedSource ?? 'backend-1',
      entries: [{ id: 'persisted-1', kind: 'message' as const, role: 'assistant' as const, content: 'Persisted reply', label: null, occurred_at: null }],
      linked_work: [], linked_work_available: false, has_more: false, next_cursor: null,
      coverage: { complete: true, freshness: null, message: null }
    }
  }
  async continueCompanionSession(options: { backend_namespace: string; profile: string; stored_session_id: string; text: string; client_request_id: string }) {
    this.calls.push(['continueCompanionSession', options])

    return this.continuationResults.shift() ?? { ...this.session, stored_session_id: options.stored_session_id, backend_namespace: options.backend_namespace, profile: options.profile, cwd: '/persisted/cwd', status: 'streaming' as const }
  }
  async reconcileCompanionSession(options: { backend_namespace: string; profile: string; stored_session_id: string; client_request_id: string }) {
    this.calls.push(['reconcileCompanionSession', options])

    return this.reconciliationResults.shift() ?? { ...options, status: 'reconciled' as const, reconciled: true as const, operation_status: 'not_admitted' as const }
  }

  async listSessions(options: { profile: string; limit?: number; include_hidden?: boolean; include_archived?: boolean; title?: string }) {
    this.calls.push(['listSessions', options])

    if (!options.title && this.sessionListResults.length > 0) {return this.sessionListResults.shift()!}

    return { sessions: this.sessions }
  }
  async setSessionPinned(profile: string, id: string, pinned: boolean) { this.calls.push(['setSessionPinned', profile, id, pinned]);

 return { pinned, session_id: id, changed: true } }
  async listAttention() { this.calls.push(['listAttention']);

 return this.attentionResult }
  async submitPrompt(id: string, text: string) { this.calls.push(['submitPrompt', id, text]);

 return this.submit }
  async interruptSession(id: string) { this.calls.push(['interruptSession', id]);

 return this.interruptResult }
  async listPendingApprovals(id: string) { this.calls.push(['listPendingApprovals', id]);

 return this.pendingApprovalsResult ?? { approvals: [] } }
  async respondToApproval(id: string, request: string, choice: 'once' | 'session' | 'always' | 'deny') {
    this.calls.push(['respondToApproval', id, request, choice]);

 return this.approval
  }
  emit(event: CompanionEvent) { for (const handler of this.eventHandlers) {handler(event)} }
  setState(state: ConnectionState) { this.connectionState = state;

 for (const handler of this.stateHandlers) {handler(state)} }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })

  return { promise, resolve, reject }
}

function tokenStore(initial?: string, persistent = true) {
  let token = initial

  const store: SessionSecretStore = {
    persistent,
    get: vi.fn(() => token),
    set: vi.fn((_name, value) => { token = value }),
    delete: vi.fn(() => { token = undefined }),
    revoke: vi.fn(() => { token = undefined }),
    clear: vi.fn()
  }

  return store
}

function harness(
  baseUrl: string | null = null,
  profiles?: ProfilesListResult,
  secretStore?: SessionSecretStore,
  ownerAuthBridge?: OwnerAuthBridge,
  prepareGateway?: (gateway: ControlledGateway, index: number) => void
) {
  const gateways: ControlledGateway[] = []

  const factory: CompanionGatewayFactory = () => {
    const gateway = new ControlledGateway()

    if (profiles) {gateway.profiles = profiles}
    prepareGateway?.(gateway, gateways.length)
    gateways.push(gateway)

    return gateway
  }

  const values = new Map<string, string>()

  if (baseUrl) {values.set('hermes.companion.gatewayBaseUrl', baseUrl)}

  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key))
  }

  const store = createCompanionStore({
    gatewayFactory: factory,
    storage,
    ...(secretStore ? { secretStore } : {}),
    ...(ownerAuthBridge ? { ownerAuthBridge } : {}),
    creationLock: {
      request: async (_name, _options, callback) => callback({ name: _name })
    }
  })

  return { store, storage, gateways, values }
}

describe('CompanionStore setup and sessions', () => {
  it('reconciles an uncertain first send without creating a second session', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth, (gateway, index) => {
      Object.assign(gateway, {
        listCompanionSessions: async () => ({ backend_namespace: 'backend-1', sessions: [], has_more: false, next_cursor: null,
          coverage: { complete: true, freshness: null, message: null } }),
        listCompanionProjects: async () => ({ backend_namespace: 'backend-1', projects: [], has_more: false, next_cursor: null,
          coverage: { complete: true, freshness: null, message: null } }),
        getCompanionProject: async () => {throw new Error('unused')},
        createCompanionSession: async (request: CreateCompanionSessionRequest) => {
          gateway.calls.push(['createCompanionSession', request])

          if (index === 0) {throw new Error('socket closed')}
          throw new Error('creation must be reconciled, not replayed')
        },
        reconcileCompanionSessionCreation: async (request: { operation_kind: 'create'; backend_namespace: string; profile: string; client_request_id: string }) => {
          gateway.calls.push(['reconcileCompanionSessionCreation', request])

          return {
            version: 1 as const, operation_kind: 'create' as const, backend_namespace: request.backend_namespace,
            profile: request.profile, client_request_id: request.client_request_id, project_id: null,
            stored_session_id: 'created-stored', row_state: 'present' as const,
            operation_status: 'completed' as const, runtime_session_id: null
          }
        }
      })
    })

    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    await vi.waitFor(() => expect(store.directory.getSnapshot().coverage[0]?.backendNamespace).toBe('backend-1'))
    await store.openBotChat('atlas')
    expect(gateways[0].calls.some(([name]) => name === 'createSession' || name === 'listSessions')).toBe(false)
    store.setDraft('Create exactly once')
    await store.submitDraft()
    expect(store.getSnapshot().turnStatus).toBe('uncertain')
    gateways[0].setState('closed')

    await store.connectOwner()

    const creationCalls = gateways.flatMap((gateway) => gateway.calls)
      .filter(([name]) => name === 'createCompanionSession')

    expect(creationCalls).toHaveLength(1)
    expect(gateways[1].calls.filter(([name]) => name === 'reconcileCompanionSessionCreation')).toHaveLength(1)
    expect(store.getSnapshot()).toMatchObject({ storedSessionId: 'created-stored', turnStatus: 'idle' })
  })
  it('bootstraps a native owner connection without opening a shared-token socket first', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true, ignored: 'renderer-secret' })),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=single-use-owner-ticket')
    }

    const secrets = tokenStore('saved-shared-token')
    const { store, storage, gateways } = harness(null, undefined, secrets, ownerAuth)

    await store.configureOwner({ baseUrl: 'https://gateway.test/' })

    expect(ownerAuth.ownerSignIn).toHaveBeenCalledWith({ baseUrl: 'https://gateway.test' })
    expect(ownerAuth.ownerWebSocketUrl).toHaveBeenCalledWith({ baseUrl: 'https://gateway.test' })
    expect(gateways).toHaveLength(1)
    expect(gateways[0].calls[0]).toEqual(['connect', 'wss://gateway.test/api/ws?ticket=single-use-owner-ticket'])
    expect(JSON.stringify(gateways[0].calls)).not.toContain('saved-shared-token')
    expect(JSON.stringify(store.getSnapshot())).not.toContain('renderer-secret')
    expect(secrets.set).not.toHaveBeenCalled()
    expect(storage.setItem).toHaveBeenCalledWith('hermes.companion.gatewayBaseUrl', 'https://gateway.test')
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', baseUrl: 'https://gateway.test', connectionMode: 'owner' })
  })

  it('explicit setup sign-in reauthenticates without preflighting a saved native session', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })),
      ownerStatus: vi.fn(async () => ({ signedIn: true })),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner-ticket')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)

    await store.configureOwner({ baseUrl: 'https://gateway.test' })

    expect(ownerAuth.ownerStatus).not.toHaveBeenCalled()
    expect(ownerAuth.ownerSignIn).toHaveBeenCalledWith({ baseUrl: 'https://gateway.test' })
    expect(gateways[0].calls[0]).toEqual(['connect', 'wss://gateway.test/api/ws?ticket=owner-ticket'])
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', connectionMode: 'owner', error: null })
  })

  it('reconnects a persisted native owner session after a cold restart', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(),
      ownerStatus: vi.fn(async () => ({ signedIn: true })),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=restart-ticket')
    }

    const { store, gateways } = harness('https://gateway.test', undefined, undefined, ownerAuth)

    await vi.waitFor(() => expect(store.getSnapshot().phase).toBe('ready'))
    expect(ownerAuth.ownerSignIn).not.toHaveBeenCalled()
    expect(gateways).toHaveLength(1)
    expect(gateways[0].calls[0]).toEqual(['connect', 'wss://gateway.test/api/ws?ticket=restart-ticket'])
    expect(store.getSnapshot().connectionMode).toBe('owner')
  })

  it.each([undefined, null, {}, { signedIn: false }])('does not reconnect from an unverified owner status %#', async (status) => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(),
      ownerStatus: vi.fn(async () => status),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn()
    }

    const { store, gateways } = harness('https://gateway.test', undefined, undefined, ownerAuth)

    await vi.waitFor(() => expect(ownerAuth.ownerStatus).toHaveBeenCalledTimes(1))
    expect(store.getSnapshot().phase).toBe('setup')
    expect(ownerAuth.ownerSignIn).not.toHaveBeenCalled()
    expect(ownerAuth.ownerWebSocketUrl).not.toHaveBeenCalled()
    expect(gateways).toHaveLength(0)
  })

  it('keeps a private-network owner bootstrap failure visible', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(),
      ownerStatus: vi.fn(async () => {throw new Error('Private gateway unavailable. Connect Tailscale, then try again.')}),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn()
    }

    const { store, gateways } = harness('https://gateway.test', undefined, undefined, ownerAuth)

    await vi.waitFor(() => expect(store.getSnapshot().error).toBe('Companion could not reach the gateway. Check the connection and try again.'))
    expect(store.getSnapshot().phase).toBe('setup')
    expect(ownerAuth.ownerSignIn).not.toHaveBeenCalled()
    expect(gateways).toHaveLength(0)
  })

  it('validates owner bootstrap URLs before crossing the native boundary', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn()
    }

    const { store, storage, gateways } = harness(null, undefined, undefined, ownerAuth)

    await store.configureOwner({ baseUrl: 'https://gateway.test/?ticket=do-not-accept' })

    expect(ownerAuth.ownerSignIn).not.toHaveBeenCalled()
    expect(ownerAuth.ownerWebSocketUrl).not.toHaveBeenCalled()
    expect(gateways).toHaveLength(0)
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toMatchObject({ phase: 'setup', connectionMode: 'shared' })
    expect(store.getSnapshot().error).toBe('Companion could not reach the gateway. Check the connection and try again.')
  })

  it.each([
    ['URL validation', 'https://gateway.test/?ticket=do-not-accept', 'Companion could not reach the gateway'],
    ['native sign-in', 'https://gateway.test/sign-in-failure', 'Companion could not reach the gateway'],
    ['connection ticket', 'https://gateway.test/ticket-failure', 'Companion could not reach the gateway']
  ])('keeps an owner %s failure visible while late hydration restores saved-token actions', async (_failure, baseUrl, expectedError) => {
    const token = deferred<string | undefined>()
    const secrets = tokenStore()
    vi.mocked(secrets.get).mockReturnValue(token.promise)

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async ({ baseUrl: normalizedBaseUrl }) => {
        if (normalizedBaseUrl.endsWith('/sign-in-failure')) {throw new Error('owner sign-in failed')}

        return { signedIn: true }
      }),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async ({ baseUrl: normalizedBaseUrl }) => {
        if (normalizedBaseUrl.endsWith('/ticket-failure')) {throw new Error('owner ticket failed')}

        return 'wss://gateway.test/api/ws?ticket=owner-ticket'
      })
    }

    const { store, gateways } = harness(null, undefined, secrets, ownerAuth)

    await store.configureOwner({ baseUrl })
    expect(store.getSnapshot()).toMatchObject({ phase: 'setup' })
    expect(store.getSnapshot().error).toContain(expectedError)

    token.resolve('late-shared-token')
    await token.promise
    await Promise.resolve()

    expect(store.getSnapshot()).toMatchObject({
      phase: 'setup',
      hasSavedToken: true,
      canForgetSavedToken: true
    })
    expect(store.getSnapshot().error).toContain(expectedError)
    expect(JSON.stringify(store.getSnapshot())).not.toContain('late-shared-token')

    await store.configure({ baseUrl: 'https://shared.gateway.test', token: '' })
    expect(gateways.at(-1)?.calls[0]).toEqual([
      'connect',
      'wss://shared.gateway.test/api/ws?token=late-shared-token'
    ])
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', connectionMode: 'shared' })
  })

  it('does not let a saved-token storage failure overwrite an active owner bootstrap', async () => {
    const token = deferred<string | undefined>()
    const signIn = deferred<{ signedIn: boolean }>()
    const secrets = tokenStore()
    vi.mocked(secrets.get).mockReturnValue(token.promise)

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(() => signIn.promise),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner-ticket')
    }

    const { store } = harness(null, undefined, secrets, ownerAuth)
    const configuring = store.configureOwner({ baseUrl: 'https://gateway.test' })

    expect(store.getSnapshot()).toMatchObject({ phase: 'connecting', error: null })
    token.reject(new Error('secure storage failed'))
    await expect(token.promise).rejects.toThrow('secure storage failed')
    await Promise.resolve()
    expect(store.getSnapshot()).toMatchObject({ phase: 'connecting', error: null })

    signIn.resolve({ signedIn: true })
    await configuring
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', connectionMode: 'owner', error: null })
  })

  it('fails closed when a newer owner bootstrap supersedes an in-flight attempt', async () => {
    const firstSignIn = deferred<{ signedIn: boolean }>()
    const secondSignIn = deferred<{ signedIn: boolean }>()

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn()
        .mockImplementationOnce(() => firstSignIn.promise)
        .mockImplementationOnce(() => secondSignIn.promise),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async ({ baseUrl }) => `wss://${new URL(baseUrl).host}/api/ws?ticket=owner-ticket`)
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    const first = store.configureOwner({ baseUrl: 'https://first.gateway.test' })
    await Promise.resolve()
    const second = store.configureOwner({ baseUrl: 'https://latest.gateway.test' })

    firstSignIn.reject(new Error('owner sign-in cancelled by newer attempt'))
    await first
    expect(store.getSnapshot()).toMatchObject({ phase: 'connecting', baseUrl: 'https://latest.gateway.test', error: null })
    expect(ownerAuth.ownerWebSocketUrl).not.toHaveBeenCalled()
    expect(gateways).toHaveLength(0)

    secondSignIn.resolve({ signedIn: true })
    await second

    expect(ownerAuth.ownerWebSocketUrl).toHaveBeenCalledTimes(1)
    expect(ownerAuth.ownerWebSocketUrl).toHaveBeenCalledWith({ baseUrl: 'https://latest.gateway.test' })
    expect(gateways).toHaveLength(1)
    expect(gateways[0].calls[0]).toEqual(['connect', 'wss://latest.gateway.test/api/ws?ticket=owner-ticket'])
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', baseUrl: 'https://latest.gateway.test', connectionMode: 'owner' })
  })

  it('can retry owner bootstrap successfully after a failure', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn()
        .mockRejectedValueOnce(new Error('owner sign-in failed'))
        .mockResolvedValueOnce({ signedIn: true }),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=retry-ticket')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)

    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    expect(store.getSnapshot()).toMatchObject({ phase: 'setup', error: 'Companion could not reach the gateway. Check the connection and try again.' })

    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    expect(ownerAuth.ownerSignIn).toHaveBeenCalledTimes(2)
    expect(gateways).toHaveLength(1)
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', connectionMode: 'owner', error: null })
  })

  it('connects to an older gateway when attention.list is unavailable', async () => {
    const { store, gateways } = harness()
    const configuring = store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })

    gateways[0].listAttention = async () => {throw new Error('Method not found (-32601)')}

    await configuring

    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready', attentionItems: [], attentionScope: 'Unavailable on this gateway version'
    })
  })

  it('uses the compatibility fallback for the gateway unknown-method error shape', async () => {
    const { store, gateways } = harness()
    const configuring = store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    const error = Object.assign(new Error('unknown method: attention.list'), { code: -32601 })

    gateways[0].listAttention = async () => {throw error}

    await configuring

    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready', attentionItems: [], attentionScope: 'Unavailable on this gateway version'
    })
    expect(gateways[0].calls).not.toContainEqual(['close'])
  })

  it('reuses a saved native token on blank submission without exposing it in the snapshot', async () => {
    const secrets = tokenStore('known-good-token')
    const { store, gateways } = harness('http://localhost:8642', undefined, secrets)

    expect(store.getSnapshot()).toMatchObject({ hasSavedToken: true, storesTokenEncrypted: true })
    expect(JSON.stringify(store.getSnapshot())).not.toContain('known-good-token')
    await store.configure({ baseUrl: 'http://localhost:8642', token: '' })

    expect(gateways[0].calls[0]).toEqual(['connect', 'ws://localhost:8642/api/ws?token=known-good-token'])
    expect(secrets.set).not.toHaveBeenCalled()
    expect(store.getSnapshot().phase).toBe('ready')
  })

  it('waits for asynchronous native token hydration before a blank saved-token connection', async () => {
    const token = deferred<string | undefined>()
    const secrets = tokenStore()
    vi.mocked(secrets.get).mockReturnValue(token.promise)
    const { store, gateways } = harness('http://localhost:8642', undefined, secrets)
    const configuring = store.configure({ baseUrl: 'http://localhost:8642', token: '' })

    expect(gateways).toHaveLength(0)
    token.resolve('async-native-token')
    await configuring

    expect(gateways[0].calls[0]).toEqual(['connect', 'ws://localhost:8642/api/ws?token=async-native-token'])
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', hasSavedToken: true, canForgetSavedToken: true })
    expect(JSON.stringify(store.getSnapshot())).not.toContain('async-native-token')
  })

  it.each([
    ['a saved token', ''],
    ['an explicit token', 'explicit-shared-token']
  ])('does not let delayed shared configure with %s supersede a later owner configure', async (_kind, sharedToken) => {
    const hydration = deferred<string | undefined>()
    const secrets = tokenStore()
    vi.mocked(secrets.get).mockReturnValue(hydration.promise)

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://owner.gateway.test/api/ws?ticket=owner-ticket')
    }

    const { store, gateways } = harness(null, undefined, secrets, ownerAuth)

    const shared = store.configure({ baseUrl: 'https://shared.gateway.test', token: sharedToken })
    expect(store.getSnapshot()).toMatchObject({ phase: 'connecting', baseUrl: 'https://shared.gateway.test' })
    expect(gateways).toHaveLength(0)

    await store.configureOwner({ baseUrl: 'https://owner.gateway.test' })
    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready', baseUrl: 'https://owner.gateway.test', connectionMode: 'owner'
    })

    hydration.resolve('hydrated-shared-token')
    await shared

    expect(gateways).toHaveLength(1)
    expect(gateways[0].calls[0]).toEqual([
      'connect', 'wss://owner.gateway.test/api/ws?ticket=owner-ticket'
    ])
    expect(secrets.set).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready',
      baseUrl: 'https://owner.gateway.test',
      connectionMode: 'owner',
      hasSavedToken: true,
      canForgetSavedToken: true
    })
  })

  it('keeps a pending then failed owner attempt authoritative when stale shared token persistence completes', async () => {
    let persistedToken: string | undefined = 'previous-shared-token'
    const setStarted = deferred<void>()
    const releaseSet = deferred<void>()
    const secrets = tokenStore(persistedToken)

    vi.mocked(secrets.get).mockImplementation(() => persistedToken)
    vi.mocked(secrets.set).mockImplementation(async (_name, value) => {
      setStarted.resolve()
      await releaseSet.promise
      persistedToken = value
    })
    vi.mocked(secrets.delete).mockImplementation(() => {persistedToken = undefined})

    const ownerSignIn = deferred<{ signedIn: boolean }>()

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(() => ownerSignIn.promise),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn()
    }

    const { store, storage } = harness(null, undefined, secrets, ownerAuth)

    const shared = store.configure({
      baseUrl: 'https://stale-shared.gateway.test',
      token: 'stale-replacement-token'
    })

    await setStarted.promise

    const owner = store.configureOwner({ baseUrl: 'https://current-owner.gateway.test' })
    expect(store.getSnapshot()).toMatchObject({
      phase: 'connecting', baseUrl: 'https://current-owner.gateway.test', error: null
    })

    releaseSet.resolve()
    await shared

    expect(persistedToken).toBe('previous-shared-token')
    expect(storage.setItem).not.toHaveBeenCalledWith(
      'hermes.companion.gatewayBaseUrl', 'https://stale-shared.gateway.test'
    )
    expect(store.getSnapshot()).toMatchObject({
      phase: 'connecting', baseUrl: 'https://current-owner.gateway.test', error: null
    })

    ownerSignIn.reject(new Error('owner replacement failed'))
    await owner

    expect(store.getSnapshot()).toMatchObject({
      phase: 'setup', baseUrl: 'https://current-owner.gateway.test', connectionMode: 'shared'
    })
    expect(store.getSnapshot().error).toContain('could not reach the gateway')
    expect(storage.setItem).toHaveBeenCalledWith(
      'hermes.companion.gatewayBaseUrl', 'https://current-owner.gateway.test'
    )
    expect(persistedToken).toBe('previous-shared-token')
  })

  it('persists a replacement only after authenticated roster load succeeds', async () => {
    const secrets = tokenStore('known-good-token')
    const { store, gateways } = harness(null, undefined, secrets)
    const roster = deferred<ProfilesListResult>()
    const configuring = store.configure({ baseUrl: 'http://localhost:8642', token: 'replacement-token' })
    gateways[0].profilesResult = roster.promise
    await vi.waitFor(() => expect(gateways[0].calls).toContainEqual(['listProfiles']))
    expect(secrets.set).not.toHaveBeenCalled()

    roster.resolve({ profiles: [{ name: 'atlas' }] })
    await configuring
    expect(secrets.set).toHaveBeenCalledWith('gateway-token', 'replacement-token')
  })

  it('closes and detaches an authenticated client when encrypted token persistence fails', async () => {
    const secrets = tokenStore('known-good-token')
    vi.mocked(secrets.set).mockImplementation(() => { throw new Error('secure write failed') })
    const { store, gateways } = harness(null, undefined, secrets)

    await store.configure({ baseUrl: 'http://localhost:8642', token: 'replacement-token' })

    expect(gateways[0].calls).toContainEqual(['close'])
    expect(store.getSnapshot()).toMatchObject({ phase: 'setup', teammates: [] })
    gateways[0].setState('closed')
    expect(store.getSnapshot().phase).toBe('setup')
  })

  it('leaves a known-good saved token untouched when a replacement fails authentication', async () => {
    const secrets = tokenStore('known-good-token')
    const { store, gateways } = harness(null, undefined, secrets)
    const configuring = store.configure({ baseUrl: 'http://localhost:8642', token: 'bad-replacement' })
    gateways[0].profilesResult = Promise.reject(new Error('authentication failed'))
    await configuring

    expect(secrets.set).not.toHaveBeenCalled()
    expect(secrets.get('gateway-token')).toBe('known-good-token')
    expect(JSON.stringify(store.getSnapshot())).not.toContain('bad-replacement')
  })

  it('handles unavailable secure storage without crashing or leaking implementation details', async () => {
    const secrets = tokenStore()
    vi.mocked(secrets.get).mockImplementation(() => { throw new Error('ciphertext /Users/private/token bad-token') })
    const { store } = harness('http://localhost:8642', undefined, secrets)

    expect(store.getSnapshot()).toMatchObject({
      phase: 'setup',
      hasSavedToken: false,
      canForgetSavedToken: true,
      error: 'Companion could not access encrypted token storage. Forget the saved token or try again.'
    })
    expect(JSON.stringify(store.getSnapshot())).not.toContain('/Users/private')
    await expect(store.configure({ baseUrl: 'http://localhost:8642', token: '' })).resolves.toBeUndefined()
  })

  it('forgets a saved token only through the explicit reset action', async () => {
    const secrets = tokenStore('known-good-token')
    const { store } = harness(null, undefined, secrets)

    await store.forgetSavedToken()
    expect(secrets.delete).toHaveBeenCalledWith('gateway-token')
    expect(store.getSnapshot()).toMatchObject({ hasSavedToken: false, canForgetSavedToken: false, error: null })
  })

  it('starts in first-run setup and persists only normalized base URL', async () => {
    const { store, storage, gateways } = harness()
    expect(store.getSnapshot().phase).toBe('setup')

    await store.configure({ baseUrl: 'http://localhost:8642/', token: 'session-secret' })

    expect(storage.setItem).toHaveBeenCalledWith('hermes.companion.gatewayBaseUrl', 'http://localhost:8642')
    expect(JSON.stringify([...storage.setItem.mock.calls])).not.toContain('session-secret')
    expect(gateways[0].calls[0]).toEqual(['connect', 'ws://localhost:8642/api/ws?token=session-secret'])
    expect(store.getSnapshot().phase).toBe('ready')
    expect(store.getSnapshot().teammates.map((item) => item.name)).toEqual(['Atlas', 'Operations Assistant'])
    expect(store.getSnapshot().teammates.map((item) => item.id)).not.toContain('Operations Assistant')
  })

  it('opens the canonical Bot Chat for a selected profile and resumes an explicitly known stored session', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    const atlas = store.getSnapshot().teammates[0]

    await store.selectTeammate(atlas.id)
    expect(gateways[0].calls).toContainEqual(['listSessions', {
      profile: 'atlas', limit: 1, include_hidden: true, include_archived: true, title: 'Bot Chat'
    }])
    expect(gateways[0].calls).toContainEqual(['createSession', {
      profile: 'atlas', title: 'Bot Chat', hidden: true, source: 'companion'
    }])
    expect(store.getSnapshot()).toMatchObject({ runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })
    expect(store.getSnapshot().messages[0]).toMatchObject({ role: 'assistant', text: 'Welcome back.' })
    await vi.waitFor(() => expect(gateways[0].calls.filter(([name, options]) =>
      name === 'listSessions' && !(options as { title?: string }).title
    )).toHaveLength(2))

    await store.selectTeammate(atlas.id, 'stored-explicit')
    expect(gateways[0].calls).toContainEqual(['resumeSession', 'stored-explicit', 'atlas'])
  })

  it('does not start a stale session refresh after a teammate switch supersedes session activation', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    const [atlas, operations] = store.getSnapshot().teammates
    const staleSession = deferred<SessionResult>()
    gateways[0].sessionResults.push(staleSession.promise)

    const staleSelection = store.selectTeammate(atlas.id)
    await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'createSession')).toBe(true))

    await store.selectTeammate(operations.id)
    staleSession.resolve({ session_id: 'stale-runtime', stored_session_id: 'stale-stored', messages: [] })
    await staleSelection

    const atlasRefreshes = gateways[0].calls.filter(([name, options]) => (
      name === 'listSessions'
      && (options as { profile?: string; title?: string })?.profile === 'atlas'
      && !(options as { title?: string })?.title
    ))

    expect(atlasRefreshes).toHaveLength(1)
    expect(store.getSnapshot()).toMatchObject({ selectedTeammateId: operations.id, sessionsLoading: false })
  })

  it('keeps the newest session-list response when the initial and authoritative refresh resolve out of order', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    const atlas = store.getSnapshot().teammates[0]
    const initialList = deferred<{ sessions: GatewaySessionSummary[] }>()
    const authoritativeList = deferred<{ sessions: GatewaySessionSummary[] }>()
    gateways[0].sessionListResults.push(initialList.promise, authoritativeList.promise)

    await store.selectTeammate(atlas.id)
    authoritativeList.resolve({ sessions: [{
      id: 'newer', title: 'Newer session', preview: '', started_at: 1, last_active: 2,
      message_count: 1, source: 'companion', pinned: false
    }] })
    await vi.waitFor(() => expect(store.getSnapshot().recentSessions[0]?.id).toBe('newer'))

    initialList.resolve({ sessions: [{
      id: 'older', title: 'Older session', preview: '', started_at: 1, last_active: 1,
      message_count: 1, source: 'companion', pinned: false
    }] })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.getSnapshot().recentSessions[0]?.id).toBe('newer')
    expect(store.getSnapshot().sessionsLoading).toBe(false)
  })

  it('reuses an exact hidden Bot Chat instead of creating a duplicate', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    gateways[0].sessions = [{
      id: 'bot-root', resolved_id: 'bot-tip', title: 'Bot Chat', preview: 'Previous work',
      started_at: 1, last_active: 2, message_count: 3, source: 'companion', pinned: true
    }]

    await store.selectTeammate('atlas')

    expect(gateways[0].calls).toContainEqual(['resumeSession', 'bot-tip', 'atlas'])
    expect(gateways[0].calls.some(([name]) => name === 'createSession')).toBe(false)
  })

  it('falls back to local pin persistence when the gateway lacks session.set_pinned', async () => {
    const { store, gateways, storage } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    gateways[0].sessions = [{
      id: 'recent-1', title: 'Recent', preview: '', started_at: 1, last_active: 2,
      message_count: 1, source: 'companion', pinned: false
    }]
    await store.selectTeammate('atlas')
    await vi.waitFor(() => expect(store.getSnapshot().recentSessions).toHaveLength(1))

    gateways[0].setSessionPinned = async () => {throw new Error('Method not found (-32601)')}

    await store.setSessionPinned('recent-1', true)

    expect(store.getSnapshot().recentSessions[0].pinned).toBe(true)
    expect(storage.setItem).toHaveBeenCalledWith(
      'hermes.companion.localPins',
      expect.stringContaining('recent-1')
    )
  })

  it.each(['sign-out', 'owner replacement', 'gateway replacement'] as const)(
    'does not let a late unsupported pin RPC repopulate pins after %s',
    async (action) => {
      const ownerAuth: OwnerAuthBridge = {
        ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
        ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
      }

      const pin = deferred<{ pinned: boolean; session_id: string; changed: boolean }>()
      const { store, gateways, values } = harness(null, undefined, undefined, ownerAuth)
      await store.configureOwner({ baseUrl: 'https://gateway.test' })
      gateways[0].sessions = [{
        id: 'owner-a-session', title: 'Owner A', preview: '', started_at: 1, last_active: 2,
        message_count: 1, source: 'companion', pinned: false
      }]
      await store.selectTeammate('atlas')
      await vi.waitFor(() => expect(store.getSnapshot().recentSessions).toHaveLength(1))
      gateways[0].setSessionPinned = vi.fn(() => pin.promise)
      const pinning = store.setSessionPinned('owner-a-session', true)
      await vi.waitFor(() => expect(gateways[0].setSessionPinned).toHaveBeenCalledOnce())

      if (action === 'sign-out') {await store.signOutOwner()}
      else if (action === 'owner replacement') {await store.configureOwner({ baseUrl: 'https://replacement.gateway.test' })}
      else {gateways[0].setState('closed'); await store.recover()}

      pin.reject(Object.assign(new Error('Method not found (-32601) API_KEY=synthetic-secret'), { code: -32601 }))
      await pinning

      expect(values.get('hermes.companion.localPins') ?? '').not.toContain('owner-a-session')
      expect(store.getSnapshot().recentSessions.find((session) => session.id === 'owner-a-session')?.pinned).not.toBe(true)
      expect(JSON.stringify(store.getSnapshot())).not.toContain('synthetic-secret')
    }
  )

  it.each(['success', 'failure'] as const)(
    'does not publish a late pin %s after switching saved-session identity',
    async (outcome) => {
      const { store, gateways } = harness()
      await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
      gateways[0].sessions = [{
        id: 'session-a', title: 'Session A', preview: '', started_at: 1, last_active: 2,
        message_count: 1, source: 'companion', pinned: false
      }]
      await store.selectTeammate('atlas')
      await vi.waitFor(() => expect(store.getSnapshot().recentSessions).toHaveLength(1))
      const pin = deferred<{ pinned: boolean; session_id: string; changed: boolean }>()
      gateways[0].setSessionPinned = vi.fn(() => pin.promise)
      const pinning = store.setSessionPinned('session-a', true)
      await vi.waitFor(() => expect(gateways[0].setSessionPinned).toHaveBeenCalledOnce())

      store.activateSessionDraft({ backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'session-b' })
      store.setDraft('Draft for B')

      if (outcome === 'success') {pin.resolve({ pinned: true, session_id: 'session-a', changed: true })}
      else {pin.reject(new Error('gateway pin failed token=synthetic-token'))}

      await pinning

      expect(store.getSnapshot()).toMatchObject({ storedSessionId: 'session-b', draft: 'Draft for B', error: null })
      expect(store.getSnapshot().recentSessions.find((session) => session.id === 'session-a')?.pinned).not.toBe(true)
      expect(JSON.stringify(store.getSnapshot())).not.toContain('synthetic-token')
    }
  )

  it('loads live name-only profiles while keeping raw profile names out of the UI', async () => {
    const profiles = {
      profiles: [
        { name: 'atlas' },
        { name: '/Users/operator/.hermes/profiles/ops_internal' }
      ]
    }

    const { store, gateways } = harness(null, profiles)
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    const teammates = store.getSnapshot().teammates

    expect(teammates).toHaveLength(2)
    expect(teammates[0]).toMatchObject({ id: 'atlas', name: 'Atlas' })
    expect(teammates[1]).toMatchObject({ id: 'teammate-2', name: 'Hermes Teammate 2' })
    expect(JSON.stringify(teammates)).not.toContain('/Users/operator')
    expect(JSON.stringify(teammates)).not.toContain('ops_internal')

    await store.selectTeammate(teammates[1].id)
    expect(gateways[0].calls).toContainEqual([
      'createSession',
      { profile: '/Users/operator/.hermes/profiles/ops_internal', title: 'Bot Chat', hidden: true, source: 'companion' }
    ])
  })

  it('gives duplicate aliases unique stable UI IDs without losing exact transport identity', async () => {
    const { store, gateways } = harness(null, {
      profiles: [{ name: 'atlas' }, { name: 'team-atlas' }]
    })

    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    const teammates = store.getSnapshot().teammates

    expect(teammates.map(({ id }) => id)).toEqual(['atlas', 'atlas-2'])
    await store.selectTeammate(teammates[0].id)
    await store.selectTeammate(teammates[1].id)
    expect(gateways[0].calls).toContainEqual([
      'createSession',
      { profile: 'atlas', title: 'Bot Chat', hidden: true, source: 'companion' }
    ])
    expect(gateways[0].calls).toContainEqual([
      'createSession',
      { profile: 'team-atlas', title: 'Bot Chat', hidden: true, source: 'companion' }
    ])
  })

  it('keeps the newest selection when an older session creation resolves last', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    const [atlas, operations] = store.getSnapshot().teammates
    const older = deferred<SessionResult>()
    const newer = deferred<SessionResult>()
    gateways[0].sessionResults.push(older.promise, newer.promise)

    const selectingAtlas = store.selectTeammate(atlas.id)
    const selectingOperations = store.selectTeammate(operations.id)
    newer.resolve({ session_id: 'runtime-new', stored_session_id: 'stored-new', messages: [] })
    await selectingOperations
    older.resolve({ session_id: 'runtime-old', stored_session_id: 'stored-old', messages: [] })
    await selectingAtlas

    expect(store.getSnapshot()).toMatchObject({
      selectedTeammateId: operations.id,
      runtimeSessionId: 'runtime-new',
      storedSessionId: 'stored-new'
    })
  })
})

describe('CompanionStore prompts, approvals, and recovery', () => {
  it('correlates tool start, progress, and completion into one inert timeline record', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)

    gateways[0].emit({ type: 'tool.start', session_id: 'runtime-1', payload: { id: 'call-1', name: 'terminal', command: '<script>alert(1)</script>' } })
    gateways[0].emit({ type: 'tool.progress', session_id: 'runtime-1', payload: { id: 'call-1', percent: 50 } })
    gateways[0].emit({ type: 'tool.complete', session_id: 'runtime-1', payload: { id: 'call-1', output: 'done' } })

    const tools = store.getSnapshot().messages.filter((message) => message.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ toolId: 'call-1', label: 'terminal', toolStatus: 'complete' })
    expect(tools[0].text).toContain('done')
  })

  it('restores per-backend/profile/logical-session drafts across switches, restart, and reconnect', async () => {
    const values = new Map<string, string>()

    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {values.set(key, value)},
      removeItem: (key: string) => {values.delete(key)}
    }

    const a = { backend_namespace: 'desktop-a', profile: 'atlas', stored_session_id: 'logical-a' }
    const b = { backend_namespace: 'desktop-a', profile: 'atlas', stored_session_id: 'logical-b' }
    const otherProfile = { ...a, profile: 'mentor' }
    const otherBackend = { ...a, backend_namespace: 'desktop-b' }
    const first = createCompanionStore({ storage })

    first.activateSessionDraft(a); first.setDraft('draft A')
    first.activateSessionDraft(b); first.setDraft('draft B')
    first.activateSessionDraft(otherProfile); first.setDraft('draft mentor')
    first.activateSessionDraft(otherBackend); first.setDraft('draft backend B')
    first.activateSessionDraft(a)
    expect(first.getSnapshot().draft).toBe('draft A')
    first.destroy()

    const restarted = createCompanionStore({ storage })
    restarted.activateSessionDraft(a)
    expect(restarted.getSnapshot().draft).toBe('draft A')
    restarted.activateSessionDraft(b)
    expect(restarted.getSnapshot().draft).toBe('draft B')

    await restarted.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    restarted.activateSessionDraft(a)
    restarted.setDraft('survives reconnect')
    await restarted.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    restarted.activateSessionDraft(a)
    expect(restarted.getSnapshot().draft).toBe('survives reconnect')
  })

  it('keeps an in-memory draft and allows owner switch after failed persistence is safely purged', async () => {
    const values = new Map<string, string>()

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key.includes('sessionDrafts')) {throw new Error('private storage unavailable')}
        values.set(key, value)
      },
      removeItem: (key: string) => {values.delete(key)}
    }

    const store = createCompanionStore({
      gatewayFactory: () => new ControlledGateway(), ownerAuthBridge: ownerAuth, storage
    })

    const target = { backend_namespace: 'desktop-a', profile: 'atlas', stored_session_id: 'logical-a' }

    store.activateSessionDraft(target)
    expect(() => store.setDraft('memory-only draft')).not.toThrow()
    expect(store.getSnapshot()).toMatchObject({
      draft: 'memory-only draft',
      error: 'Companion could not save drafts securely on this device. The current draft is available only until the app closes.'
    })

    await store.configureOwner({ baseUrl: 'https://gateway.test' })

    expect(ownerAuth.ownerSignIn).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', connectionMode: 'owner', error: null })
  })

  it('clears a transient draft persistence warning after a later successful save', () => {
    const values = new Map<string, string>()
    let blockDraftStorage = true

    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (blockDraftStorage && key.includes('sessionDrafts')) {throw new Error('private storage unavailable')}
        values.set(key, value)
      },
      removeItem: (key: string) => {values.delete(key)}
    }

    const store = createCompanionStore({ storage })

    store.activateSessionDraft({ backend_namespace: 'desktop-a', profile: 'atlas', stored_session_id: 'logical-a' })
    store.setDraft('memory-only draft')
    expect(store.getSnapshot().error).toBe(
      'Companion could not save drafts securely on this device. The current draft is available only until the app closes.'
    )

    blockDraftStorage = false
    store.setDraft('persisted draft')

    expect(store.getSnapshot()).toMatchObject({ draft: 'persisted draft', error: null })
  })

  it('blocks owner replacement on unpurged draft plaintext but still attempts native sign-out cleanup', async () => {
    const values = new Map<string, string>()
    let blockDraftStorage = false

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (blockDraftStorage && key.includes('sessionDrafts')) {throw new Error('write blocked')}
        values.set(key, value)
      },
      removeItem: (key: string) => {
        if (blockDraftStorage && key.includes('sessionDrafts')) {throw new Error('remove blocked')}
        values.delete(key)
      }
    }

    const store = createCompanionStore({
      gatewayFactory: () => new ControlledGateway(), ownerAuthBridge: ownerAuth, storage
    })

    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    store.activateSessionDraft({ backend_namespace: 'desktop-a', profile: 'atlas', stored_session_id: 'logical-a' })
    store.setDraft('private plaintext')
    blockDraftStorage = true

    expect(() => store.setDraft('still available in memory')).not.toThrow()
    await store.signOutOwner()

    expect(ownerAuth.ownerSignOut).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().error).toBe(
      'Companion could not save drafts securely on this device. The current draft is available only until the app closes.'
    )

    await store.configureOwner({ baseUrl: 'https://gateway.test' })

    expect(ownerAuth.ownerSignIn).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({
      phase: 'setup', connectionMode: 'shared',
      error: 'Companion could not save drafts securely on this device. The current draft is available only until the app closes.'
    })
  })

  it('clears identity-bound drafts on owner sign-out and saved-token forget', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const owner = harness(null, undefined, undefined, ownerAuth)
    await owner.store.configureOwner({ baseUrl: 'https://gateway.test' })
    owner.store.activateSessionDraft({ backend_namespace: 'desktop-a', profile: 'atlas', stored_session_id: 'logical-a' })
    owner.store.setDraft('owner private draft')
    await owner.store.signOutOwner()
    expect(owner.store.getSnapshot().draft).toBe('')
    expect([...owner.values.values()].join('')).not.toContain('owner private draft')

    const shared = harness(null, undefined, tokenStore('saved-token'))
    shared.store.activateSessionDraft({ backend_namespace: 'desktop-a', profile: 'atlas', stored_session_id: 'logical-a' })
    shared.store.setDraft('shared private draft')
    await shared.store.forgetSavedToken()
    expect(shared.store.getSnapshot().draft).toBe('')
    expect([...shared.values.values()].join('')).not.toContain('shared private draft')
  })

  it('replaces the shared transport with an owner ticket connection and signs out closed', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(async () => undefined),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner-ticket-one')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configure({ baseUrl: 'https://gateway.test', token: 'shared-secret' })

    await store.connectOwner()

    expect(ownerAuth.ownerWebSocketUrl).toHaveBeenCalledWith({ baseUrl: 'https://gateway.test' })
    expect(gateways).toHaveLength(2)
    expect(gateways[0].calls.filter(([name]) => name === 'close')).toHaveLength(1)
    expect(gateways[1].calls[0]).toEqual(['connect', 'wss://gateway.test/api/ws?ticket=owner-ticket-one'])
    expect(JSON.stringify(gateways[1].calls)).not.toContain('shared-secret')
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', connectionMode: 'owner' })

    await store.signOutOwner()

    expect(gateways[1].calls.filter(([name]) => name === 'close')).toHaveLength(1)
    expect(ownerAuth.ownerSignOut).toHaveBeenCalledWith({ baseUrl: 'https://gateway.test' })
    expect(store.getSnapshot()).toMatchObject({ phase: 'disconnected', connectionMode: 'shared' })
  })

  it('clears the complete owner presentation before native sign-out settles', async () => {
    const signOut = deferred<void>()

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(() => signOut.promise),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner-ticket')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth, (gateway) => {
      gateway.sessions = [{
        id: 'private-stored', title: 'Private recent session', preview: 'Private preview',
        started_at: 1, last_active: 2, message_count: 1, source: 'desktop-a', pinned: false
      }]
      gateway.attentionResult = {
        scope: 'private-runtime',
        items: [{
          id: 'private-attention', kind: 'approval', profile: 'atlas', runtime_session_id: 'runtime-1',
          stored_session_id: 'private-stored', title: 'Private attention', detail: 'Owner-only detail',
          occurred_at: 1, actionable: true, resolution: 'approval'
        }]
      }
    })

    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    await store.selectTeammate('atlas')
    gateways[0].emit({ type: 'message.delta', session_id: 'runtime-1', payload: { text: 'Private stream' } })
    gateways[0].emit({
      type: 'approval.request', session_id: 'runtime-1',
      payload: { request_id: 'private-approval', description: 'Private approval' }
    })
    store.setDraft('Private draft')
    expect(JSON.stringify(store.getSnapshot())).toContain('Private')

    const signingOut = store.signOutOwner()

    expect(store.getSnapshot()).toMatchObject({
      phase: 'disconnected', connectionMode: 'shared', teammates: [], selectedTeammateId: null,
      runtimeSessionId: null, storedSessionId: null, activeSession: null, messages: [],
      streamingText: '', pendingApproval: null, attentionItems: [],
      attentionScope: 'This gateway runtime only', recentSessions: [], sessionsLoading: false,
      draft: '', turnStatus: 'idle', error: null
    })
    expect(JSON.stringify(store.getSnapshot())).not.toContain('Private')

    signOut.resolve()
    await signingOut
  })

  it('clears the complete owner presentation before owner reauthentication settles', async () => {
    const reauthentication = deferred<{ signedIn: boolean }>()

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn()
        .mockResolvedValueOnce({ signedIn: true })
        .mockImplementationOnce(() => reauthentication.promise),
      ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner-ticket')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth, (gateway) => {
      gateway.sessions = [{
        id: 'private-stored', title: 'Private recent session', preview: 'Private preview',
        started_at: 1, last_active: 2, message_count: 1, source: 'desktop-a', pinned: false
      }]
      gateway.attentionResult = {
        scope: 'private-runtime',
        items: [{
          id: 'private-attention', kind: 'approval', profile: 'atlas', runtime_session_id: 'runtime-1',
          stored_session_id: 'private-stored', title: 'Private attention', detail: 'Owner-only detail',
          occurred_at: 1, actionable: true, resolution: 'approval'
        }]
      }
    })

    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    await store.selectTeammate('atlas')
    gateways[0].emit({ type: 'message.delta', session_id: 'runtime-1', payload: { text: 'Private stream' } })
    gateways[0].emit({
      type: 'approval.request', session_id: 'runtime-1',
      payload: { request_id: 'private-approval', description: 'Private approval' }
    })
    store.setDraft('Private draft')
    expect(JSON.stringify(store.getSnapshot())).toContain('Private')

    const configuring = store.configureOwner({ baseUrl: 'https://gateway.test' })

    expect(gateways[0].calls.filter(([name]) => name === 'close')).toHaveLength(1)
    expect(store.getSnapshot()).toMatchObject({
      phase: 'connecting', connectionMode: 'shared', teammates: [], selectedTeammateId: null,
      runtimeSessionId: null, storedSessionId: null, activeSession: null, messages: [],
      streamingText: '', pendingApproval: null, attentionItems: [],
      attentionScope: 'This gateway runtime only', recentSessions: [], sessionsLoading: false,
      draft: '', turnStatus: 'idle', error: null
    })
    expect(JSON.stringify(store.getSnapshot())).not.toContain('Private')

    reauthentication.resolve({ signedIn: true })
    await configuring
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', connectionMode: 'owner' })
  })

  it('purges owner-only Work and directory caches before sign-out completes', async () => {
    const signOut = deferred<void>()

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(), ownerStatus: vi.fn(async () => ({ signedIn: true })),
      ownerSignOut: vi.fn(() => signOut.promise),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner-ticket')
    }

    const { createFakeWorkGateway } = await import('../fixtures/fake-work-gateway')
    const store = createCompanionStore({ gatewayFactory: createFakeWorkGateway, ownerAuthBridge: ownerAuth, storage: { getItem: () => null, setItem: () => undefined } })
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    await store.work.open('atlas', 'fixture-review')
    await store.directory.openSession('atlas', 'synthetic-session-1', 'fixture-mac-mini')
    expect(store.work.getSnapshot().selected?.discussion?.[0]?.body).toContain('Synthetic discussion')
    expect(store.directory.getSnapshot().history?.entries[0]?.content).toContain('Synthetic request')

    const signingOut = store.signOutOwner()
    expect(store.work.getSnapshot()).toMatchObject({ items: [], selected: null, sources: [] })
    expect(store.directory.getSnapshot()).toMatchObject({ sessions: [], projects: [], topics: [], history: null })
    expect(JSON.stringify(store.work.getSnapshot())).not.toContain('Synthetic discussion')
    expect(JSON.stringify(store.directory.getSnapshot())).not.toContain('Synthetic request')
    signOut.resolve(); await signingOut
  })

  it('recovers owner mode with a fresh one-use ticket instead of the saved shared token', async () => {
    const ownerUrls = [
      'wss://gateway.test/api/ws?ticket=owner-ticket-one',
      'wss://gateway.test/api/ws?ticket=owner-ticket-two'
    ]

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => ownerUrls.shift()!)
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configure({ baseUrl: 'https://gateway.test', token: 'shared-secret' })
    await store.connectOwner()
    gateways[1].setState('closed')

    await store.recover()

    expect(ownerAuth.ownerWebSocketUrl).toHaveBeenCalledTimes(2)
    expect(gateways[2].calls[0]).toEqual(['connect', 'wss://gateway.test/api/ws?ticket=owner-ticket-two'])
    expect(JSON.stringify(gateways[2].calls)).not.toContain('shared-secret')
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', connectionMode: 'owner' })
  })

  it('refreshes authoritative attention for events from a non-selected runtime session', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    gateways[0].attentionResult = {
      scope: 'connected_runtime',
      items: [{
        id: 'outcome:other:1', kind: 'error', profile: 'mentor', runtime_session_id: 'other',
        stored_session_id: 'stored-other', title: 'Turn failed', detail: 'Open session.',
        occurred_at: 1, actionable: true, resolution: 'open_session'
      }]
    }

    gateways[0].emit({ type: 'error', session_id: 'other', payload: {} })

    await vi.waitFor(() => expect(store.getSnapshot().attentionItems).toHaveLength(1))
    expect(store.getSnapshot().attentionItems[0].resolution).toBe('open_session')
  })

  it('submits a quick task exactly once through Atlas canonical Bot Chat', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })

    await store.submitQuickTask('atlas', '  Prepare the brief  ')

    expect(gateways[0].calls).toContainEqual(['listSessions', {
      profile: 'atlas', limit: 1, include_hidden: true, include_archived: true, title: 'Bot Chat'
    }])
    expect(gateways[0].calls).toContainEqual(['submitPrompt', 'runtime-1', 'Prepare the brief'])
    expect(gateways[0].calls.filter(([name]) => name === 'submitPrompt')).toHaveLength(1)
    expect(store.getSnapshot()).toMatchObject({ selectedTeammateId: 'atlas', turnStatus: 'streaming' })
  })

  it('does not display a rejected quick task as sent', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    gateways[0].submit = Promise.reject(new Error('gateway rejected'))

    await store.submitQuickTask('atlas', 'Reject this')

    expect(store.getSnapshot().messages.some((message) => message.text === 'Reject this')).toBe(false)
    expect(store.getSnapshot().turnStatus).toBe('idle')
  })

  it('keeps a quick task completed when completion arrives before submit acknowledgement', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    const pending = deferred<{ status: 'streaming' }>()
    gateways[0].submit = pending.promise

    const submitting = store.submitQuickTask('atlas', 'Race-safe quick task')
    await vi.waitFor(() => expect(store.getSnapshot().turnStatus).toBe('submitting'))
    gateways[0].emit({ type: 'message.complete', session_id: 'runtime-1', payload: { text: 'Finished.' } })
    pending.resolve({ status: 'streaming' })
    await submitting

    expect(store.getSnapshot().messages.slice(-2).map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'Race-safe quick task' },
      { role: 'assistant', text: 'Finished.' }
    ])
    expect(store.getSnapshot().turnStatus).toBe('idle')
  })

  it('reports only locally observed roster state across work, approval, completion, and recovery', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    const atlas = store.getSnapshot().teammates[0]
    expect(atlas).toMatchObject({ status: 'idle', summary: 'No local activity observed.' })

    await store.selectTeammate(atlas.id)
    expect(store.getSnapshot().teammates[0]).toMatchObject({ status: 'idle' })
    const pending = deferred<{ status: 'streaming' }>()
    gateways[0].submit = pending.promise
    store.setDraft('Observe this turn')
    const submitting = store.submitDraft()
    expect(store.getSnapshot().teammates[0]).toMatchObject({ status: 'working', summary: 'Conversation in progress.' })

    gateways[0].emit({
      type: 'approval.request',
      session_id: 'runtime-1',
      payload: { request_id: 'approval:local', description: 'Continue?' }
    })
    expect(store.getSnapshot().teammates[0]).toMatchObject({ status: 'needs-approval', summary: 'Waiting for your approval.' })
    await store.respondToApproval('once')
    gateways[0].emit({ type: 'message.complete', session_id: 'runtime-1', payload: { text: 'Done locally.' } })
    pending.resolve({ status: 'streaming' })
    await submitting
    expect(store.getSnapshot().teammates[0]).toMatchObject({ status: 'completed', summary: 'Turn completed.' })

    gateways[0].setState('closed')
    expect(store.getSnapshot().teammates[0]).toMatchObject({ status: 'blocked', summary: 'Connection interrupted.' })
    await store.recover()
    expect(store.getSnapshot().teammates[0]).toMatchObject({ status: 'idle', summary: 'No local activity observed.' })
  })

  it('streams only events for the runtime session and finalizes the assistant message', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)
    store.setDraft('Please check this')
    await store.submitDraft()

    expect(store.getSnapshot()).toMatchObject({ draft: '', turnStatus: 'streaming' })
    expect(gateways[0].calls).toContainEqual(['submitPrompt', 'runtime-1', 'Please check this'])
    gateways[0].emit({ type: 'message.delta', session_id: 'other', payload: { text: 'ignore' } })
    gateways[0].emit({ type: 'message.delta', session_id: 'runtime-1', payload: { text: 'Checking' } })
    expect(store.getSnapshot().streamingText).toBe('Checking')
    gateways[0].emit({ type: 'message.complete', session_id: 'runtime-1', payload: { text: 'Checked.' } })
    expect(store.getSnapshot()).toMatchObject({ streamingText: '', turnStatus: 'idle' })
    expect(store.getSnapshot().messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Checked.' })
  })

  it('sanitizes a direct terminal error before publishing it to the snapshot', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)

    gateways[0].emit({
      type: 'error',
      session_id: 'runtime-1',
      payload: {
        message: 'gateway rejected API_KEY=synthetic-secret cookie=synthetic-cookie',
        details: 'x'.repeat(2_000_000),
        nested: { token: 'synthetic-token' }
      }
    })

    expect(store.getSnapshot()).toMatchObject({
      turnStatus: 'error',
      error: 'Hermes reported an error while running this turn.'
    })
    expect(JSON.stringify(store.getSnapshot())).not.toContain('synthetic-secret')
    expect(JSON.stringify(store.getSnapshot())).not.toContain('synthetic-cookie')
    expect(JSON.stringify(store.getSnapshot())).not.toContain('synthetic-token')
  })

  it('clears a whitespace-padded draft after submitting its trimmed message', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)
    store.setDraft('  Please check this  ')

    await store.submitDraft()

    expect(gateways[0].calls).toContainEqual(['submitPrompt', 'runtime-1', 'Please check this'])
    expect(store.getSnapshot()).toMatchObject({ draft: '', turnStatus: 'streaming' })
  })

  it('preserves an unsent draft and marks an accepted in-flight turn uncertain on disconnect', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)

    const pending = deferred<{ status: 'streaming' }>()
    gateways[0].submit = pending.promise
    store.setDraft('Do this exactly once')
    const submitting = store.submitDraft()
    gateways[0].setState('closed')
    expect(store.getSnapshot()).toMatchObject({
      phase: 'disconnected',
      draft: 'Do this exactly once',
      turnStatus: 'uncertain'
    })
    pending.resolve({ status: 'streaming' })
    await submitting
    expect(store.getSnapshot()).toMatchObject({ phase: 'disconnected', draft: '', turnStatus: 'uncertain' })
  })

  it('sends one Stop RPC while an interrupt is in flight and preserves stopping through late deltas', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)
    store.setDraft('Long-running turn')
    await store.submitDraft()
    const pendingStop = deferred<SessionInterruptResult>()
    gateways[0].interruptResult = pendingStop.promise

    const firstStop = store.interrupt()
    const repeatedStop = store.interrupt()
    gateways[0].emit({ type: 'message.delta', session_id: 'runtime-1', payload: { text: 'Final partial output' } })

    expect(gateways[0].calls.filter(([name]) => name === 'interruptSession')).toEqual([
      ['interruptSession', 'runtime-1']
    ])
    expect(store.getSnapshot()).toMatchObject({ turnStatus: 'stopping', streamingText: 'Final partial output' })

    pendingStop.resolve({ status: 'interrupted' })
    await Promise.all([firstStop, repeatedStop])
    expect(store.getSnapshot().turnStatus).toBe('interrupted')
  })

  it('keeps confirmed Stop terminal despite late generation events and submit acknowledgement', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)
    const pendingSubmit = deferred<{ status: 'streaming' }>()
    gateways[0].submit = pendingSubmit.promise
    store.setDraft('Stop this generation')
    const submitting = store.submitDraft()

    await store.interrupt()
    const terminal = store.getSnapshot()
    expect(terminal.turnStatus).toBe('interrupted')

    gateways[0].emit({ type: 'message.delta', session_id: 'runtime-1', payload: { text: 'late delta' } })
    gateways[0].emit({ type: 'message.complete', session_id: 'runtime-1', payload: { text: 'late completion' } })
    gateways[0].emit({ type: 'error', session_id: 'runtime-1', payload: { message: 'late error' } })
    pendingSubmit.resolve({ status: 'streaming' })
    await submitting

    expect(store.getSnapshot()).toMatchObject({
      turnStatus: 'interrupted',
      streamingText: '',
      error: terminal.error
    })
    expect(store.getSnapshot().messages.some((message) => message.text === 'late completion')).toBe(false)
  })

  it('keeps an interrupted terminal event authoritative when the Stop RPC settles later', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)
    store.setDraft('Interrupt safely')
    await store.submitDraft()
    const pendingStop = deferred<SessionInterruptResult>()
    gateways[0].interruptResult = pendingStop.promise

    const stopping = store.interrupt()
    gateways[0].emit({
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { text: 'Partial answer retained.', interrupted: true }
    })
    pendingStop.reject(new Error('late transport failure'))
    await stopping

    expect(store.getSnapshot()).toMatchObject({
      turnStatus: 'interrupted',
      streamingText: '',
      error: null
    })
    expect(store.getSnapshot().messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Partial answer retained.' })
  })

  it('does not resurrect an approval when its rejected response settles after interruption', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)
    store.setDraft('Interrupt the approval wait')
    await store.submitDraft()
    gateways[0].emit({
      type: 'approval.request',
      session_id: 'runtime-1',
      payload: { request_id: 'approval:interrupted', description: 'Continue?' }
    })
    const rejectedApproval = deferred<{ resolved: number }>()
    gateways[0].approval = rejectedApproval.promise

    const responding = store.respondToApproval('deny')
    gateways[0].emit({
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { text: 'Stopped before approval settled.', interrupted: true }
    })
    rejectedApproval.reject(new Error('approval no longer pending'))
    await responding

    expect(store.getSnapshot()).toMatchObject({
      pendingApproval: null,
      turnStatus: 'interrupted',
      error: null
    })
    expect(store.getSnapshot().messages.at(-1)).toMatchObject({
      role: 'assistant', text: 'Stopped before approval settled.'
    })
  })

  it('restores a running state after Stop failure and permits an explicit retry', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)
    store.setDraft('Retryable Stop')
    await store.submitDraft()
    gateways[0].interruptResult = Promise.reject(new Error('interrupt unavailable'))

    await store.interrupt()
    expect(store.getSnapshot()).toMatchObject({
      turnStatus: 'streaming',
      error: 'Stop failed. The turn may still be running; try again.'
    })

    gateways[0].interruptResult = Promise.resolve({ status: 'interrupted' })
    await store.interrupt()
    expect(gateways[0].calls.filter(([name]) => name === 'interruptSession')).toHaveLength(2)
    expect(store.getSnapshot()).toMatchObject({ turnStatus: 'interrupted', error: null })
  })

  it('ignores a stale Stop response after switching runtime sessions', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    const atlas = store.getSnapshot().teammates[0]
    await store.selectTeammate(atlas.id)
    store.setDraft('Old runtime turn')
    await store.submitDraft()
    const pendingStop = deferred<SessionInterruptResult>()
    gateways[0].interruptResult = pendingStop.promise
    const stopping = store.interrupt()

    gateways[0].session = { session_id: 'runtime-2', stored_session_id: 'stored-2', messages: [] }
    await store.selectTeammate(atlas.id, 'stored-2')
    pendingStop.resolve({ status: 'interrupted' })
    await stopping

    expect(store.getSnapshot()).toMatchObject({ runtimeSessionId: 'runtime-2', turnStatus: 'idle', error: null })
  })

  it('reconnects by observation only and ignores a Stop response from the replaced transport', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)
    store.setDraft('Do not replay this turn or Stop')
    await store.submitDraft()
    const pendingStop = deferred<SessionInterruptResult>()
    gateways[0].interruptResult = pendingStop.promise
    const stopping = store.interrupt()
    gateways[0].setState('closed')

    await store.recover()
    pendingStop.resolve({ status: 'interrupted' })
    await stopping

    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', runtimeSessionId: 'runtime-1', turnStatus: 'idle' })
    expect(gateways[1].calls).toContainEqual(['resumeSession', 'stored-1', 'atlas'])
    expect(gateways[1].calls.some(([name]) => name === 'submitPrompt' || name === 'interruptSession')).toBe(false)
  })

  it('orders a completion before its deferred submit response after the user message', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)
    const pending = deferred<{ status: 'streaming' }>()
    gateways[0].submit = pending.promise
    store.setDraft('Race-safe prompt')

    const submitting = store.submitDraft()
    gateways[0].emit({
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { text: 'Already complete.' }
    })
    pending.resolve({ status: 'streaming' })
    await submitting

    expect(store.getSnapshot().messages.slice(-2).map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'Race-safe prompt' },
      { role: 'assistant', text: 'Already complete.' }
    ])
    expect(store.getSnapshot()).toMatchObject({ draft: '', turnStatus: 'idle' })
  })

  it('keeps a completed turn idle when the socket closes before its submit response', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)
    const pending = deferred<{ status: 'streaming' }>()
    gateways[0].submit = pending.promise
    store.setDraft('Complete before close')

    const submitting = store.submitDraft()
    gateways[0].emit({
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { text: 'Completed before close.' }
    })
    gateways[0].setState('closed')
    expect(store.getSnapshot()).toMatchObject({ phase: 'disconnected', draft: '', turnStatus: 'idle' })
    pending.resolve({ status: 'streaming' })
    await submitting

    expect(store.getSnapshot().turnStatus).toBe('idle')
    expect(store.getSnapshot().messages.slice(-2).map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  it('keeps an approval until the exact request succeeds', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)
    gateways[0].emit({ type: 'approval.request', session_id: 'runtime-1', payload: { request_id: 'approval:7', description: 'Publish?' } })
    const pending = deferred<{ resolved: number }>()
    gateways[0].approval = pending.promise

    const responding = store.respondToApproval('once')
    expect(store.getSnapshot().pendingApproval?.requestId).toBe('approval:7')
    pending.resolve({ resolved: 1 })
    await responding

    expect(gateways[0].calls).toContainEqual(['respondToApproval', 'runtime-1', 'approval:7', 'once'])
    expect(store.getSnapshot().pendingApproval).toBeNull()
  })

  it('does not let an old session approval response mutate a reused request ID', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    const teammate = store.getSnapshot().teammates[0]
    await store.selectTeammate(teammate.id)
    gateways[0].emit({ type: 'approval.request', session_id: 'runtime-1', payload: { request_id: 'reused', description: 'Old?' } })
    const pending = deferred<{ resolved: number }>()
    gateways[0].approval = pending.promise
    const responding = store.respondToApproval('once')

    gateways[0].session = { ...gateways[0].session, session_id: 'runtime-2', stored_session_id: 'stored-2' }
    await store.selectTeammate(teammate.id)
    gateways[0].emit({ type: 'approval.request', session_id: 'runtime-2', payload: { request_id: 'reused', description: 'New?' } })
    pending.resolve({ resolved: 1 })
    await responding

    expect(store.getSnapshot().pendingApproval).toMatchObject({
      sessionId: 'runtime-2',
      requestId: 'reused',
      title: 'New?',
      responding: false
    })
  })

  it('recovers by reconnecting and resuming history without replaying a prompt', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)
    store.setDraft('unsent')
    gateways[0].setState('closed')

    await store.recover()

    expect(gateways).toHaveLength(2)
    expect(gateways[1].calls).toContainEqual(['resumeSession', 'stored-1', 'atlas'])
    expect(gateways[1].calls.some(([name]) => name === 'submitPrompt')).toBe(false)
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', draft: 'unsent', runtimeSessionId: 'runtime-1' })
  })

  it('clears runtime attention immediately when the transport disconnects', async () => {
    const { store, gateways } = harness()
    const configuring = store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    gateways[0].attentionResult = {
      items: [{
        id: 'runtime-attention', kind: 'approval', profile: 'atlas', runtime_session_id: 'runtime-1',
        stored_session_id: 'stored-1', title: 'Stale approval', detail: 'Only valid on this socket',
        occurred_at: 1, actionable: true, resolution: 'approval'
      }],
      scope: 'This gateway runtime only'
    }
    await configuring
    expect(store.getSnapshot().attentionItems).toHaveLength(1)

    gateways[0].setState('closed')

    expect(store.getSnapshot()).toMatchObject({ phase: 'disconnected', attentionItems: [] })
  })

  it('ignores stale submit and approval completions after transport replacement even when IDs are reused', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    const atlas = store.getSnapshot().teammates[0]
    await store.selectTeammate(atlas.id)

    const oldSubmit = deferred<{ status: 'streaming' }>()
    gateways[0].submit = oldSubmit.promise
    store.setDraft('old transport prompt')
    const submitting = store.submitDraft()
    gateways[0].emit({
      type: 'approval.request',
      session_id: 'runtime-1',
      payload: { request_id: 'reused-request', description: 'Old approval' }
    })
    const oldApproval = deferred<{ resolved: number }>()
    gateways[0].approval = oldApproval.promise
    const responding = store.respondToApproval('once')
    gateways[0].setState('closed')

    await store.recover()
    gateways[1].emit({
      type: 'approval.request',
      session_id: 'runtime-1',
      payload: { request_id: 'reused-request', description: 'New approval' }
    })
    store.setDraft('new transport draft')
    oldSubmit.resolve({ status: 'streaming' })
    oldApproval.resolve({ resolved: 1 })
    await Promise.all([submitting, responding])

    expect(store.getSnapshot().draft).toBe('new transport draft')
    expect(store.getSnapshot().messages.some(({ text }) => text === 'old transport prompt')).toBe(false)
    expect(store.getSnapshot().pendingApproval).toMatchObject({ title: 'New approval', responding: false })
  })

  it('keeps only the newest overlapping connection roster and closes every replaced client once', async () => {
    const { store, gateways } = harness()
    const oldProfiles = deferred<ProfilesListResult>()
    const firstConfigure = store.configure({ baseUrl: 'http://first.test', token: 'first-token' })
    gateways[0].profilesResult = oldProfiles.promise
    await vi.waitFor(() => expect(gateways[0].calls).toContainEqual(['listProfiles']))

    const secondConfigure = store.configure({ baseUrl: 'http://second.test', token: 'second-token' })
    await secondConfigure
    oldProfiles.resolve({ profiles: [{ name: 'stale-profile' }] })
    await firstConfigure

    expect(store.getSnapshot().baseUrl).toBe('http://second.test')
    expect(store.getSnapshot().teammates.map(({ name }) => name)).toEqual(['Atlas', 'Operations Assistant'])
    expect(gateways[0].calls.filter(([name]) => name === 'close')).toHaveLength(1)
    expect(gateways[1].calls.filter(([name]) => name === 'close')).toHaveLength(0)

    gateways[1].setState('closed')
    await store.recover()
    expect(gateways[1].calls.filter(([name]) => name === 'close')).toHaveLength(1)
    store.destroy()
    expect(gateways[2].calls.filter(([name]) => name === 'close')).toHaveLength(1)
  })

  it('keeps the newest overlapping recovery session when an older resume resolves last', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    await store.selectTeammate(store.getSnapshot().teammates[0].id)
    gateways[0].setState('closed')

    const olderResume = deferred<SessionResult>()
    const olderRecovery = store.recover()
    gateways[1].resumeResults.push(olderResume.promise)
    await vi.waitFor(() => expect(gateways[1].calls.some(([name]) => name === 'resumeSession')).toBe(true))

    const newerRecovery = store.recover()
    gateways[2].session = {
      session_id: 'runtime-newest',
      stored_session_id: 'stored-newest',
      messages: [{ role: 'assistant', content: 'Newest recovery.' }]
    }
    await newerRecovery
    olderResume.resolve({
      session_id: 'runtime-stale',
      stored_session_id: 'stored-stale',
      messages: [{ role: 'assistant', content: 'Stale recovery.' }]
    })
    await olderRecovery

    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready',
      runtimeSessionId: 'runtime-newest',
      storedSessionId: 'stored-newest'
    })
    expect(store.getSnapshot().messages.at(-1)?.text).toBe('Newest recovery.')
    expect(gateways[1].calls.filter(([name]) => name === 'close')).toHaveLength(1)
  })

  it('continues an exact persisted target while preserving its loaded history', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    await store.openPersistedSession(
      { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' },
      'Continue exactly once',
      'Named persisted session'
    )

    expect(gateways[0].calls).toContainEqual(['getCompanionSessionHistory', 'atlas', 'stored-exact', undefined, 'backend-1'])
    expect(gateways[0].calls.some(([name]) => name === 'resumeSession')).toBe(false)
    expect(store.getSnapshot()).toMatchObject({
      runtimeSessionId: 'runtime-1', storedSessionId: 'stored-exact', draft: '',
      activeSession: {
        target: { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' },
        title: 'Named persisted session', titleStatus: 'available'
      }
    })
    expect(store.getSnapshot().messages).toEqual([
      { id: 'persisted-1', role: 'assistant', text: 'Persisted reply' },
      { id: expect.any(String), role: 'user', text: 'Continue exactly once' }
    ])
    const call = gateways[0].calls.find(([name]) => name === 'continueCompanionSession')
    expect(call?.[1]).toMatchObject({ backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact', text: 'Continue exactly once' })
    expect((call?.[1] as { client_request_id: string }).client_request_id).toBeTruthy()
  })

  it('clears continuation A before opening cross-profile attention B and routes B text to its runtime', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const profiles = { profiles: [{ name: 'atlas' }, { name: 'mentor' }] }
    const { store, gateways } = harness(null, profiles, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    await store.openPersistedSession(
      { backend_namespace: 'backend-a', profile: 'atlas', stored_session_id: 'stored-a' },
      'Continue A'
    )
    gateways[0].resumeResults.push(Promise.resolve({
      session_id: 'runtime-b', stored_session_id: 'stored-b', backend_namespace: 'backend-b',
      profile: 'mentor', messages: [{ role: 'assistant', content: 'History B' }]
    }))

    await store.openAttention({
      id: 'attention-b', kind: 'question', profile: 'mentor', runtime_session_id: 'runtime-b',
      stored_session_id: 'stored-b', title: 'Attention B', detail: 'Needs input', occurred_at: 1,
      actionable: true, resolution: 'open_session'
    })
    store.setDraft('Reply to B')
    await store.submitDraft()

    expect(gateways[0].calls.filter(([name]) => name === 'continueCompanionSession')).toHaveLength(1)
    expect(gateways[0].calls).toContainEqual(['resumeSession', 'stored-b', 'mentor'])
    expect(gateways[0].calls).toContainEqual(['submitPrompt', 'runtime-b', 'Reply to B'])
    expect(store.getSnapshot()).toMatchObject({ runtimeSessionId: 'runtime-b', storedSessionId: 'stored-b' })
  })

  it('clears continuation A before opening cross-profile bot chat B', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const profiles = { profiles: [{ name: 'atlas' }, { name: 'mentor' }] }
    const { store, gateways } = harness(null, profiles, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    await store.openPersistedSession(
      { backend_namespace: 'backend-a', profile: 'atlas', stored_session_id: 'stored-a' },
      'Continue A'
    )
    gateways[0].sessions = [{
      id: 'bot-b', resolved_id: 'bot-b', title: 'Bot Chat', preview: '', started_at: 1,
      last_active: 2, message_count: 1, source: 'backend-b', pinned: false
    }]
    gateways[0].resumeResults.push(Promise.resolve({
      session_id: 'runtime-b', stored_session_id: 'bot-b', backend_namespace: 'backend-b',
      profile: 'mentor', messages: [{ role: 'assistant', content: 'Bot B' }]
    }))

    const mentorId = store.getSnapshot().teammates.find((teammate) => teammate.id !== 'atlas')!.id
    await store.openBotChat(mentorId)
    store.setDraft('Message bot B')
    await store.submitDraft()

    expect(gateways[0].calls.filter(([name]) => name === 'continueCompanionSession')).toHaveLength(1)
    expect(gateways[0].calls).toContainEqual(['submitPrompt', 'runtime-b', 'Message bot B'])
  })

  it('clears continuation A when a cross-profile quick task establishes runtime B', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const profiles = { profiles: [{ name: 'atlas' }, { name: 'mentor' }] }
    const { store, gateways } = harness(null, profiles, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    await store.openPersistedSession(
      { backend_namespace: 'backend-a', profile: 'atlas', stored_session_id: 'stored-a' },
      'Continue A'
    )
    gateways[0].sessions = [{
      id: 'bot-b', resolved_id: 'bot-b', title: 'Bot Chat', preview: '', started_at: 1,
      last_active: 2, message_count: 1, source: 'backend-b', pinned: false
    }]
    gateways[0].resumeResults.push(Promise.resolve({
      session_id: 'runtime-b', stored_session_id: 'bot-b', backend_namespace: 'backend-b',
      profile: 'mentor', messages: []
    }))

    const mentorId = store.getSnapshot().teammates.find((teammate) => teammate.id !== 'atlas')!.id
    await store.submitQuickTask(mentorId, 'Quick task B')
    store.setDraft('Follow-up B')
    await store.submitDraft()

    expect(gateways[0].calls.filter(([name]) => name === 'continueCompanionSession')).toHaveLength(1)
    expect(gateways[0].calls).toContainEqual(['submitPrompt', 'runtime-b', 'Quick task B'])
    expect(gateways[0].calls).toContainEqual(['submitPrompt', 'runtime-b', 'Follow-up B'])
  })

  it('recovers the selected saved conversation instead of reactivating a prior admitted continuation', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const sessionA = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-a' }
    const sessionB = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-b' }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth, (gateway, index) => {
      if (index === 1) {
        gateway.session = {
          session_id: 'runtime-b', stored_session_id: sessionB.stored_session_id,
          messages: [{ role: 'assistant', content: 'Recovered B.' }]
        }
      }
    })

    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    await store.openPersistedSession(sessionA, 'Send A', 'Session A')

    store.activateSessionDraft(sessionB)
    store.setDraft('Draft B')
    expect(store.getSnapshot()).toMatchObject({
      storedSessionId: 'stored-b', runtimeSessionId: null, draft: 'Draft B', activeSession: null
    })

    gateways[0].setState('closed')
    await store.recover()

    expect(gateways[1].calls).toContainEqual(['resumeSession', 'stored-b', 'atlas'])
    expect(gateways[1].calls).not.toContainEqual(['resumeSession', 'stored-a', 'atlas'])
    expect(store.getSnapshot()).toMatchObject({
      runtimeSessionId: 'runtime-b', storedSessionId: 'stored-b', draft: 'Draft B', activeSession: null
    })
    expect(store.getSnapshot().messages.at(-1)?.text).toBe('Recovered B.')
  })

  it('preserves admitted continuation identity when the same saved conversation is reactivated before reconnect', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-a' }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth, (gateway, index) => {
      if (index === 1) {
        gateway.session = {
          session_id: 'runtime-a-recovered', stored_session_id: target.stored_session_id,
          messages: [{ role: 'assistant', content: 'Recovered A.' }]
        }
      }
    })

    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    await store.openPersistedSession(target, 'Send A', 'Session A')

    store.activateSessionDraft({ ...target })
    store.setDraft('Draft A')
    gateways[0].setState('closed')
    await store.recover()

    expect(gateways[1].calls).toContainEqual(['resumeSession', 'stored-a', 'atlas'])
    expect(store.getSnapshot()).toMatchObject({
      runtimeSessionId: 'runtime-a-recovered', storedSessionId: 'stored-a', draft: 'Draft A',
      activeSession: { target, title: 'Session A', titleStatus: 'available' }
    })
  })

  it.each(['openAttention', 'openBotChat', 'submitQuickTask'] as const)(
    'reconciles unresolved continuation A in the background while %s awaits opening B',
    async (route) => {
      const ownerAuth: OwnerAuthBridge = {
        ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
        ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
      }

      const profiles = { profiles: [{ name: 'atlas' }, { name: 'mentor' }] }
      const sessionA = { backend_namespace: 'backend-a', profile: 'atlas', stored_session_id: 'stored-a' }

      const { store, gateways, values } = harness(null, profiles, undefined, ownerAuth, (gateway, index) => {
        if (index === 1) {
          gateway.reconciliationResults.push(Promise.resolve({
            ...sessionA, status: 'reconciled', reconciled: true, operation_status: 'completed',
            runtime_session_id: 'runtime-a-reconciled'
          }))
        }
      })

      await store.configureOwner({ baseUrl: 'https://gateway.test' })
      const lostAdmission = deferred<ContinueCompanionSessionResult>()
      gateways[0].continuationResults.push(lostAdmission.promise)
      const openingA = store.openPersistedSession(sessionA, 'Send A', 'Session A')
      await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'continueCompanionSession')).toBe(true))
      lostAdmission.reject(new Error('admission response lost'))
      await expect(openingA).rejects.toThrow('admission response lost')
      expect(values.has('hermes.companion.continuityRetry.v1')).toBe(true)

      const openingBResult = deferred<SessionResult>()
      gateways[0].sessions = [{
        id: 'bot-b', resolved_id: 'bot-b', title: 'Bot Chat', preview: '', started_at: 1,
        last_active: 2, message_count: 1, source: 'backend-b', pinned: false
      }]
      gateways[0].resumeResults.push(openingBResult.promise)
      const mentorId = store.getSnapshot().teammates.find((teammate) => teammate.name === 'Mentor')!.id

      const openingB = route === 'openAttention'
        ? store.openAttention({
            id: 'attention-b', kind: 'question', profile: 'mentor', runtime_session_id: 'runtime-b',
            stored_session_id: 'stored-b', title: 'Attention B', detail: 'Needs input', occurred_at: 1,
            actionable: true, resolution: 'open_session'
          })
        : route === 'openBotChat'
          ? store.openBotChat(mentorId)
          : store.submitQuickTask(mentorId, 'Quick task B')

      await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'resumeSession')).toBe(true))
      store.setDraft('Draft B')
      const selectedB = store.getSnapshot()

      gateways[0].setState('closed')
      await store.recover()

      expect(gateways[1].calls).toContainEqual(['getCompanionSessionHistory', 'atlas', 'stored-a', undefined, 'backend-a'])
      expect(values.has('hermes.companion.continuityRetry.v1')).toBe(false)
      expect(store.getSnapshot()).toMatchObject({
        phase: 'ready',
        selectedTeammateId: mentorId,
        runtimeSessionId: selectedB.runtimeSessionId,
        storedSessionId: selectedB.storedSessionId,
        activeSession: selectedB.activeSession,
        messages: selectedB.messages,
        draft: 'Draft B',
        turnStatus: selectedB.turnStatus
      })
      expect(store.getSnapshot().activeSession?.title).toBe(route === 'openAttention' ? 'Attention B' : 'Bot Chat')
      const recoveredB = store.getSnapshot()
      const oldSessionLoads = gateways[0].calls.filter(([name]) => name === 'listSessions').length

      openingBResult.resolve({
        session_id: 'runtime-b', stored_session_id: route === 'openAttention' ? 'stored-b' : 'bot-b',
        backend_namespace: 'backend-b', profile: 'mentor', messages: []
      })
      await openingB
      expect(store.getSnapshot()).toEqual(recoveredB)
      expect(gateways[0].calls.filter(([name]) => name === 'listSessions')).toHaveLength(oldSessionLoads)
      expect(store.getSnapshot().sessionsLoading).toBe(recoveredB.sessionsLoading)
    }
  )

  it.each(['openAttention', 'openBotChat', 'submitQuickTask'] as const)(
    'ignores a stale %s opening failure after unresolved continuation A is recovered',
    async (route) => {
      const ownerAuth: OwnerAuthBridge = {
        ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
        ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
      }

      const profiles = { profiles: [{ name: 'atlas' }, { name: 'mentor' }] }
      const sessionA = { backend_namespace: 'backend-a', profile: 'atlas', stored_session_id: 'stored-a' }

      const { store, gateways, values } = harness(null, profiles, undefined, ownerAuth, (gateway, index) => {
        if (index === 1) {
          gateway.reconciliationResults.push(Promise.resolve({
            ...sessionA, status: 'reconciled', reconciled: true, operation_status: 'completed',
            runtime_session_id: 'runtime-a-reconciled'
          }))
        }
      })

      await store.configureOwner({ baseUrl: 'https://gateway.test' })
      const lostAdmission = deferred<ContinueCompanionSessionResult>()
      gateways[0].continuationResults.push(lostAdmission.promise)
      const openingA = store.openPersistedSession(sessionA, 'Send A', 'Session A')
      await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'continueCompanionSession')).toBe(true))
      lostAdmission.reject(new Error('admission response lost'))
      await expect(openingA).rejects.toThrow('admission response lost')
      expect(values.has('hermes.companion.continuityRetry.v1')).toBe(true)

      const openingBResult = deferred<SessionResult>()
      gateways[0].sessions = [{
        id: 'bot-b', resolved_id: 'bot-b', title: 'Bot Chat', preview: '', started_at: 1,
        last_active: 2, message_count: 1, source: 'backend-b', pinned: false
      }]
      gateways[0].resumeResults.push(openingBResult.promise)
      const mentorId = store.getSnapshot().teammates.find((teammate) => teammate.name === 'Mentor')!.id

      const openingB = route === 'openAttention'
        ? store.openAttention({
            id: 'attention-b', kind: 'question', profile: 'mentor', runtime_session_id: 'runtime-b',
            stored_session_id: 'stored-b', title: 'Attention B', detail: 'Needs input', occurred_at: 1,
            actionable: true, resolution: 'open_session'
          })
        : route === 'openBotChat'
          ? store.openBotChat(mentorId)
          : store.submitQuickTask(mentorId, 'Quick task B')

      await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'resumeSession')).toBe(true))
      store.setDraft('Draft B')

      gateways[0].setState('closed')
      await store.recover()
      const recoveredB = store.getSnapshot()
      expect(recoveredB).toMatchObject({
        phase: 'ready', selectedTeammateId: mentorId, draft: 'Draft B', error: null
      })
      expect(values.has('hermes.companion.continuityRetry.v1')).toBe(false)

      openingBResult.reject(new Error('obsolete opening B failed token=synthetic-secret'))
      await openingB

      expect(store.getSnapshot()).toEqual(recoveredB)
      expect(JSON.stringify(store.getSnapshot())).not.toContain('synthetic-secret')
    }
  )

  it('reconciles unresolved continuation A in the background without replacing selected draft B', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const sessionA = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-a' }
    const sessionB = { backend_namespace: 'backend-2', profile: 'Operations Assistant', stored_session_id: 'stored-b' }

    const { store, gateways, values } = harness(null, undefined, undefined, ownerAuth, (gateway, index) => {
      if (index === 1) {
        gateway.reconciliationResults.push(Promise.resolve({
          ...sessionA, status: 'reconciled', reconciled: true, operation_status: 'completed',
          runtime_session_id: 'runtime-a-reconciled'
        }))
      }
    })

    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const lostAdmission = deferred<ContinueCompanionSessionResult>()
    gateways[0].continuationResults.push(lostAdmission.promise)
    const openingA = store.openPersistedSession(sessionA, 'Send A', 'Session A')
    await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'continueCompanionSession')).toBe(true))
    lostAdmission.reject(new Error('admission response lost'))
    await expect(openingA).rejects.toThrow('admission response lost')
    expect(values.has('hermes.companion.continuityRetry.v1')).toBe(true)

    store.activateSessionDraft(sessionB)
    store.setDraft('Draft B')
    gateways[0].setState('closed')
    const selectedB = store.getSnapshot()

    await store.recover()

    expect(gateways[1].calls).toContainEqual(['getCompanionSessionHistory', 'atlas', 'stored-a', undefined, 'backend-1'])
    expect(gateways[1].calls.some(([name]) => name === 'resumeSession' || name === 'submitPrompt' || name === 'continueCompanionSession')).toBe(false)
    expect(values.has('hermes.companion.continuityRetry.v1')).toBe(false)
    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready',
      selectedTeammateId: selectedB.selectedTeammateId,
      runtimeSessionId: selectedB.runtimeSessionId,
      storedSessionId: 'stored-b',
      activeSession: selectedB.activeSession,
      messages: selectedB.messages,
      draft: 'Draft B',
      turnStatus: selectedB.turnStatus
    })
    store.activateSessionDraft(sessionA)
    expect(store.getSnapshot().draft).toBe('')
  })

  it('applies a terminal continuation event emitted before the runtime ID response', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const continuation = deferred<ContinueCompanionSessionResult>()
    gateways[0].continuationResults.push(continuation.promise)
    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }

    const opening = store.openPersistedSession(target, 'Fast continuation')
    await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'continueCompanionSession')).toBe(true))
    gateways[0].emit({
      type: 'message.complete',
      session_id: 'runtime-fast',
      payload: { text: 'Completed before admission replied.' }
    })
    continuation.resolve({
      ...target,
      session_id: 'runtime-fast',
      stored_session_id: target.stored_session_id,
      messages: [],
      cwd: '/persisted/cwd',
      status: 'streaming'
    })
    await opening

    expect(store.getSnapshot()).toMatchObject({ runtimeSessionId: 'runtime-fast', turnStatus: 'idle', streamingText: '' })
    expect(store.getSnapshot().messages.slice(-2)).toEqual([
      expect.objectContaining({ role: 'user', text: 'Fast continuation' }),
      expect.objectContaining({ role: 'assistant', text: 'Completed before admission replied.' })
    ])
  })

  it('applies an interrupted continuation emitted before the runtime ID response', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const continuation = deferred<ContinueCompanionSessionResult>()
    gateways[0].continuationResults.push(continuation.promise)
    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }

    const opening = store.openPersistedSession(target, 'Stop before admission replies')
    await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'continueCompanionSession')).toBe(true))
    gateways[0].emit({
      type: 'message.complete',
      session_id: 'runtime-interrupted',
      payload: { text: 'Partial answer before Stop.', interrupted: true }
    })
    continuation.resolve({
      ...target,
      session_id: 'runtime-interrupted',
      stored_session_id: target.stored_session_id,
      messages: [],
      cwd: '/persisted/cwd',
      status: 'streaming'
    })
    await opening

    expect(store.getSnapshot()).toMatchObject({
      runtimeSessionId: 'runtime-interrupted', turnStatus: 'interrupted', streamingText: '', error: null
    })
    expect(store.getSnapshot().messages.slice(-2)).toEqual([
      expect.objectContaining({ role: 'user', text: 'Stop before admission replies' }),
      expect.objectContaining({ role: 'assistant', text: 'Partial answer before Stop.' })
    ])
  })

  it('replays a buffered continuation terminal before pending approvals settle', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const continuation = deferred<ContinueCompanionSessionResult>()
    const approvals = deferred<{ approvals: [] }>()
    gateways[0].continuationResults.push(continuation.promise)
    gateways[0].pendingApprovalsResult = approvals.promise
    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }

    const opening = store.openPersistedSession(target, 'Fast continuation')
    await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'continueCompanionSession')).toBe(true))
    gateways[0].emit({
      type: 'message.complete',
      session_id: 'runtime-fast',
      payload: { text: 'Completed before approvals loaded.' }
    })
    continuation.resolve({
      ...target,
      session_id: 'runtime-fast',
      stored_session_id: target.stored_session_id,
      messages: [],
      cwd: '/persisted/cwd',
      status: 'streaming'
    })

    await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'listPendingApprovals')).toBe(true))
    expect(store.getSnapshot()).toMatchObject({ runtimeSessionId: 'runtime-fast', turnStatus: 'idle' })
    expect(store.getSnapshot().messages.slice(-2)).toEqual([
      expect.objectContaining({ role: 'user', text: 'Fast continuation' }),
      expect.objectContaining({ role: 'assistant', text: 'Completed before approvals loaded.' })
    ])

    approvals.resolve({ approvals: [] })
    await opening
  })

  it('applies a buffered continuation terminal exactly once while admission is pending', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const continuation = deferred<ContinueCompanionSessionResult>()
    gateways[0].continuationResults.push(continuation.promise)
    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }

    const opening = store.openPersistedSession(target, 'Apply the terminal once')
    await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'continueCompanionSession')).toBe(true))

    for (let index = 0; index < 80; index += 1) {
      gateways[0].emit({
        type: 'message.complete',
        session_id: 'runtime-bounded',
        payload: { text: `Duplicate completion ${index}` }
      })
    }

    continuation.resolve({
      ...target,
      session_id: 'runtime-bounded',
      stored_session_id: target.stored_session_id,
      messages: [],
      cwd: '/persisted/cwd',
      status: 'streaming'
    })
    await opening
    gateways[0].emit({
      type: 'message.complete',
      session_id: 'runtime-bounded',
      payload: { text: 'Duplicate completion after admission' }
    })

    const bufferedReplies = store.getSnapshot().messages.filter((message) => message.text.startsWith('Duplicate completion'))
    expect(bufferedReplies).toEqual([
      expect.objectContaining({ role: 'assistant', text: 'Duplicate completion 0' })
    ])
  })

  it('bounds terminal payload memory while continuation admission is pending', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const continuation = deferred<ContinueCompanionSessionResult>()
    gateways[0].continuationResults.push(continuation.promise)
    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }

    const opening = store.openPersistedSession(target, 'Bound the terminal buffer')
    await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'continueCompanionSession')).toBe(true))
    gateways[0].emit({
      type: 'message.complete',
      session_id: 'runtime-large-terminal',
      payload: { text: 'x'.repeat(100_000) }
    })
    continuation.resolve({
      ...target,
      session_id: 'runtime-large-terminal',
      stored_session_id: target.stored_session_id,
      messages: [],
      cwd: '/persisted/cwd',
      status: 'streaming'
    })
    await opening

    expect(store.getSnapshot().messages.at(-1)).toMatchObject({ role: 'assistant' })
    expect(store.getSnapshot().messages.at(-1)?.text).toHaveLength(65_536)
  })

  it('drops arbitrary fields from a buffered error while preserving terminal semantics', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const continuation = deferred<ContinueCompanionSessionResult>()
    gateways[0].continuationResults.push(continuation.promise)
    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }

    const opening = store.openPersistedSession(target, 'Bound buffered errors')
    await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'continueCompanionSession')).toBe(true))
    gateways[0].emit({
      type: 'error',
      session_id: 'runtime-large-error',
      payload: {
        message: 'gateway rejected API_KEY=synthetic-secret',
        details: 'x'.repeat(2_000_000),
        stack: 'synthetic-stack',
        nested: { token: 'synthetic-token' }
      }
    })
    continuation.resolve({
      ...target,
      session_id: 'runtime-large-error',
      stored_session_id: target.stored_session_id,
      messages: [],
      cwd: '/persisted/cwd',
      status: 'streaming'
    })
    await opening

    expect(store.getSnapshot()).toMatchObject({
      runtimeSessionId: 'runtime-large-error',
      turnStatus: 'error',
      error: 'Hermes reported an error while running this turn.'
    })
    expect(JSON.stringify(store.getSnapshot())).not.toContain('synthetic-secret')
    expect(JSON.stringify(store.getSnapshot())).not.toContain('synthetic-token')
    expect(JSON.stringify(store.getSnapshot())).not.toContain('synthetic-stack')
  })

  it('evicts the oldest runtime after 65 distinct buffered continuation terminals', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const continuation = deferred<ContinueCompanionSessionResult>()
    gateways[0].continuationResults.push(continuation.promise)
    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }

    const opening = store.openPersistedSession(target, 'Exercise bounded runtime correlation')
    await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'continueCompanionSession')).toBe(true))

    for (let index = 0; index < 65; index += 1) {
      gateways[0].emit({
        type: 'message.complete',
        session_id: `runtime-${index}`,
        payload: { text: `Buffered terminal ${index}` }
      })
    }

    continuation.resolve({
      ...target,
      session_id: 'runtime-0',
      stored_session_id: target.stored_session_id,
      messages: [],
      cwd: '/persisted/cwd',
      status: 'streaming'
    })
    await opening

    expect(store.getSnapshot()).toMatchObject({ runtimeSessionId: 'runtime-0', turnStatus: 'streaming' })
    expect(store.getSnapshot().messages.some(({ text }) => text === 'Buffered terminal 0')).toBe(false)
    gateways[0].emit({
      type: 'message.complete', session_id: 'runtime-0', payload: { text: 'Fresh terminal after eviction' }
    })
    expect(store.getSnapshot().messages.at(-1)).toMatchObject({
      role: 'assistant', text: 'Fresh terminal after eviction'
    })
  })

  it.each(['owner reset', 'gateway replacement', 'destroy'] as const)(
    'detaches a never-settling continuation during %s',
    async (action) => {
      const ownerAuth: OwnerAuthBridge = {
        ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
        ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
      }

      const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
      await store.configureOwner({ baseUrl: 'https://gateway.test' })
      const neverSettles = deferred<ContinueCompanionSessionResult>()
      gateways[0].continuationResults.push(neverSettles.promise)
      const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }

      void store.openPersistedSession(target, `Pending during ${action}`)
      await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'continueCompanionSession')).toBe(true))

      if (action === 'owner reset') {
        await store.signOutOwner()
      } else if (action === 'gateway replacement') {
        gateways[0].setState('closed')
        await store.recover()
        expect(gateways).toHaveLength(2)
      } else {
        store.destroy()
      }

      const snapshotAfterCleanup = store.getSnapshot()
      gateways[0].emit({
        type: 'message.complete',
        session_id: 'runtime-after-cleanup',
        payload: { text: `Must not survive ${action}` }
      })

      expect(store.getSnapshot()).toBe(snapshotAfterCleanup)
      expect(JSON.stringify(store.getSnapshot())).not.toContain(`Must not survive ${action}`)
      expect(gateways[0].calls.filter(([name]) => name === 'close')).toHaveLength(1)
    }
  )

  it('applies only the buffered continuation error for the admitted runtime ID', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const continuation = deferred<ContinueCompanionSessionResult>()
    gateways[0].continuationResults.push(continuation.promise)
    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }

    const opening = store.openPersistedSession(target, 'Failing continuation')
    await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'continueCompanionSession')).toBe(true))
    gateways[0].emit({ type: 'error', session_id: 'background-runtime', payload: { message: 'Unrelated failure' } })
    gateways[0].emit({ type: 'error', session_id: 'runtime-failed', payload: { message: 'Continuation failed' } })
    continuation.resolve({
      ...target,
      session_id: 'runtime-failed',
      stored_session_id: target.stored_session_id,
      messages: [],
      cwd: '/persisted/cwd',
      status: 'streaming'
    })
    await opening

    expect(store.getSnapshot()).toMatchObject({
      runtimeSessionId: 'runtime-failed', turnStatus: 'error', streamingText: '',
      error: 'Hermes reported an error while running this turn.'
    })
    expect(store.getSnapshot().messages.at(-1)).toMatchObject({ role: 'user', text: 'Failing continuation' })
  })

  it('preserves safe tool, internal, and compaction records when persisted history becomes live', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    vi.spyOn(gateways[0], 'getCompanionSessionHistory').mockResolvedValue({
      session_id: 'stored-exact', profile: 'atlas', source: 'backend-1',
      entries: [
        { id: 'tool', kind: 'tool', role: null, content: '', label: 'Tool completed: terminal', occurred_at: null },
        { id: 'internal', kind: 'internal', role: null, content: '', label: 'Internal notification', occurred_at: null },
        { id: 'compression', kind: 'compression', role: null, content: 'Safe summary', label: 'Earlier context summary', occurred_at: null }
      ],
      linked_work: [], linked_work_available: false, has_more: false, next_cursor: null,
      coverage: { complete: true, freshness: null, message: null }
    })

    await store.openPersistedSession({ backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }, 'Continue')

    expect(store.getSnapshot().messages.slice(0, 3)).toEqual([
      expect.objectContaining({ id: 'tool', kind: 'tool', label: 'Tool completed: terminal' }),
      expect.objectContaining({ id: 'internal', kind: 'internal', label: 'Internal notification' }),
      expect.objectContaining({ id: 'compression', kind: 'compression', text: 'Safe summary' })
    ])
  })

  it('keeps every later send on the durable persisted-continuation path', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    await store.openPersistedSession(target, 'First persisted send')
    store.setDraft('Second persisted send')

    await store.submitDraft()

    const calls = gateways[0].calls.filter(([name]) => name === 'continueCompanionSession')
    expect(calls).toHaveLength(2)
    expect(calls[1][1]).toMatchObject({ ...target, text: 'Second persisted send' })
    expect((calls[1][1] as { client_request_id: string }).client_request_id)
      .not.toBe((calls[0][1] as { client_request_id: string }).client_request_id)
    expect(gateways[0].calls.some(([name]) => name === 'submitPrompt')).toBe(false)
  })

  it('preserves raw continuation whitespace and a newer in-flight edit while sending trimmed text', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways, values } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const continuation = deferred<ContinueCompanionSessionResult>()
    gateways[0].continuationResults.push(continuation.promise)
    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }

    const opening = store.openPersistedSession(target, '  preserve this  ')
    await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'continueCompanionSession')).toBe(true))
    expect(gateways[0].calls.find(([name]) => name === 'continueCompanionSession')?.[1]).toMatchObject({ text: 'preserve this' })
    expect(store.getSnapshot().draft).toBe('  preserve this  ')
    expect(values.get('hermes.companion.sessionDrafts.v1')).toContain('  preserve this  ')
    store.setDraft('newer edit')
    continuation.resolve({
      ...target,
      session_id: 'runtime-preserve',
      stored_session_id: target.stored_session_id,
      messages: [],
      cwd: '/persisted/cwd',
      status: 'streaming'
    })
    await opening

    expect(store.getSnapshot()).toMatchObject({ draft: 'newer edit', runtimeSessionId: 'runtime-preserve' })
    expect(values.get('hermes.companion.sessionDrafts.v1')).toContain('newer edit')

    store.setDraft('  clear only this exact raw draft  ')
    await store.submitDraft()
    expect(gateways[0].calls.filter(([name]) => name === 'continueCompanionSession').at(-1)?.[1])
      .toMatchObject({ text: 'clear only this exact raw draft' })
    expect(store.getSnapshot().draft).toBe('')
  })

  it('preserves an intentionally cleared draft when continuation admission fails', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways, values } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const continuation = deferred<ContinueCompanionSessionResult>()
    gateways[0].continuationResults.push(continuation.promise)
    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }

    const opening = store.openPersistedSession(target, '  original  ')
    await vi.waitFor(() => expect(gateways[0].calls.some(([name]) => name === 'continueCompanionSession')).toBe(true))
    store.setDraft('')
    continuation.reject(new Error('admission response lost'))

    await expect(opening).rejects.toThrow('admission response lost')
    expect(store.getSnapshot()).toMatchObject({ draft: '', turnStatus: 'uncertain' })
    expect(values.get('hermes.companion.sessionDrafts.v1') ?? '').not.toContain('original')
  })

  it('preserves an intentionally cleared draft when continuity reconciliation fails', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }
    gateways[0].continuationResults.push(Promise.resolve({ ...target, status: 'uncertain', reconciled: true }))
    await expect(store.openPersistedSession(target, 'Older accepted message')).rejects.toThrow(/may have accepted/i)
    const reconciliation = deferred<Awaited<ReturnType<CompanionGateway['reconcileCompanionSession']>>>()
    gateways[0].reconciliationResults.push(reconciliation.promise)

    const retrying = store.openPersistedSession(target, '  original retry  ')
    await vi.waitFor(() => expect(gateways[0].calls.filter(([name]) => name === 'reconcileCompanionSession')).toHaveLength(1))
    store.setDraft('')
    reconciliation.reject(new Error('reconciliation response lost'))

    await expect(retrying).rejects.toThrow('reconciliation response lost')
    expect(store.getSnapshot()).toMatchObject({ draft: '', turnStatus: 'uncertain' })
  })

  it.each(['message.complete', 'error'] as const)(
    'detaches admitted runtime A before a late %s arrives after selecting B',
    async (type) => {
      const ownerAuth: OwnerAuthBridge = {
        ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
        ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
      }

      const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
      await store.configureOwner({ baseUrl: 'https://gateway.test' })
      const sessionA = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-a' }
      const sessionB = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-b' }
      gateways[0].session = { session_id: 'runtime-a', stored_session_id: 'stored-a', messages: [] }
      await store.openPersistedSession(sessionA, 'Send A')
      expect(store.getSnapshot()).toMatchObject({ runtimeSessionId: 'runtime-a', turnStatus: 'streaming' })

      store.activateSessionDraft(sessionB)
      store.setDraft('Draft for B')
      const beforeLateEvent = store.getSnapshot()
      gateways[0].emit(type === 'message.complete'
        ? { type, session_id: 'runtime-a', payload: { text: 'late A completion API_KEY=synthetic-secret' } }
        : { type, session_id: 'runtime-a', payload: { message: 'late A gateway error token=synthetic-token' } })

      expect(store.getSnapshot()).toBe(beforeLateEvent)
      expect(store.getSnapshot()).toMatchObject({
        runtimeSessionId: null,
        storedSessionId: 'stored-b',
        draft: 'Draft for B',
        turnStatus: 'idle',
        error: null
      })
      expect(JSON.stringify(store.getSnapshot())).not.toContain('synthetic-secret')
      expect(JSON.stringify(store.getSnapshot())).not.toContain('synthetic-token')
    }
  )

  it.each(['saved-session', 'active-composer'] as const)(
    'handles a %s continuation preflight rejection as an unsent retryable draft',
    async (path) => {
      const ownerAuth: OwnerAuthBridge = {
        ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
        ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
      }

      const { store, gateways, values } = harness(null, undefined, undefined, ownerAuth)
      await store.configureOwner({ baseUrl: 'https://gateway.test' })
      const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }

      if (path === 'active-composer') {
        await store.openPersistedSession(target, 'Initial accepted turn')
        store.setDraft('  preserve active draft  ')
      }

      const previousContinuationCalls = gateways[0].calls.filter(([name]) => name === 'continueCompanionSession').length
      vi.spyOn(gateways[0], 'getCompanionSessionHistory')
        .mockRejectedValueOnce(new Error('gateway preflight leaked API_KEY=synthetic-secret'))

      const firstAttempt = path === 'active-composer'
        ? store.submitDraft()
        : store.openPersistedSession(target, '  preserve saved draft  ')

      await expect(firstAttempt).rejects.toThrow('gateway preflight leaked')
      const expectedRawDraft = path === 'active-composer' ? '  preserve active draft  ' : '  preserve saved draft  '
      expect(store.getSnapshot()).toMatchObject({
        draft: expectedRawDraft,
        turnStatus: 'idle',
        error: 'Companion could not reach the gateway. Check the connection and try again.'
      })
      expect(gateways[0].calls.filter(([name]) => name === 'continueCompanionSession')).toHaveLength(previousContinuationCalls)
      expect(values.has('hermes.companion.continuityRetry.v1')).toBe(false)
      expect(values.get('hermes.companion.sessionDrafts.v1')).toContain(expectedRawDraft)
      expect(JSON.stringify(store.getSnapshot())).not.toContain('synthetic-secret')

      if (path === 'active-composer') {await store.submitDraft()}
      else {await store.openPersistedSession(target, expectedRawDraft)}

      expect(gateways[0].calls.filter(([name]) => name === 'continueCompanionSession')).toHaveLength(previousContinuationCalls + 1)
      expect(gateways[0].calls.filter(([name]) => name === 'reconcileCompanionSession')).toHaveLength(0)
    }
  )

  it('fences a late session A continuation from session B and both durable drafts', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const continuation = deferred<ContinueCompanionSessionResult>()
    gateways[0].continuationResults.push(continuation.promise)
    const sessionA = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-a' }
    const sessionB = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-b' }

    const openingA = store.openPersistedSession(sessionA, 'Draft for A')
    await vi.waitFor(() => expect(gateways[0].calls.filter(([name]) => name === 'continueCompanionSession')).toHaveLength(1))
    store.activateSessionDraft(sessionB)
    store.setDraft('Draft for B')

    continuation.resolve({
      ...sessionA,
      session_id: 'runtime-a',
      messages: [],
      cwd: '/persisted/cwd',
      status: 'streaming'
    })

    await expect(openingA).rejects.toThrow('The saved conversation changed before continuation completed.')
    expect(store.getSnapshot()).toMatchObject({ draft: 'Draft for B', runtimeSessionId: null, turnStatus: 'idle' })
    store.activateSessionDraft(sessionA)
    expect(store.getSnapshot().draft).toBe('Draft for A')
    store.activateSessionDraft(sessionB)
    expect(store.getSnapshot().draft).toBe('Draft for B')
  })

  it('abandons session A continuation preflight after activating session B', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways, values } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const history = deferred<CompanionSessionHistoryResult>()
    const getHistory = vi.spyOn(gateways[0], 'getCompanionSessionHistory').mockReturnValue(history.promise)
    const sessionA = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-a' }
    const sessionB = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-b' }

    const openingA = store.openPersistedSession(sessionA, 'Draft for A')
    await vi.waitFor(() => expect(getHistory).toHaveBeenCalledTimes(1))
    store.activateSessionDraft(sessionB)
    store.setDraft('Draft for B')
    history.resolve({
      session_id: sessionA.stored_session_id,
      profile: sessionA.profile,
      source: sessionA.backend_namespace,
      entries: [{ id: 'persisted-a', kind: 'message', role: 'assistant', content: 'History for A', label: null, occurred_at: null }],
      linked_work: [], linked_work_available: false, has_more: false, next_cursor: null,
      coverage: { complete: true, freshness: null, message: null }
    })

    await expect(openingA).rejects.toThrow('The saved conversation changed before continuation completed.')
    expect(gateways[0].calls.filter(([name]) => name === 'continueCompanionSession')).toHaveLength(0)
    expect(store.getSnapshot()).toMatchObject({ draft: 'Draft for B', messages: [], runtimeSessionId: null })
    expect(values.has('hermes.companion.continuityRetry.v1')).toBe(false)
  })

  it('abandons a rejected session A preflight after switching so session B can submit', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways, values } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const history = deferred<CompanionSessionHistoryResult>()
    const getHistory = vi.spyOn(gateways[0], 'getCompanionSessionHistory').mockReturnValueOnce(history.promise)
    const sessionA = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-a' }
    const sessionB = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-b' }

    const openingA = store.openPersistedSession(sessionA, 'Draft for A')
    await vi.waitFor(() => expect(getHistory).toHaveBeenCalledTimes(1))
    store.activateSessionDraft(sessionB)
    store.setDraft('Draft for B')
    history.reject(new Error('session A preflight failed'))

    await expect(openingA).rejects.toThrow('session A preflight failed')
    expect(values.has('hermes.companion.continuityRetry.v1')).toBe(false)
    await store.openPersistedSession(sessionB, 'Draft for B')
    expect(gateways[0].calls.filter(([name]) => name === 'continueCompanionSession')).toHaveLength(1)
  })

  it('reconciles a lost response without creating a second logical send', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const lostResponse = deferred<ContinueCompanionSessionResult>()
    gateways[0].continuationResults.push(lostResponse.promise)

    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }
    const first = store.openPersistedSession(target, 'Retry the same accepted turn')
    await vi.waitFor(() => expect(gateways[0].calls.filter(([name]) => name === 'continueCompanionSession')).toHaveLength(1))
    lostResponse.reject(new Error('response lost after acceptance'))
    await expect(first).rejects.toThrow('response lost after acceptance')
    expect(store.getSnapshot()).toMatchObject({ draft: 'Retry the same accepted turn', turnStatus: 'uncertain' })

    const originalRequestId = (gateways[0].calls.find(([name]) => name === 'continueCompanionSession')?.[1] as { client_request_id: string }).client_request_id
    gateways[0].reconciliationResults.push(Promise.resolve({ ...target, client_request_id: originalRequestId, status: 'reconciled', reconciled: true, operation_status: 'completed' }))
    await store.openPersistedSession(target, 'Retry the same accepted turn')
    const calls = gateways[0].calls.filter(([name]) => name === 'continueCompanionSession')
    expect(calls).toHaveLength(1)
    expect(gateways[0].calls.find(([name]) => name === 'reconcileCompanionSession')?.[1]).toMatchObject({ ...target, client_request_id: originalRequestId })
    expect(store.getSnapshot()).toMatchObject({ draft: '', turnStatus: 'idle' })
  })

  it('preserves a newer draft when an older completed continuity retry reconciles', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }
    gateways[0].continuationResults.push(Promise.resolve({ ...target, status: 'uncertain', reconciled: true }))
    await expect(store.openPersistedSession(target, 'Older accepted message')).rejects.toThrow(/may have accepted/i)
    const requestId = (gateways[0].calls.find(([name]) => name === 'continueCompanionSession')?.[1] as { client_request_id: string }).client_request_id
    gateways[0].reconciliationResults.push(Promise.resolve({
      ...target, client_request_id: requestId, status: 'reconciled', reconciled: true, operation_status: 'completed'
    }))

    await store.openPersistedSession(target, 'Newer unsent draft')

    expect(gateways[0].calls.filter(([name]) => name === 'continueCompanionSession')).toHaveLength(1)
    expect(store.getSnapshot()).toMatchObject({ draft: 'Newer unsent draft', turnStatus: 'idle' })
  })

  it('reconciles continuity through connectOwner before publishing ready', async () => {
    const reconciliation = deferred<Awaited<ReturnType<CompanionGateway['reconcileCompanionSession']>>>()

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth, (gateway, index) => {
      if (index === 1) {gateway.reconciliationResults.push(reconciliation.promise)}
    })

    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    gateways[0].continuationResults.push(Promise.resolve({ ...target, status: 'uncertain', reconciled: true }))
    await expect(store.openPersistedSession(target, 'Accepted during owner session', 'Exact owner title')).rejects.toThrow(/may have accepted/i)
    const activeSession = store.getSnapshot().activeSession
    const requestId = (gateways[0].calls.find(([name]) => name === 'continueCompanionSession')?.[1] as { client_request_id: string }).client_request_id

    const reconnecting = store.connectOwner()
    await vi.waitFor(() => expect(gateways[1].calls.some(([name]) => name === 'reconcileCompanionSession')).toBe(true))
    expect(store.getSnapshot().phase).toBe('recovering')
    reconciliation.resolve({
      ...target, status: 'reconciled', reconciled: true,
      operation_status: 'completed'
    })
    await reconnecting

    expect(gateways[1].calls).toContainEqual(['reconcileCompanionSession', { ...target, client_request_id: requestId }])
    expect(gateways[1].calls.some(([name]) => name === 'continueCompanionSession' || name === 'submitPrompt' || name === 'resumeSession')).toBe(false)
    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready', connectionMode: 'owner', storedSessionId: 'stored-exact',
      draft: '', turnStatus: 'idle', activeSession
    })
  })

  it('drops continuity and drafts from the previous identity during explicit owner sign-in', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }
    const { store, gateways, values } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    gateways[0].continuationResults.push(Promise.resolve({ ...target, status: 'uncertain', reconciled: true }))
    await expect(store.openPersistedSession(target, 'Accepted during owner setup')).rejects.toThrow(/may have accepted/i)
    store.setDraft('Private draft from old owner')
    expect(values.has('hermes.companion.continuityRetry.v1')).toBe(true)
    expect(values.get('hermes.companion.sessionDrafts.v1')).toContain('Private draft from old owner')

    await store.configureOwner({ baseUrl: 'https://gateway.test' })

    expect(values.has('hermes.companion.continuityRetry.v1')).toBe(false)
    expect(values.has('hermes.companion.sessionDrafts.v1')).toBe(false)
    expect(gateways[1].calls.some(([name]) => name === 'reconcileCompanionSession')).toBe(false)
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', connectionMode: 'owner', draft: '', turnStatus: 'idle' })
  })

  it('automatically reconciles a continuity retry on reconnect and preserves exact presentation identity', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }
    let requestId = ''

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth, (gateway, index) => {
      if (index === 1) {
        gateway.reconciliationResults.push(Promise.resolve({
          ...target, client_request_id: requestId, status: 'reconciled', reconciled: true,
          operation_status: 'completed'
        }))
      }
    })

    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    gateways[0].continuationResults.push(Promise.resolve({ ...target, status: 'uncertain', reconciled: true }))

    await expect(store.openPersistedSession(target, 'Accepted exactly once', 'Durable title')).rejects.toThrow(/may have accepted/i)
    const beforeReconnect = store.getSnapshot().activeSession
    requestId = (gateways[0].calls.find(([name]) => name === 'continueCompanionSession')?.[1] as { client_request_id: string }).client_request_id
    gateways[0].setState('closed')
    const recovering = store.recover()
    await recovering

    expect(gateways[1].calls).toContainEqual(['reconcileCompanionSession', { ...target, client_request_id: requestId }])
    expect(gateways[1].calls).toContainEqual(['getCompanionSessionHistory', 'atlas', 'stored-exact', undefined, 'backend-1'])
    expect(gateways[1].calls.some(([name]) => name === 'continueCompanionSession' || name === 'submitPrompt' || name === 'resumeSession')).toBe(false)
    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready', storedSessionId: 'stored-exact', draft: '', turnStatus: 'idle', activeSession: beforeReconnect
    })
  })

  it('persists the continuation binding before its first asynchronous boundary', async () => {
    const values = new Map<string, string>()

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const gateways: ControlledGateway[] = []

    const store = createCompanionStore({
      gatewayFactory: () => { const gateway = new ControlledGateway(); gateways.push(gateway);

 return gateway },
      ownerAuthBridge: ownerAuth,
      storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => {values.set(key, value)}, removeItem: (key) => {values.delete(key)} }
    })

    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }

    const operation = store.openPersistedSession(target, 'Never persist this plaintext')
    const pending = JSON.parse(values.get('hermes.companion.continuityRetry.v1') ?? '{}')

    expect(pending).toMatchObject({ target, clientRequestId: expect.any(String), messageSha256: null })
    expect(values.get('hermes.companion.continuityRetry.v1')).not.toContain('Never persist this plaintext')
    await operation
    expect(gateways[0].calls.some(([name]) => name === 'continueCompanionSession')).toBe(true)
  })

  it('reconciles a persisted continuity request ID in a fresh store without resubmitting', async () => {
    const values = new Map<string, string>()

    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {values.set(key, value)},
      removeItem: (key: string) => {values.delete(key)}
    }

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(async () => ({ signedIn: true })), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const gateways: ControlledGateway[] = []

    const factory = () => { const gateway = new ControlledGateway(); gateways.push(gateway);

 return gateway }

    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }
    const firstStore = createCompanionStore({ gatewayFactory: factory, ownerAuthBridge: ownerAuth, storage })
    await firstStore.configureOwner({ baseUrl: 'https://gateway.test' })
    gateways[0].continuationResults.push(Promise.resolve({ ...target, status: 'uncertain', reconciled: true }))

    const sensitiveText = 'Reconcile after restart with secret sk-live-sensitive'
    await expect(firstStore.openPersistedSession(target, sensitiveText)).rejects.toThrow(/may have accepted/i)
    const firstCall = gateways[0].calls.find(([name]) => name === 'continueCompanionSession')?.[1] as { client_request_id: string }
    const persistedRetry = values.get('hermes.companion.continuityRetry.v1')
    expect(persistedRetry).toContain(firstCall.client_request_id)
    expect(persistedRetry).not.toContain(sensitiveText)
    expect(persistedRetry).not.toContain('sk-live-sensitive')
    expect(JSON.parse(persistedRetry ?? '{}')).toMatchObject({
      target,
      messageSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      clientRequestId: firstCall.client_request_id
    })
    firstStore.destroy()

    const freshStore = createCompanionStore({
      gatewayFactory: () => {
        const gateway = factory()
        gateway.reconciliationResults.push(Promise.resolve({
          ...target, status: 'reconciled', reconciled: true, operation_status: 'completed'
        }))

        return gateway
      },
      ownerAuthBridge: ownerAuth,
      storage
    })

    await vi.waitFor(() => expect(freshStore.getSnapshot().phase).toBe('ready'))
    expect(gateways[1].calls.filter(([name]) => name === 'continueCompanionSession')).toHaveLength(0)
    const reconciliation = gateways[1].calls.find(([name]) => name === 'reconcileCompanionSession')?.[1] as { client_request_id: string }
    expect(reconciliation.client_request_id).toBe(firstCall.client_request_id)
    expect(freshStore.getSnapshot()).toMatchObject({ phase: 'ready', draft: '', turnStatus: 'idle' })
    expect(values.has('hermes.companion.continuityRetry.v1')).toBe(false)
  })

  it('preserves a different durable draft while reconciling continuity after a cold restart', async () => {
    const values = new Map<string, string>()

    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {values.set(key, value)},
      removeItem: (key: string) => {values.delete(key)}
    }

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(async () => ({ signedIn: true })), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }
    const gateways: ControlledGateway[] = []

    const firstStore = createCompanionStore({
      gatewayFactory: () => { const gateway = new ControlledGateway(); gateways.push(gateway);

 return gateway },
      ownerAuthBridge: ownerAuth,
      storage
    })

    await firstStore.configureOwner({ baseUrl: 'https://gateway.test' })
    gateways[0].continuationResults.push(Promise.resolve({ ...target, status: 'uncertain', reconciled: true }))
    await expect(firstStore.openPersistedSession(target, 'Older accepted message')).rejects.toThrow(/may have accepted/i)
    const requestId = (gateways[0].calls.find(([name]) => name === 'continueCompanionSession')?.[1] as { client_request_id: string }).client_request_id
    firstStore.setDraft('Newer durable draft')
    firstStore.destroy()

    const freshStore = createCompanionStore({
      gatewayFactory: () => {
        const gateway = new ControlledGateway()
        gateway.reconciliationResults.push(Promise.resolve({
          ...target, status: 'reconciled', reconciled: true, operation_status: 'completed'
        }))
        gateways.push(gateway)

        return gateway
      },
      ownerAuthBridge: ownerAuth,
      storage
    })

    await vi.waitFor(() => expect(freshStore.getSnapshot().phase).toBe('ready'))

    expect(gateways[1].calls).toContainEqual(['reconcileCompanionSession', { ...target, client_request_id: requestId }])
    expect(gateways[1].calls.some(([name]) => name === 'continueCompanionSession' || name === 'submitPrompt' || name === 'resumeSession')).toBe(false)
    expect(freshStore.getSnapshot()).toMatchObject({ phase: 'ready', draft: 'Newer durable draft', turnStatus: 'idle' })
    expect(values.get('hermes.companion.sessionDrafts.v1')).toContain('Newer durable draft')
    expect(values.has('hermes.companion.continuityRetry.v1')).toBe(false)
  })

  it('removes legacy retry storage that contains plaintext', () => {
    const sensitiveText = 'legacy plaintext password=do-not-keep'

    const values = new Map<string, string>([[
      'hermes.companion.continuityRetry.v1',
      JSON.stringify({
        target: { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' },
        text: sensitiveText,
        clientRequestId: 'legacy-request'
      })
    ]])

    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {values.set(key, value)},
      removeItem: (key: string) => {values.delete(key)}
    }

    const store = createCompanionStore({ storage })
    expect([...values.values()].join('')).not.toContain(sensitiveText)
    store.destroy()
  })

  it.each([
    ['message', { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }, 'Changed retry text'],
    ['target', { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-other' }, 'Original retry text']
  ])('blocks a differing %s while an unresolved continuity request exists', async (_kind, retryTarget, retryText) => {
    const values = new Map<string, string>()

    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {values.set(key, value)},
      removeItem: (key: string) => {values.delete(key)}
    }

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(async () => ({ signedIn: true })), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const gateways: ControlledGateway[] = []

    const factory = () => { const gateway = new ControlledGateway(); gateways.push(gateway);

 return gateway }

    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }
    const firstStore = createCompanionStore({ gatewayFactory: factory, ownerAuthBridge: ownerAuth, storage })
    await firstStore.configureOwner({ baseUrl: 'https://gateway.test' })
    gateways[0].continuationResults.push(Promise.resolve({ ...target, status: 'uncertain', reconciled: true }))

    await expect(firstStore.openPersistedSession(target, 'Original retry text')).rejects.toThrow(/may have accepted/i)
    firstStore.destroy()

    const freshStore = createCompanionStore({
      gatewayFactory: () => {
        const gateway = factory()

        const runningReconciliation = {
          ...target, status: 'reconciled' as const, reconciled: true as const, operation_status: 'running' as const
        }

        gateway.reconciliationResults.push(
          Promise.resolve(runningReconciliation),
          Promise.resolve(runningReconciliation)
        )

        return gateway
      },
      ownerAuthBridge: ownerAuth,
      storage
    })

    await vi.waitFor(() => expect(freshStore.getSnapshot().phase).toBe('ready'))
    await expect(freshStore.openPersistedSession(retryTarget, retryText)).rejects.toThrow(/may have accepted/i)
    expect(gateways[1].calls.filter(([name]) => name === 'continueCompanionSession')).toHaveLength(0)
    expect(gateways[1].calls.filter(([name]) => name === 'reconcileCompanionSession')).toHaveLength(_kind === 'message' ? 2 : 1)
    expect(values.has('hermes.companion.continuityRetry.v1')).toBe(true)
  })

  it('does not reuse a continuity request ID after an authoritative rejection', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true })), ownerStatus: vi.fn(), ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://gateway.test/api/ws?ticket=owner')
    }

    const { store, gateways } = harness(null, undefined, undefined, ownerAuth)
    await store.configureOwner({ baseUrl: 'https://gateway.test' })
    const rejected = deferred<ContinueCompanionSessionResult>()
    gateways[0].continuationResults.push(rejected.promise)
    const target = { backend_namespace: 'backend-1', profile: 'atlas', stored_session_id: 'stored-exact' }

    const rejectedSubmit = store.openPersistedSession(target, 'Try after rejection')
    await vi.waitFor(() => expect(gateways[0].calls.filter(([name]) => name === 'continueCompanionSession')).toHaveLength(1))
    rejected.reject(new JsonRpcGatewayError('session busy', { code: 4091 }))
    await expect(rejectedSubmit).rejects.toThrow('session busy')
    expect(store.getSnapshot().turnStatus).toBe('idle')
    await store.openPersistedSession(target, 'Try after rejection')

    const calls = gateways[0].calls.filter(([name]) => name === 'continueCompanionSession')
    expect((calls[1][1] as { client_request_id: string }).client_request_id)
      .not.toBe((calls[0][1] as { client_request_id: string }).client_request_id)
  })

  it('publishes immutable snapshots and removes transport listeners on destroy', async () => {
    const { store, gateways } = harness()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    const snapshot = store.getSnapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(listener).toHaveBeenCalled()
    unsubscribe()
    store.destroy()
    const calls = listener.mock.calls.length
    gateways[0].setState('closed')
    expect(listener).toHaveBeenCalledTimes(calls)
  })
})
