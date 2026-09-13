import type { GatewayClientOptions } from '@hermes/shared'
import { describe, expect, it } from 'vitest'

import { CompanionClient } from './companion-client'
import type { CompanionEvent } from './types'

type Listener = (event: Event) => void

class FakeWebSocket {
  readyState: number = WebSocket.CONNECTING
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback: Listener =
      typeof listener === 'function' ? listener : (event) => listener.handleEvent(event)

    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(callback)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === 'function') {
      this.listeners.get(type)?.delete(listener)
    }
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
    this.dispatch('close', new CloseEvent('close'))
  }

  open(): void {
    this.readyState = WebSocket.OPEN
    this.dispatch('open', new Event('open'))
  }

  serverClose(): void {
    this.close()
  }

  receive(frame: unknown): void {
    this.dispatch('message', new MessageEvent('message', { data: JSON.stringify(frame) }))
  }

  frame(index = this.sent.length - 1): {
    id: string
    jsonrpc: '2.0'
    method: string
    params: Record<string, unknown>
  } {
    return JSON.parse(this.sent[index])
  }

  respond(result: unknown, index = this.sent.length - 1): void {
    this.receive({ jsonrpc: '2.0', id: this.frame(index).id, result })
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

function harness(): {
  client: CompanionClient
  connect: () => Promise<FakeWebSocket>
  sockets: FakeWebSocket[]
} {
  const sockets: FakeWebSocket[] = []

  const options: GatewayClientOptions = {
    socketFactory: () => {
      const socket = new FakeWebSocket()
      sockets.push(socket)

      return socket as unknown as WebSocket
    }
  }

  const client = new CompanionClient(options)

  return {
    client,
    sockets,
    connect: async () => {
      const connecting = client.connect('ws://gateway.test/api/ws')
      const socket = sockets.at(-1)

      if (!socket) {
        throw new Error('socket was not created')
      }

      socket.open()
      await connecting

      return socket
    }
  }
}

describe('CompanionClient RPC domain methods', () => {
  it('accepts only a verified allowlisted original-session route', async () => {
    const { client, connect } = harness(); const socket = await connect()
    const request = client.getCompanionSessionHistory('atlas', 'stored-1')
    socket.respond({
      identity: { profile: 'atlas', backend_namespace: 'desktop-db', root_id: 'stored-1' },
      items: [], has_more: false, next_cursor: null, as_of: 1, coverage: 'complete', warnings: [],
      original_route: { verified: true, client: 'hermes-desktop', platform: 'macos', url: 'hermes://session/stored-1?profile=atlas' }
    })
    await expect(request).resolves.toMatchObject({ original_route: { verified: true, client: 'hermes-desktop' } })

    const unsafe = client.getCompanionSessionHistory('atlas', 'stored-1')
    socket.respond({
      identity: { profile: 'atlas', backend_namespace: 'desktop-db', root_id: 'stored-1' },
      items: [], has_more: false, next_cursor: null, as_of: 1, coverage: 'complete', warnings: [],
      original_route: { verified: true, client: 'hermes-desktop', platform: 'macos', url: 'https://attacker.invalid/session' }
    })
    await expect(unsafe).rejects.toThrow(/Malformed companion\.sessions\.history response/)
  })

  it('uses typed owner priority RPCs without accepting an actor', async () => {
    const { client, connect } = harness(); const socket = await connect()
    const capability = client.organizationCapabilities()
    expect(socket.frame()).toEqual(expect.objectContaining({ method: 'companion.organization.capabilities', params: {} }))
    socket.respond({ version: 2, operations: ['needs_me'], read_only: false, sort: 'recommended', policy_version: 'policy-v1', mutation_methods: ['companion.priorities.override_set', 'companion.priorities.restore_recommended'], record_mutation_methods: [], owner_authorization: true, optimistic_concurrency: 'expected_version', idempotency: 'actor_scoped_key', audit: true })
    await expect(capability).resolves.toMatchObject({ version: 2, owner_authorization: true })

    const params = { profile: 'CMO Exact', id: 'override-1', target_id: 'stable:01', mode: 'set_priority' as const, label: 'Do first', reason: 'Material deadline', expires_at: '2099-01-01T00:00:00Z', review_id: null, review_at: null, expected_version: 0 as const, idempotency_key: 'priority-set-1' }
    const set = client.setPriorityOverride(params)
    expect(socket.frame()).toMatchObject({ method: 'companion.priorities.override_set', params })
    expect(socket.frame().params).not.toHaveProperty('actor')
    const record = { ...params, actor: 'owner:server', version: 1, created_at: '2026-01-01T00:00:00Z', created_by: 'owner:server', updated_at: '2026-01-01T00:00:00Z', updated_by: 'owner:server', canonical_id: 'priority-override:override-1' }
    socket.respond({ record, idempotent: false }); await expect(set).resolves.toMatchObject({ record: { version: 1, actor: 'owner:server' } })

    const restoreParams = { profile: 'CMO Exact', id: 'override-1', expected_version: 1, idempotency_key: 'priority-restore-1' }
    const restore = client.restoreRecommendedPriority(restoreParams)
    expect(socket.frame()).toMatchObject({ method: 'companion.priorities.restore_recommended', params: restoreParams })
    socket.respond({ record: { ...record, version: 2 }, restored: true, idempotent: false })
    await expect(restore).resolves.toMatchObject({ restored: true, record: { version: 2 } })
    client.close()
  })

  it('rejects malformed priority capabilities and mutation records', async () => {
    const { client, connect } = harness(); const socket = await connect()
    const capability = client.organizationCapabilities(); socket.respond({ version: 2, mutation_methods: [] })
    await expect(capability).rejects.toThrow('Malformed companion.organization.needs_me response')
    const set = client.setPriorityOverride({ profile: 'cmo', id: 'o', target_id: 'w', mode: 'set_priority', label: 'Now', reason: 'Deadline', expires_at: null, review_id: null, review_at: null, expected_version: 0, idempotency_key: 'k' })
    socket.respond({ record: { version: '1' }, idempotent: false })
    await expect(set).rejects.toThrow('Malformed companion.organization.needs_me response')
    client.close()
  })

  it('uses exact durable work frames without runtime approval semantics', async () => {
    const { client, connect } = harness()
    const socket = await connect()
    const capability = client.workCapabilities('CMO Exact')
    expect(socket.frame()).toMatchObject({ method: 'work.capabilities', params: { profile: 'CMO Exact' } })
    socket.respond({ can_decide: false, reason: 'Human login required' })
    await expect(capability).resolves.toEqual({ can_decide: false, reason: 'Human login required' })
    const list = client.listWork('CMO Exact')
    expect(socket.frame().params).toEqual({ profile: 'CMO Exact', include_snoozed: true })
    socket.respond({ items: [] }); await list
    const decisionParams = { profile: 'CMO Exact', id: 'stable:01', expected_version: 7, revision: 3, action: 'request_changes' as const, idempotency_key: 'decision-1', reason: 'Narrow scope' }
    const decision = client.decideWork(decisionParams)
    expect(socket.frame()).toMatchObject({ method: 'work.decide', params: decisionParams })
    expect(socket.frame().params).toEqual(decisionParams)
    socket.respond({ decision: { id: '11111111-1111-4111-8111-111111111111', card_id: decisionParams.id, revision: decisionParams.revision, action: decisionParams.action, actor: 'owner:test', reason: decisionParams.reason, snoozed_until: null, created_at: '2026-09-01T00:00:00Z', scope: 'none' } })
    await expect(decision).resolves.toMatchObject({ decision: { id: '11111111-1111-4111-8111-111111111111' } })
    const commentParams = { profile: 'CMO Exact', id: 'stable:01', text: 'Focused comment', idempotency_key: 'comment-1' }
    const comment = client.commentWork(commentParams)
    expect(socket.frame()).toMatchObject({ method: 'work.comment', params: commentParams })
    expect(socket.frame().params).toEqual(commentParams)
    socket.respond({ comment: { id: '22222222-2222-4222-8222-222222222222', card_id: commentParams.id, revision: 3, actor: 'human', text: commentParams.text, created_at: '2026-09-01T00:00:00Z' } })
    await expect(comment).resolves.toMatchObject({ comment: { id: '22222222-2222-4222-8222-222222222222' } })
    client.close()
  })

  it('rejects malformed capability instead of granting business decisions', async () => {
    const { client, connect } = harness(); const socket = await connect()
    const request = client.workCapabilities('cmo')
    socket.respond({ can_decide: 'true', reason: null })
    await expect(request).rejects.toThrow('Malformed durable work response')
    client.close()
  })

  it('uses the exact profile, session, prompt, interrupt, and approval protocol', async () => {
    const { client, connect } = harness()
    const socket = await connect()

    const profilesPromise = client.listProfiles()
    expect(socket.frame()).toMatchObject({ method: 'profiles.list', params: {} })
    socket.respond({ profiles: [{ name: 'default' }] })
    await expect(profilesPromise).resolves.toEqual({ profiles: [{ name: 'default' }] })

    const createPromise = client.createSession({ profile: 'loki', title: 'Exact title' })
    expect(socket.frame()).toMatchObject({
      method: 'session.create',
      params: { profile: 'loki', title: 'Exact title' }
    })
    socket.respond({
      session_id: 'runtime/create:01',
      stored_session_id: null,
      messages: [{ role: 'assistant', content: 'ready' }]
    })
    await expect(createPromise).resolves.toEqual({
      session_id: 'runtime/create:01',
      stored_session_id: null,
      messages: [{ role: 'assistant', content: 'ready' }]
    })

    const resumePromise = client.resumeSession('stored/session:99', 'loki')
    expect(socket.frame()).toMatchObject({
      method: 'session.resume',
      params: { session_id: 'stored/session:99', profile: 'loki' }
    })
    socket.respond({
      session_id: 'runtime/resumed:02',
      stored_session_id: 'stored/session:99',
      messages: [{ role: 'user', content: 'hello' }]
    })
    await expect(resumePromise).resolves.toEqual({
      session_id: 'runtime/resumed:02',
      stored_session_id: 'stored/session:99',
      messages: [{ role: 'user', content: 'hello' }]
    })

    const promptPromise = client.submitPrompt('runtime/resumed:02', 'Do not normalize this')
    expect(socket.frame()).toMatchObject({
      method: 'prompt.submit',
      params: { session_id: 'runtime/resumed:02', text: 'Do not normalize this' }
    })
    socket.respond({ status: 'streaming' })
    await expect(promptPromise).resolves.toEqual({ status: 'streaming' })

    const interruptPromise = client.interruptSession('runtime/resumed:02')
    expect(socket.frame()).toMatchObject({
      method: 'session.interrupt',
      params: { session_id: 'runtime/resumed:02' }
    })
    socket.respond({ status: 'interrupted' })
    await expect(interruptPromise).resolves.toEqual({ status: 'interrupted' })

    const pendingPromise = client.listPendingApprovals('runtime/resumed:02')
    expect(socket.frame()).toMatchObject({
      method: 'approval.pending',
      params: { session_id: 'runtime/resumed:02' }
    })
    socket.respond({ approvals: [{ request_id: 'request/raw:α', command: 'rm tmp', flags: ['risky'] }] })
    await expect(pendingPromise).resolves.toEqual({
      approvals: [{ request_id: 'request/raw:α', command: 'rm tmp' }]
    })

    const respondPromise = client.respondToApproval(
      'runtime/resumed:02',
      'request/raw:α',
      'session'
    )

    expect(socket.frame()).toMatchObject({
      method: 'approval.respond',
      params: {
        session_id: 'runtime/resumed:02',
        request_id: 'request/raw:α',
        choice: 'session',
        all: false
      }
    })
    socket.respond({ resolved: 1 })
    await expect(respondPromise).resolves.toEqual({ resolved: 1 })
  })

  it('serializes persisted continuity as one exact composite RPC', async () => {
    const { client, connect } = harness()
    const socket = await connect()
    const params = {
      backend_namespace: 'desktop:mac-mini',
      profile: 'Atlas Exact',
      stored_session_id: 'stored/session:99',
      text: 'Preserve this text exactly',
      client_request_id: 'continuity-request:01'
    }

    const continued = client.continueCompanionSession(params)
    expect(socket.frame()).toEqual(expect.objectContaining({
      method: 'companion.sessions.continue',
      params
    }))
    socket.respond({
      session_id: 'runtime/resumed:02', stored_session_id: 'stored/session:99', messages: [],
      status: 'streaming', backend_namespace: 'desktop:mac-mini', profile: 'Atlas Exact',
      cwd: '/persisted/exact-cwd', reconciled: false
    })
    await expect(continued).resolves.toMatchObject({
      session_id: 'runtime/resumed:02', stored_session_id: 'stored/session:99',
      cwd: '/persisted/exact-cwd', reconciled: false
    })

    const reconcileParams = {
      backend_namespace: 'desktop:mac-mini',
      profile: 'Atlas Exact',
      stored_session_id: 'stored/session:99',
      client_request_id: 'continuity-request:01'
    }
    const reconciled = client.reconcileCompanionSession(reconcileParams)
    expect(socket.frame()).toEqual(expect.objectContaining({
      method: 'companion.sessions.reconcile',
      params: reconcileParams
    }))
    socket.respond({ ...reconcileParams, status: 'reconciled', reconciled: true, operation_status: 'running' })
    await expect(reconciled).resolves.toMatchObject({ operation_status: 'running', reconciled: true })
  })

  it('uses the exact durable creation and request-only reconciliation contracts', async () => {
    const { client, connect } = harness()
    const socket = await connect()
    const request = {
      version: 1,
      backend_namespace: 'desktop:mac-mini',
      profile: 'atlas',
      project_id: null,
      text: 'Preserve this text exactly',
      client_request_id: '11111111-1111-4111-8111-111111111111'
    } as const
    const receipt = {
      version: 1,
      operation_kind: 'create',
      backend_namespace: request.backend_namespace,
      profile: request.profile,
      client_request_id: request.client_request_id,
      project_id: null,
      stored_session_id: 'stored/session:99',
      row_state: 'present',
      operation_status: 'running',
      runtime_session_id: 'runtime/session:01'
    } as const

    const created = client.createCompanionSession(request)
    expect(socket.frame()).toEqual(expect.objectContaining({
      method: 'companion.sessions.create',
      params: request
    }))
    socket.respond(receipt)
    await expect(created).resolves.toEqual(receipt)

    const reconcileRequest = {
      operation_kind: 'create' as const,
      backend_namespace: request.backend_namespace,
      profile: request.profile,
      client_request_id: request.client_request_id
    }
    const reconciled = client.reconcileCompanionSessionCreation(reconcileRequest)
    expect(socket.frame()).toEqual(expect.objectContaining({
      method: 'companion.sessions.reconcile',
      params: reconcileRequest
    }))
    socket.respond({ ...receipt, operation_status: 'completed', runtime_session_id: null })
    await expect(reconciled).resolves.toMatchObject({ operation_status: 'completed' })
  })

  it.each([
    ['unknown field', { unexpected: true }],
    ['wrong scope', { backend_namespace: 'other-backend' }],
    ['wrong request identity', { client_request_id: '22222222-2222-4222-8222-222222222222' }],
    ['noncanonical request UUID', { client_request_id: 'NOT-A-UUID' }],
    ['contradictory not-found row', { operation_status: 'not_found', row_state: 'present' }],
    ['bound status without stored ID', { stored_session_id: null }],
    ['runtime without a row', { row_state: 'absent', runtime_session_id: 'runtime/session:01' }]
  ])('rejects malformed creation receipts: %s', async (_label, change) => {
    const { client, connect } = harness()
    const socket = await connect()
    const request = {
      version: 1 as const,
      backend_namespace: 'desktop:mac-mini', profile: 'atlas', project_id: null,
      text: 'Exact text', client_request_id: '11111111-1111-4111-8111-111111111111'
    }
    const created = client.createCompanionSession(request)
    socket.respond({
      version: 1, operation_kind: 'create', backend_namespace: request.backend_namespace,
      profile: request.profile, client_request_id: request.client_request_id, project_id: null,
      stored_session_id: 'stored/session:99', row_state: 'present', operation_status: 'running',
      runtime_session_id: 'runtime/session:01', ...change
    })

    await expect(created).rejects.toThrow(/malformed companion\.sessions\.create receipt/i)
  })

  it('uses companion attention, session history, pinning, and canonical Bot Chat parameters', async () => {
    const { client, connect } = harness()
    const socket = await connect()

    const attention = client.listAttention()
    expect(socket.frame()).toMatchObject({ method: 'attention.list', params: {} })
    socket.respond({
      scope: 'runtime-local',
      items: [{
        id: 'a1', kind: 'approval', profile: 'atlas', runtime_session_id: 'runtime-1',
        stored_session_id: 'stored-1', title: 'Approval requested', detail: 'Review.',
        occurred_at: 1, actionable: true, resolution: 'approval',
        work_ref: { profile: 'atlas', id: 'durable-work-1' }
      }]
    })
    await expect(attention).resolves.toMatchObject({
      scope: 'runtime-local', items: [{ actionable: true, resolution: 'approval', work_ref: { profile: 'atlas', id: 'durable-work-1' } }]
    })

    const sessions = client.listSessions({ profile: 'atlas', limit: 1, include_hidden: true, include_archived: true, title: 'Bot Chat' })
    expect(socket.frame()).toMatchObject({ method: 'session.list', params: { profile: 'atlas', limit: 1, include_hidden: true, include_archived: true, title: 'Bot Chat' } })
    socket.respond({ sessions: [] })
    await sessions

    const pin = client.setSessionPinned('atlas', 'stored-1', true)
    expect(socket.frame()).toMatchObject({ method: 'session.set_pinned', params: { profile: 'atlas', session_id: 'stored-1', pinned: true } })
    socket.respond({ session_id: 'stored-1', pinned: true, changed: true })
    await pin

    const create = client.createSession({ profile: 'atlas', title: 'Bot Chat', hidden: true, source: 'companion' })
    expect(socket.frame()).toMatchObject({ method: 'session.create', params: { profile: 'atlas', title: 'Bot Chat', hidden: true, source: 'companion' } })
    socket.respond({ session_id: 'runtime-1', stored_session_id: 'stored-1', messages: [] })
    await create
  })

  it('rejects malformed attention and session-list payloads at the trust boundary', async () => {
    const { client, connect } = harness()
    const socket = await connect()

    const attention = client.listAttention()
    socket.respond({ items: [{ kind: 'approval', profile: '/private/profile' }] })
    await expect(attention).rejects.toThrow(/malformed attention\.list response/i)

    const sessions = client.listSessions({ profile: 'atlas' })
    socket.respond({ sessions: [{ id: 'only-an-id' }] })
    await expect(sessions).rejects.toThrow(/malformed session\.list response/i)
  })

  it('rejects malformed canonical Work references on runtime Attention', async () => {
    const { client, connect } = harness()
    const socket = await connect()
    const attention = client.listAttention()
    socket.respond({ items: [{
      id: 'a1', kind: 'approval', profile: 'atlas', runtime_session_id: 'runtime-1',
      stored_session_id: 'stored-1', title: 'Approval requested', detail: 'Review.',
      occurred_at: 1, actionable: true, resolution: 'approval',
      work_ref: { profile: '../atlas', id: 'durable-work-1' }
    }] })

    await expect(attention).rejects.toThrow(/malformed attention\.list response/i)
  })

  it('omits optional session parameters instead of sending undefined values', async () => {
    const { client, connect } = harness()
    const socket = await connect()

    const createPromise = client.createSession()
    expect(socket.frame()).toMatchObject({ method: 'session.create', params: {} })
    socket.respond({ session_id: 'runtime-new', stored_session_id: null, messages: [] })
    await createPromise

    const resumePromise = client.resumeSession('stored-exact')
    expect(socket.frame()).toMatchObject({
      method: 'session.resume',
      params: { session_id: 'stored-exact' }
    })
    socket.respond({
      session_id: 'runtime-new-2',
      stored_session_id: 'stored-exact',
      messages: []
    })
    await resumePromise
  })

  it.each([
    { approvals: 'not-an-array' },
    { approvals: [null] },
    { approvals: [{ command: 'missing request id' }] },
    { approvals: [{ request_id: '' }] },
    { approvals: [{ request_id: ' \t\n ' }] },
    { approvals: [{ request_id: 'bad-boolean', allow_permanent: 'false' }] },
    { approvals: [{ request_id: 'bad-choice', choices: ['once', 'later'] }] },
    { approvals: [{ request_id: 'bad-array', pattern_keys: ['ok', false] }] }
  ])('rejects malformed approval.pending records: %j', async (result) => {
    const { client, connect } = harness()
    const socket = await connect()
    const pending = client.listPendingApprovals('runtime-safe')
    socket.respond(result)

    await expect(pending).rejects.toThrow(/malformed approval\.pending response/i)
  })

  it('allowlists validated approval.pending fields and preserves strict false booleans', async () => {
    const { client, connect } = harness()
    const socket = await connect()
    const pending = client.listPendingApprovals('runtime-safe')
    socket.respond({
      approvals: [{
        request_id: ' safe ',
        allow_session: false,
        allow_permanent: false,
        choices: ['once', 'deny'],
        ignored: { constructor: 'metadata' }
      }]
    })

    await expect(pending).resolves.toEqual({
      approvals: [{
        request_id: ' safe ',
        allow_session: false,
        allow_permanent: false,
        choices: ['once', 'deny']
      }]
    })
  })
})

describe('CompanionClient typed event stream', () => {
  it.each(['', ' \t\n '])(
    'drops approval.request events with an empty request ID: %j',
    async (requestId) => {
      const { client, connect } = harness()
      const socket = await connect()
      const events: CompanionEvent[] = []
      client.onEvent((event) => events.push(event))

      socket.receive({
        method: 'event',
        params: {
          type: 'approval.request',
          session_id: 's:empty-request-id',
          payload: { request_id: requestId }
        }
      })

      expect(events).toEqual([])
    }
  )

  it('delivers typed events before a racing RPC result and keeps sessions distinguishable', async () => {
    const { client, connect } = harness()
    const socket = await connect()
    const events: CompanionEvent[] = []
    client.onEvent((event) => events.push(event))

    const createPromise = client.createSession()
    socket.receive({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        type: 'message.delta',
        session_id: 'runtime-other',
        payload: { text: 'early' }
      }
    })

    expect(events).toEqual([
      {
        type: 'message.delta',
        session_id: 'runtime-other',
        payload: { text: 'early' }
      }
    ])

    socket.respond({ session_id: 'runtime-created', stored_session_id: null, messages: [] })
    await expect(createPromise).resolves.toMatchObject({ session_id: 'runtime-created' })

    socket.receive({ method: 'event', params: { type: 'message.complete', session_id: 's:1', payload: { text: 'done', interrupted: true } } })
    socket.receive({ method: 'event', params: { type: 'tool.start', session_id: 's:1', payload: { id: 'tool-1', name: 'terminal' } } })
    socket.receive({ method: 'event', params: { type: 'tool.progress', session_id: 's:2', payload: { id: 'tool-1', percent: 50 } } })
    socket.receive({ method: 'event', params: { type: 'tool.complete', session_id: 's:1', payload: { id: 'tool-1', output: 'ok' } } })
    socket.receive({
      method: 'event',
      params: {
        type: 'approval.request',
        session_id: 's:2',
        payload: {
          request_id: ' request:raw/7 ',
          command: 'deploy',
          description: 'Deploy now?',
          allow_session: true,
          allow_permanent: false,
          smart_denied: true,
          choices: ['once', 'session', 'always', 'deny'],
          pattern_key: 'deploy:*',
          pattern_keys: ['deploy:*', 'environment:production']
        }
      }
    })
    socket.receive({ method: 'notification', params: { type: 'message.delta', session_id: 'ignored', payload: { delta: 'no' } } })
    socket.receive({ method: 'event', params: { type: 'thinking.delta', session_id: 'ignored', payload: { delta: 'no' } } })

    expect(events.slice(1)).toEqual([
      { type: 'message.complete', session_id: 's:1', payload: { text: 'done', interrupted: true } },
      { type: 'tool.start', session_id: 's:1', payload: { id: 'tool-1', name: 'terminal' } },
      { type: 'tool.progress', session_id: 's:2', payload: { id: 'tool-1', percent: 50 } },
      { type: 'tool.complete', session_id: 's:1', payload: { id: 'tool-1', output: 'ok' } },
      {
        type: 'approval.request',
        session_id: 's:2',
        payload: {
          request_id: ' request:raw/7 ',
          command: 'deploy',
          description: 'Deploy now?',
          allow_session: true,
          allow_permanent: false,
          smart_denied: true,
          choices: ['once', 'session', 'always', 'deny'],
          pattern_key: 'deploy:*',
          pattern_keys: ['deploy:*', 'environment:production']
        }
      }
    ])
  })

  it('reduces terminal errors to a fixed allowlisted payload at the gateway boundary', async () => {
    const { client, connect } = harness()
    const socket = await connect()
    const events: CompanionEvent[] = []
    client.onEvent((event) => events.push(event))

    socket.receive({
      method: 'event',
      params: {
        type: 'error',
        session_id: 'runtime-error',
        payload: {
          message: 'gateway rejected API_KEY=synthetic-secret',
          details: 'x'.repeat(2_000_000),
          stack: 'synthetic-stack',
          nested: { token: 'synthetic-token' }
        }
      }
    })

    expect(events).toEqual([{
      type: 'error',
      session_id: 'runtime-error',
      payload: { message: 'Hermes zgłosił błąd podczas wykonywania tej tury.' }
    }])
    expect(JSON.stringify(events)).not.toContain('synthetic-secret')
    expect(JSON.stringify(events)).not.toContain('synthetic-token')
    expect(JSON.stringify(events)).not.toContain('synthetic-stack')
  })

  it('bounds completed terminal text at the gateway boundary', async () => {
    const { client, connect } = harness()
    const socket = await connect()
    const events: CompanionEvent[] = []
    client.onEvent((event) => events.push(event))

    socket.receive({
      method: 'event',
      params: {
        type: 'message.complete',
        session_id: 'runtime-large-complete',
        payload: { text: 'x'.repeat(100_000), interrupted: false, details: 'must-not-survive' }
      }
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'message.complete',
      session_id: 'runtime-large-complete',
      payload: { interrupted: false }
    })
    expect((events[0] as Extract<CompanionEvent, { type: 'message.complete' }>).payload.text).toHaveLength(65_536)
    expect(JSON.stringify(events)).not.toContain('must-not-survive')
  })

  it('omits malformed approval capabilities and prototype-like metadata', async () => {
    const { client, connect } = harness()
    const socket = await connect()
    const events: CompanionEvent[] = []
    client.onEvent((event) => events.push(event))

    const payload = JSON.parse(`{
      "request_id": "request:malformed",
      "command": false,
      "description": 7,
      "allow_session": "yes",
      "allow_permanent": null,
      "smart_denied": 1,
      "choices": ["once", "invalid", "deny"],
      "pattern_key": ["deploy:*"],
      "pattern_keys": ["deploy:*", 42],
      "__proto__": { "polluted": true },
      "constructor": { "prototype": { "polluted": true } },
      "prototype": { "polluted": true },
      "metadata": "not part of the typed approval contract"
    }`) as Record<string, unknown>

    socket.receive({
      method: 'event',
      params: {
        type: 'approval.request',
        session_id: 's:malformed',
        payload
      }
    })

    expect(events).toEqual([
      {
        type: 'approval.request',
        session_id: 's:malformed',
        payload: { request_id: 'request:malformed' }
      }
    ])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('CompanionClient prompt delivery', () => {
  it('creates a fresh transport on reconnect without replaying accepted prompt or Stop RPCs', async () => {
    const { client, connect, sockets } = harness()
    const firstSocket = await connect()

    const submitted = client.submitPrompt('runtime:once', 'send exactly once')
    expect(firstSocket.sent).toHaveLength(1)
    firstSocket.respond({ status: 'streaming' })
    await submitted

    const stopped = client.interruptSession('runtime:once')
    expect(firstSocket.sent).toHaveLength(2)
    firstSocket.respond({ status: 'interrupted' })
    await stopped

    firstSocket.serverClose()
    const secondSocket = await connect()

    expect(sockets).toHaveLength(2)
    expect(secondSocket.sent).toEqual([])
    expect(firstSocket.sent.map((frame) => JSON.parse(frame).method)).toEqual([
      'prompt.submit',
      'session.interrupt'
    ])
  })
})
