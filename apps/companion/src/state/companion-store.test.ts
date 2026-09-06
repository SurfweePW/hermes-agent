import type { ConnectionState } from '@hermes/shared'
import { describe, expect, it, vi } from 'vitest'

import type { CompanionEvent, GatewaySessionSummary, ProfilesListResult, SessionResult } from '../gateway/types'
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
  approval = Promise.resolve({ resolved: 1 })
  connectResult: Promise<void> = Promise.resolve()
  profilesResult: Promise<ProfilesListResult> | null = null
  sessionResults: Promise<SessionResult>[] = []
  resumeResults: Promise<SessionResult>[] = []
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

 return { status: 'interrupted' } }
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
    clear: vi.fn()
  }

  return store
}

function harness(baseUrl: string | null = null, profiles?: ProfilesListResult, secretStore?: SessionSecretStore, ownerAuthBridge?: OwnerAuthBridge) {
  const gateways: ControlledGateway[] = []

  const factory: CompanionGatewayFactory = () => {
    const gateway = new ControlledGateway()

    if (profiles) {gateway.profiles = profiles}
    gateways.push(gateway)

    return gateway
  }

  const values = new Map<string, string>()

  if (baseUrl) {values.set('hermes.companion.gatewayBaseUrl', baseUrl)}

  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => values.set(key, value))
  }

  const store = createCompanionStore({
    gatewayFactory: factory,
    storage,
    ...(secretStore ? { secretStore } : {}),
    ...(ownerAuthBridge ? { ownerAuthBridge } : {})
  })

  return { store, storage, gateways }
}

describe('CompanionStore setup and sessions', () => {
  it('connects to an older gateway when attention.list is unavailable', async () => {
    const { store, gateways } = harness()
    const configuring = store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })

    gateways[0].listAttention = async () => {throw new Error('Method not found (-32601)')}

    await configuring

    expect(store.getSnapshot()).toMatchObject({
      phase: 'ready', attentionItems: [], attentionScope: 'Unavailable on this gateway version'
    })
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
