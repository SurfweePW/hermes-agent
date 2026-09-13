import { describe, expect, it, vi } from 'vitest'

import type { WorkCard, WorkGateway } from '../../gateway/work-types'

import { canonicalDecisionCount, createWorkStore, distinctRuntimeAttention, verifiedWorkProfiles } from './work-store'

const card: WorkCard = {
  id: 'stable-id', profile: 'cmo', source_key: 'campaign:1', state: 'needs_me', title: 'Campaign', brief: 'Prepare', evidence: ['https://example.org'], next_action: 'Review', owner: 'Pawel', revision: 2, version: 4, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', snoozed_until: null, attention_due: true, attention_key: 'key', recommended_action: 'approve_preparation', approval: null, preparation_status: 'not_authorized', handoff_key: null, execution_link: null, tracker_evidence: null, completion_evidence: null
}

function setup(canDecide = true) {
  let current = { ...card }
  let recordSequence = 0
  const comments: Awaited<ReturnType<WorkGateway['getWork']>>['comments'] = []
  const decisions: Awaited<ReturnType<WorkGateway['getWork']>>['decisions'] = []

  const gateway: WorkGateway = {
    workCapabilities: vi.fn(async () => ({ can_decide: canDecide, reason: canDecide ? null : 'Human dashboard login required' })),
    listWork: vi.fn(async () => ({ items: [current] })),
    getWork: vi.fn(async () => ({ item: current, comments: [...comments], decisions: [...decisions], tracker_status_history: [] })),
    decideWork: vi.fn(async (params) => {
      const decision = { id: `10000000-0000-4000-8000-${String(++recordSequence).padStart(12, '0')}`, card_id: current.id, revision: current.revision, action: params.action, actor: 'human', reason: params.reason ?? '', snoozed_until: params.snoozed_until ?? null, created_at: '2026-09-01T00:01:00Z', scope: params.action === 'approve_preparation' ? 'preparation_only' as const : 'none' as const }
      decisions.push(decision); current = { ...current, state: 'in_progress', version: 5 }

      return { item: current, decision }
    }),
    commentWork: vi.fn(async (params) => {
      const comment = { id: `20000000-0000-4000-8000-${String(++recordSequence).padStart(12, '0')}`, card_id: current.id, revision: current.revision, actor: 'human' as const, text: params.text, created_at: '2026-09-01T00:01:00Z' }
      comments.push(comment)

      return { comment }
    })
  }

  return { gateway, store: createWorkStore(), revise: () => {current = { ...current, revision: 3, version: 6 } } }
}

