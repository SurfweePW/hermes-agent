import type { ConnectionState } from '@hermes/shared'
import { describe, expect, it, vi } from 'vitest'

import type { CompanionEvent, ProfilesListResult, SessionResult } from '../gateway/types'

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

function harness(baseUrl: string | null = null, profiles?: ProfilesListResult) {
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

  const store = createCompanionStore({ gatewayFactory: factory, storage })

  return { store, storage, gateways }
}

describe('CompanionStore setup and sessions', () => {
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

  it('creates for a selected profile and resumes an explicitly known stored session', async () => {
    const { store, gateways } = harness()
    await store.configure({ baseUrl: 'http://localhost:8642', token: 'token' })
    const atlas = store.getSnapshot().teammates[0]

    await store.selectTeammate(atlas.id)
    expect(gateways[0].calls).toContainEqual(['createSession', { profile: 'atlas', title: 'Conversation with Atlas' }])
    expect(store.getSnapshot()).toMatchObject({ runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })
    expect(store.getSnapshot().messages[0]).toMatchObject({ role: 'assistant', text: 'Welcome back.' })

    await store.selectTeammate(atlas.id, 'stored-explicit')
    expect(gateways[0].calls).toContainEqual(['resumeSession', 'stored-explicit', 'atlas'])
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
      { profile: '/Users/operator/.hermes/profiles/ops_internal', title: 'Conversation with Hermes Teammate 2' }
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
      { profile: 'atlas', title: 'Conversation with Atlas' }
    ])
    expect(gateways[0].calls).toContainEqual([
      'createSession',
      { profile: 'team-atlas', title: 'Conversation with Atlas' }
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