describe('verified work store', () => {
  const verifiedCmo = new Set(['cmo'])

  it('counts one canonical decision badge without duplicating a Work record surfaced by Attention', () => {
    const items = [
      { ...card, id: 'work-a', attention_key: 'attention-a' },
      { ...card, id: 'work-b', attention_key: 'attention-b' },
      { ...card, id: 'history', state: 'done' as const, attention_due: false, attention_key: 'attention-history' }
    ]

    const attention = [
      { id: 'runtime-approval-old-key', profile: 'cmo', actionable: true, kind: 'approval' as const, work_ref: { profile: 'cmo', id: 'work-a' } },
      { id: 'runtime-question', profile: 'cmo', actionable: true, kind: 'question' as const },
      { id: 'runtime-error', profile: 'cmo', actionable: true, kind: 'error' as const }
    ]

    expect(canonicalDecisionCount(items, attention, verifiedCmo)).toBe(3)
    expect(distinctRuntimeAttention(items, attention, verifiedCmo).map((item) => item.id)).toEqual(['runtime-question', 'runtime-error'])
  })

  it('keeps a due decision in the badge when owner mutation is unavailable', () => {
    const readOnlyDue = {
      id: 'work-a', profile: 'cmo', actionable: false, bucket: 'needs_me' as const,
      attentionKey: 'attention-a'
    }

    const attention = [{ id: 'runtime-approval', profile: 'cmo', actionable: true, kind: 'approval' as const, work_ref: { profile: 'cmo', id: 'work-a' } }]

    expect(canonicalDecisionCount([readOnlyDue], attention, verifiedCmo)).toBe(1)
    expect(distinctRuntimeAttention([readOnlyDue], attention, verifiedCmo)).toEqual([])
  })

  it('treats retained snooze metadata as due once attention_due is true', () => {
    const dueSnooze = { ...card, id: 'due-snooze', attention_key: 'runtime-snooze', snoozed_until: '2026-09-01T02:00:00Z', attention_due: true }
    const projectedDue = { id: 'due-view', profile: 'cmo', actionable: true, bucket: 'needs_me' as const, attentionKey: 'runtime-view', attentionDue: true, snoozedUntil: '2026-09-01T02:00:00Z' }

    const attention = [
      { id: 'old-runtime-snooze', profile: 'cmo', actionable: true, kind: 'approval' as const, work_ref: { profile: 'cmo', id: 'due-snooze' } },
      { id: 'old-runtime-view', profile: 'cmo', actionable: true, kind: 'approval' as const, work_ref: { profile: 'cmo', id: 'due-view' } }
    ]

    expect(canonicalDecisionCount([dueSnooze, projectedDue], attention, verifiedCmo)).toBe(2)
    expect(distinctRuntimeAttention([dueSnooze, projectedDue], attention, verifiedCmo)).toEqual([])
  })

  it('keeps stale runtime Attention suppressed after canonical Work is snoozed, done or declined', () => {
    const items = [
      { ...card, id: 'future-snooze', attention_key: '2026-09-02:2:1', snoozed_until: '2099-09-01T02:00:00Z', attention_due: false },
      { ...card, id: 'done', state: 'done' as const, attention_key: '2026-09-02:3:0', attention_due: false },
      { ...card, id: 'declined', state: 'declined' as const, attention_key: '2026-09-02:4:0', attention_due: false }
    ]
    const attention = [
      { id: '2026-09-01:2:0', profile: 'cmo', actionable: true, kind: 'approval' as const, work_ref: { profile: 'cmo', id: 'future-snooze' } },
      { id: '2026-09-01:2:0', profile: 'cmo', actionable: true, kind: 'approval' as const, work_ref: { profile: 'cmo', id: 'done' } },
      { id: '2026-09-01:3:0', profile: 'cmo', actionable: true, kind: 'approval' as const, work_ref: { profile: 'cmo', id: 'declined' } },
      { id: 'unrelated-runtime', profile: 'cmo', actionable: true, kind: 'question' as const }
    ]

    expect(distinctRuntimeAttention(items, attention, verifiedCmo).map((item) => item.id)).toEqual(['unrelated-runtime'])
    expect(canonicalDecisionCount(items, attention, verifiedCmo)).toBe(1)
  })

  it('keeps runtime Attention without an explicit canonical Work reference', () => {
    const transitioned = { ...card, id: 'work-a', attention_key: '2026-09-02:3:1', state: 'done' as const, attention_due: false }
    const absent = { id: '2026-09-01:2:0', profile: 'cmo', actionable: true, kind: 'approval' as const }
    const unrelated = { ...absent, id: 'other-runtime', work_ref: { profile: 'cmo', id: 'work-b' } }

    expect(distinctRuntimeAttention([transitioned], [absent, unrelated], verifiedCmo)).toEqual([absent, unrelated])
  })

  it('fails open when retained Work belongs to a source whose refresh failed', () => {
    const retained = { ...card, id: 'work-a', state: 'done' as const, attention_due: false }
    const freshRuntime = { id: 'runtime-approval', profile: 'cmo', actionable: true, kind: 'approval' as const, work_ref: { profile: 'cmo', id: 'work-a' } }

    expect(distinctRuntimeAttention([retained], [freshRuntime], new Set())).toEqual([freshRuntime])
    expect(canonicalDecisionCount([retained], [freshRuntime], new Set())).toBe(1)
  })

  it.each(['loading', 'unsupported', 'error'] as const)('does not trust retained source verification while the global Work status is %s', (status) => {
    const profiles = verifiedWorkProfiles({
      status,
      sources: [{ profile: 'cmo', incomplete: false, status: 'verified', lastSuccess: '2026-09-01T00:00:00Z', message: null }]
    })

    expect([...profiles]).toEqual([])
  })

  it('keeps authority per profile after a partially successful refresh', () => {
    const profiles = verifiedWorkProfiles({
      status: 'verified',
      sources: [
        { profile: 'atlas', incomplete: false, status: 'verified', lastSuccess: '2026-09-01T00:00:00Z', message: null },
        { profile: 'cmo', incomplete: true, status: 'error', lastSuccess: '2026-08-31T00:00:00Z', message: 'Refresh failed' }
      ]
    })

    expect([...profiles]).toEqual(['atlas'])
  })

  it('shows actual dispatch, full decision history and snooze suppression across refreshes', async () => {
    const { FakeWorkGateway } = await import('../../fixtures/fake-work-gateway')
    const gateway = new FakeWorkGateway(); const store = createWorkStore()
    await store.attach(gateway, ['atlas'])
    expect(store.getSnapshot().items.find((item) => item.id === 'fixture-snoozed')).toMatchObject({ bucket: 'history', actionable: false })
    await store.open('atlas', 'fixture-review')
    expect(store.getSnapshot().selected?.decisionHistory?.[0]).toMatchObject({ revision: 1, action: 'request_changes' })
    await store.decide({ action: 'approve_preparation' })
    expect(store.getSnapshot().selected).toMatchObject({ id: 'fixture-review', bucket: 'in_progress', preparationStatus: 'Preparation approved — awaiting execution tracker task link', actionable: false })
    expect(store.getSnapshot().selected?.decisionHistory).toHaveLength(2)
    expect(store.getSnapshot().selected?.executionAcknowledgedAt).toBeUndefined()
    await store.refresh()
    expect(store.getSnapshot().selected?.id).toBe('fixture-review')
  })
  it('locks the mutation on an unauthorized source and keeps verified work visible', async () => {
    const { gateway, store } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    vi.mocked(gateway.decideWork).mockRejectedValue({ code: 4403 })
    expect(await store.decide({ action: 'approve_preparation' })).toBe(false)
    expect(store.getSnapshot().status).toBe('error')
    expect(store.getSnapshot().message).toBe('This source is not authorized.')
    expect(store.getSnapshot().selected?.id).toBe('stable-id')
    expect(store.getSnapshot().items.map((item) => item.id)).toContain('stable-id')
  })

  it('keeps verified work of every other source when one source is revoked', async () => {
    const { gateway, store } = setup()
    const otherCard = { ...card, id: 'atlas-work', profile: 'atlas', title: 'Atlas work' }
    vi.mocked(gateway.listWork).mockImplementation(async (requestedProfile) => ({ items: [requestedProfile === 'atlas' ? otherCard : card] }))
    vi.mocked(gateway.getWork).mockImplementation(async (requestedProfile) => ({ item: requestedProfile === 'atlas' ? otherCard : card, comments: [], decisions: [], tracker_status_history: [] }))
    await store.attach(gateway, ['cmo', 'atlas'])
    await store.open('cmo', 'stable-id')
    vi.mocked(gateway.workCapabilities).mockImplementation(async (requestedProfile) => {
      if (requestedProfile === 'cmo') {throw { code: 4403 }}

      return { can_decide: true, reason: null }
    })
    await store.refresh()

    expect(store.getSnapshot().status).toBe('verified')
    expect(store.getSnapshot().sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: 'cmo', status: 'error', message: 'This source is not authorized.' }),
      expect.objectContaining({ profile: 'atlas', status: 'verified' })
    ]))
    expect(store.getSnapshot().items).toEqual(expect.arrayContaining([expect.objectContaining({ id: otherCard.id, profile: 'atlas' })]))
    expect(store.getSnapshot().selected).toMatchObject({ id: 'stable-id', profile: 'cmo' })
  })

  it('signals owner authorization loss without removing verified work', async () => {
    const { gateway } = setup()
    const onOwnerAuthorizationLost = vi.fn()
    const store = createWorkStore({ onOwnerAuthorizationLost })
    await store.attach(gateway, ['cmo'])
    await store.open('cmo', 'stable-id')
    const before = store.getSnapshot()
    vi.mocked(gateway.workCapabilities).mockRejectedValue({ code: 4401 })

    await store.refresh()

    expect(onOwnerAuthorizationLost).toHaveBeenCalledWith(expect.objectContaining({ code: 4401 }))
    expect(store.getSnapshot().items).toEqual(before.items)
    expect(store.getSnapshot().selected).toEqual(before.selected)
  })

  it('uses authoritative profile/id/version/revision and reads back server-generated record IDs', async () => {
    const { gateway, store } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    expect(await store.decide({ action: 'approve_preparation' })).toBe(true)
    expect(gateway.decideWork).toHaveBeenCalledWith({ profile: 'cmo', id: 'stable-id', expected_version: 4, revision: 2, action: 'approve_preparation', idempotency_key: expect.any(String) })
    expect(store.getSnapshot().selected?.decisionHistory?.at(-1)?.id).not.toBe(vi.mocked(gateway.decideWork).mock.calls[0]?.[0].idempotency_key)
    expect(gateway.getWork).toHaveBeenLastCalledWith('cmo', 'stable-id')
    expect(store.getSnapshot().selected?.status).toBe('in_progress')
    expect(await store.comment('Focused persisted discussion')).toBe(true)
    expect(gateway.commentWork).toHaveBeenCalledWith({ profile: 'cmo', id: 'stable-id', text: 'Focused persisted discussion', idempotency_key: expect.any(String) })
    expect(store.getSnapshot().selected?.discussion?.at(-1)?.id).not.toBe(vi.mocked(gateway.commentWork).mock.calls[0]?.[0].idempotency_key)
  })
  it('respects the human capability boundary without falling back to tool approvals', async () => {
    const { gateway, store } = setup(false); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    expect(store.getSnapshot().message).toBe('Human dashboard login required')
    expect(store.getSnapshot().selected?.actionable).toBe(false)
    expect(await store.decide({ action: 'request_changes', comment: 'Not authorized' })).toBe(false)
    expect(gateway.decideWork).not.toHaveBeenCalled()
  })
  it('refreshes stale revisions and requires a new explicit decision', async () => {
    const { gateway, store, revise } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    vi.mocked(gateway.decideWork).mockImplementation(async () => {revise(); throw { code: 4409 }})
    expect(await store.decide({ action: 'approve_preparation' })).toBe(false)
    expect(store.getSnapshot().selected?.revision).toBe(3)
    expect(store.getSnapshot().message).toMatch(/Nothing was automatically retried/)
    expect(gateway.decideWork).toHaveBeenCalledTimes(1)
  })
  it('does not confirm a decision when readback omits the exact server record ID', async () => {
    const { gateway, store } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    vi.mocked(gateway.decideWork).mockImplementation(async (params) => ({ decision: { id: 'server-missing-from-readback', card_id: params.id, revision: params.revision, action: params.action, actor: 'human', reason: params.reason ?? '', snoozed_until: params.snoozed_until ?? null, created_at: '2026-09-01T00:01:00Z', scope: params.action === 'approve_preparation' ? 'preparation_only' : 'none' } }))

    expect(await store.decide({ action: 'approve_preparation' })).toBe(false)
    expect(store.getSnapshot().message).toMatch(/could not be confirmed/i)
    expect(gateway.decideWork).toHaveBeenCalledTimes(1)
  })
  it('rejects an idempotency key echoed as the record UUID even when readback repeats it', async () => {
    const { gateway, store } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    vi.mocked(gateway.decideWork).mockImplementation(async (params) => {
      const decision = { id: params.idempotency_key, card_id: params.id, revision: params.revision, action: params.action, actor: 'human', reason: params.reason ?? '', snoozed_until: params.snoozed_until ?? null, created_at: '2026-09-01T00:01:00Z', scope: params.action === 'approve_preparation' ? 'preparation_only' as const : 'none' as const }
      vi.mocked(gateway.getWork).mockResolvedValue({ item: { ...card, state: 'in_progress', version: 5 }, comments: [], decisions: [decision], tracker_status_history: [] })

      return { decision }
    })

    expect(await store.decide({ action: 'approve_preparation' })).toBe(false)
    expect(gateway.decideWork).toHaveBeenCalledTimes(1)
    expect(gateway.getWork).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().message).toMatch(/could not be confirmed/i)
  })
  it('does not retry an unconfirmed timeout automatically', async () => {
    const { gateway, store } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    vi.mocked(gateway.decideWork).mockRejectedValue(new Error('timeout'))

    expect(await store.decide({ action: 'approve_preparation' })).toBe(false)
    expect(gateway.decideWork).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().message).toMatch(/may already have reached the server/i)
  })
  it('keeps the exact mutation target locked until readback finishes', async () => {
    const { gateway, store } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    let finish!: () => void
    const getVerifiedWork = vi.mocked(gateway.getWork).getMockImplementation()!
    vi.mocked(gateway.getWork).mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => {finish = resolve})

      return getVerifiedWork(...args)
    })
    const result = store.decide({ action: 'approve_preparation' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(store.getSnapshot().pending).toBe(true)
    store.close(); await store.open('cmo', 'different-id')
    expect(store.getSnapshot().selected?.id).toBe('stable-id')
    finish(); expect(await result).toBe(true)
    expect(store.getSnapshot().pending).toBe(false)
    expect(gateway.getWork).toHaveBeenLastCalledWith('cmo', 'stable-id')
  })
  it('retains data but locks mutations after offline or a failed refresh', async () => {
    const { gateway, store } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    vi.mocked(gateway.listWork).mockRejectedValue(new Error('offline'))
    await store.refresh()
    expect(store.getSnapshot().status).toBe('error')
    expect(store.getSnapshot().selected?.id).toBe('stable-id')
    expect(await store.decide({ action: 'request_changes', comment: 'Offline' })).toBe(false)
    store.disconnect()
    expect(store.getSnapshot().status).toBe('offline')
    expect(await store.comment('Do not send')).toBe(false)
  })
  it('does not enable duplicate submissions or let late responses cross connections', async () => {
    const { gateway, store } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    let finish!: () => void
    vi.mocked(gateway.decideWork).mockImplementation((params) => new Promise((resolve) => {finish = () => resolve({ decision: { id: '30000000-0000-4000-8000-000000000001', card_id: params.id, revision: params.revision, action: params.action, actor: 'human', reason: params.reason ?? '', snoozed_until: params.snoozed_until ?? null, created_at: '2026-09-01T00:01:00Z', scope: params.action === 'approve_preparation' ? 'preparation_only' : 'none' } })}))
    const pending = store.decide({ action: 'approve_preparation' })
    expect(store.getSnapshot().pending).toBe(true)
    expect(await store.decide({ action: 'request_changes', comment: 'Duplicate' })).toBe(false)
    store.disconnect(); finish(); await pending
    expect(store.getSnapshot().status).toBe('offline')
    expect(gateway.decideWork).toHaveBeenCalledTimes(1)
  })
  it('maps the fixed reminder to a two-hour server snooze and revalidates it', async () => {
    const { gateway, store } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T10:00:00Z'))

    try {
      expect(await store.decide({ action: 'remind_in_2_hours' })).toBe(true)
      expect(gateway.decideWork).toHaveBeenCalledWith(expect.objectContaining({ action: 'snooze', snoozed_until: '2026-09-05T12:00:00.000Z', profile: 'cmo', id: 'stable-id' }))
    } finally {vi.useRealTimers()}
  })
  it('detects old server capability instead of fabricating an empty success', async () => {
    const { gateway, store } = setup(); vi.mocked(gateway.workCapabilities).mockRejectedValue({ code: -32601 })
    await store.attach(gateway, ['cmo'])
    expect(store.getSnapshot().status).toBe('unsupported')
    expect(gateway.listWork).not.toHaveBeenCalled()
  })
  it('joins recommended priority metadata to the authoritative work identity', async () => {
    const { gateway, store } = setup()

    const listNeedsMePriorities = vi.fn(async () => ({
      profile: 'cmo', backend_namespace: 'test', sort: 'recommended' as const,
      policy_version: 'v1', review_id: null, group_by: 'topic' as const, as_of: '2026-09-01T00:00:00Z',
      coverage: { work: 'complete', organization: 'complete', authorization_filtered: true },
      groups: [{
        id: 'topic-1', eligibility: 'assessed' as const, eligible_action_count: 1,
        why_here: 'Highest expected value',
        group: { kind: 'topic' as const, id: 'topic-1', name: 'Launch', collection: 'Growth', objective: 'Ship' },
        items: [{
          profile: 'cmo', work_id: 'stable-id', candidate_id: 'candidate-1',
          eligibility: 'assessed' as const, why_here: 'Unblocks launch', next_step: 'Review',
          trade_off: 'Defers polish', assessed_at: null, evidence: [], assessment: null, override: null
        }]
      }]
    }))

    await store.attach(Object.assign(gateway, { listNeedsMePriorities }), ['cmo'])

    expect(listNeedsMePriorities).toHaveBeenCalledWith('cmo', undefined, 'topic')
    expect(store.getSnapshot().items[0]?.priority).toMatchObject({
      work_id: 'stable-id', topicName: 'Launch', topicCollection: 'Growth',
      group: { kind: 'topic', id: 'topic-1', profile: 'cmo', backend_namespace: 'test' },
      groupOrder: 0, itemOrder: 0, why_here: 'Unblocks launch'
    })
  })

  it('preserves the authoritative project handoff identity instead of the wrapper group id', async () => {
    const { gateway, store } = setup()

    const listNeedsMePriorities = vi.fn(async () => ({
      profile: 'cmo', backend_namespace: 'desktop:production', sort: 'recommended' as const,
      policy_version: 'v1', review_id: null, group_by: 'project' as const, as_of: '2026-09-01T00:00:00Z',
      coverage: { work: 'complete', organization: 'complete', authorization_filtered: true },
      groups: [{
        id: 'project-wrapper:not-a-route', eligibility: 'assessed' as const, eligible_action_count: 1, why_here: 'Project decision',
        group: { kind: 'project' as const, id: 'canonical-project-42', source_id: 'desktop-project-7', namespace: { backend_id: 'desktop:exact', profile: 'project-owner' }, name: 'Autumn', collection: null, objective: null },
        items: [{ profile: 'cmo', work_id: 'stable-id', candidate_id: 'candidate-1', eligibility: 'assessed' as const, why_here: 'Review', next_step: 'Decide', trade_off: 'Wait', assessed_at: null, evidence: [], assessment: null, override: null }]
      }]
    }))

    await store.attach(Object.assign(gateway, { listNeedsMePriorities }), ['cmo'])

    expect(store.getSnapshot().items[0]?.priority?.group).toEqual({
      kind: 'project', id: 'canonical-project-42', source_id: 'desktop-project-7', profile: 'project-owner', backend_namespace: 'desktop:exact'
    })
  })
  it('uses the exact owner mutation contract and defers reordered rows until detail closes', async () => {
    const { gateway, store } = setup()
    const second = { ...card, id: 'second-id', source_key: 'campaign:2', title: 'Second campaign' }
    vi.mocked(gateway.listWork).mockResolvedValue({ items: [card, second] })
    vi.mocked(gateway.getWork).mockResolvedValue({ item: card, comments: [], decisions: [], tracker_status_history: [] })
    let order = ['stable-id', 'second-id']
    let overrideVersion = 1

    const priority = (workId: string, itemOrder: number) => ({
      profile: 'cmo', work_id: workId, candidate_id: `candidate:${workId}`, eligibility: 'assessed' as const,
      why_here: 'Expected value', next_step: 'Review', trade_off: 'Defers other work', assessed_at: null,
      evidence: [], assessment: null, override: workId === 'stable-id'
        ? { id: 'override-1', version: overrideVersion, mode: 'set_priority' as const, label: 'Now', actor: 'owner:server', reason: 'Deadline', expires_at: null, review_id: null, review_at: null, active: true }
        : null,
      itemOrder
    })

    const listNeedsMePriorities = vi.fn(async () => ({ profile: 'cmo', backend_namespace: 'test', sort: 'recommended' as const, policy_version: 'policy-v1', review_id: null, group_by: 'topic' as const, as_of: '2026-09-01T00:00:00Z', coverage: { work: 'complete', organization: 'complete', authorization_filtered: true }, groups: [{ id: 'topic-1', eligibility: 'assessed' as const, eligible_action_count: 2, why_here: 'Highest value', group: { kind: 'topic' as const, id: 'topic-1', name: 'Launch', collection: null, objective: null }, items: order.map(priority) }] }))
    const organizationCapabilities = vi.fn(async () => ({ version: 2, operations: ['needs_me'], read_only: false, sort: 'recommended' as const, policy_version: 'policy-v1', mutation_methods: ['companion.priorities.override_set', 'companion.priorities.restore_recommended'], record_mutation_methods: [], owner_authorization: true, optimistic_concurrency: 'expected_version' as const, idempotency: 'actor_scoped_key' as const, audit: true }))

    const setPriorityOverride = vi.fn(async (params) => { order = ['second-id', 'stable-id']; overrideVersion = 2

 return { record: { ...params, actor: 'owner:server', version: 2, created_at: '2026-09-08T00:00:00Z', created_by: 'owner:server', updated_at: '2026-09-08T00:00:00Z', updated_by: 'owner:server', canonical_id: 'priority_override:override-1' }, idempotent: false } })

    const restoreRecommendedPriority = vi.fn(async (params) => ({ record: { id: params.id, target_id: 'candidate:stable-id', mode: 'set_priority' as const, label: 'Now', actor: 'owner:server', reason: 'Deadline', expires_at: null, review_id: null, review_at: null, version: 3, created_at: null, created_by: null, updated_at: null, updated_by: null, canonical_id: 'priority_override:override-1' }, restored: true as const, idempotent: false }))
    await store.attach(Object.assign(gateway, { organizationCapabilities, listNeedsMePriorities, setPriorityOverride, restoreRecommendedPriority }), ['cmo'], true)
    await store.open('cmo', 'stable-id')
    expect(store.getSnapshot().priorityWritable).toBe(true)
    expect(await store.setPriority({ label: 'Do first', reason: 'Material deadline', expiresAt: '2099-01-01T00:00:00Z' })).toBe(true)
    expect(setPriorityOverride).toHaveBeenCalledWith({ profile: 'cmo', id: 'override-1', target_id: 'candidate:stable-id', mode: 'set_priority', label: 'Do first', reason: 'Material deadline', expires_at: '2099-01-01T00:00:00Z', review_id: null, review_at: null, expected_version: 1, idempotency_key: expect.any(String) })
    expect(setPriorityOverride.mock.calls[0]?.[0]).not.toHaveProperty('actor')
    expect(Object.fromEntries(store.getSnapshot().items.map((item) => [item.id, item.priority?.itemOrder]))).toEqual({ 'stable-id': 0, 'second-id': 1 })
    store.close()
    expect(Object.fromEntries(store.getSnapshot().items.map((item) => [item.id, item.priority?.itemOrder]))).toEqual({ 'stable-id': 1, 'second-id': 0 })
    await store.open('cmo', 'stable-id')
    expect(await store.restoreRecommended()).toBe(true)
    expect(restoreRecommendedPriority).toHaveBeenCalledWith({ profile: 'cmo', id: 'override-1', expected_version: 2, idempotency_key: expect.any(String) })
  })
  it('keeps priority mutations disabled without owner mode even when methods exist', async () => {
    const { gateway, store } = setup()
    const organizationCapabilities = vi.fn()
    await store.attach(Object.assign(gateway, { organizationCapabilities }), ['cmo'], false)
    expect(store.getSnapshot().priorityWritable).toBe(false)
    expect(organizationCapabilities).not.toHaveBeenCalled()
  })
  it('reconnect refreshes selection by stable profile and id', async () => {
    const { gateway, store, revise } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id'); store.disconnect(); revise()
    await store.attach(gateway, ['cmo'])
    expect(store.getSnapshot().selected?.revision).toBe(3)
    expect(gateway.getWork).toHaveBeenLastCalledWith('cmo', 'stable-id')
  })
})
