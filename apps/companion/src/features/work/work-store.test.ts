import { describe, expect, it, vi } from 'vitest'

import type { WorkCard, WorkGateway } from '../../gateway/work-types'

import { createWorkStore } from './work-store'

const card: WorkCard = {
  id: 'stable-id', profile: 'cmo', source_key: 'campaign:1', state: 'needs_me', title: 'Campaign', brief: 'Prepare', evidence: ['https://example.org'], next_action: 'Review', owner: 'Pawel', revision: 2, version: 4, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', snoozed_until: null, attention_due: true, attention_key: 'key', approval: null, preparation_status: 'not_authorized', handoff_key: null, execution_link: null, tracker_evidence: null, completion_evidence: null
}

function setup(canDecide = true) {
  let current = { ...card }

  const gateway: WorkGateway = {
    workCapabilities: vi.fn(async () => ({ can_decide: canDecide, reason: canDecide ? null : 'Human dashboard login required' })),
    listWork: vi.fn(async () => ({ items: [current] })),
    getWork: vi.fn(async () => ({ item: current, comments: [], decisions: [], tracker_status_history: [] })),
    decideWork: vi.fn(async () => {current = { ...current, state: 'in_progress', version: 5 };

 return { item: current } }),
    commentWork: vi.fn(async () => ({ comment: {} }))
  }

  return { gateway, store: createWorkStore(), revise: () => {current = { ...current, revision: 3, version: 6 } } }
}

describe('verified work store', () => {
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
  it('locks all mutations on revoked authentication and explains the boundary', async () => {
    const { gateway, store } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    vi.mocked(gateway.decideWork).mockRejectedValue({ code: 4403 })
    expect(await store.decide({ action: 'approve_preparation' })).toBe(false)
    expect(store.getSnapshot().status).toBe('error')
    expect(store.getSnapshot()).toMatchObject({ items: [], selected: null, sources: [] })
    expect(JSON.stringify(store.getSnapshot())).not.toContain('Campaign')
    expect(JSON.stringify(store.getSnapshot())).not.toContain('https://example.org')
    expect(store.getSnapshot().message).toMatch(/human-authenticated/)
    expect(await store.comment('blocked')).toBe(false)
    expect(gateway.commentWork).not.toHaveBeenCalled()
  })

  it('purges retained work and detail when refresh reports owner revocation', async () => {
    const { gateway, store } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    vi.mocked(gateway.workCapabilities).mockRejectedValue({ code: 4403 })
    await store.refresh()

    expect(store.getSnapshot()).toMatchObject({ items: [], selected: null, status: 'error', sources: [] })
    expect(JSON.stringify(store.getSnapshot())).not.toContain('Campaign')
    expect(JSON.stringify(store.getSnapshot())).not.toContain('https://example.org')
  })

  it('uses authoritative profile/id/version/revision and reads back mutations', async () => {
    const { gateway, store } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    expect(await store.decide({ action: 'approve_preparation' })).toBe(true)
    expect(gateway.decideWork).toHaveBeenCalledWith({ profile: 'cmo', id: 'stable-id', expected_version: 4, revision: 2, action: 'approve_preparation', idempotency_key: expect.any(String) })
    expect(gateway.getWork).toHaveBeenLastCalledWith('cmo', 'stable-id')
    expect(store.getSnapshot().selected?.status).toBe('in_progress')
    await store.comment('Focused persisted discussion')
    expect(gateway.commentWork).toHaveBeenCalledWith({ profile: 'cmo', id: 'stable-id', text: 'Focused persisted discussion', idempotency_key: expect.any(String) })
  })
  it('respects the human capability boundary without falling back to tool approvals', async () => {
    const { gateway, store } = setup(false); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    expect(store.getSnapshot().message).toBe('Human dashboard login required')
    expect(store.getSnapshot().selected?.actionable).toBe(false)
    expect(await store.decide({ action: 'decline' })).toBe(false)
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
  it('keeps the exact mutation target locked until readback finishes', async () => {
    const { gateway, store } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    let finish!: () => void
    vi.mocked(gateway.getWork).mockImplementation(() => new Promise((resolve) => {finish = () => resolve({ item: { ...card, state: 'in_progress' }, comments: [], decisions: [], tracker_status_history: [] })}))
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
    expect(await store.decide({ action: 'decline' })).toBe(false)
    store.disconnect()
    expect(store.getSnapshot().status).toBe('offline')
    expect(await store.comment('Do not send')).toBe(false)
  })
  it('does not enable duplicate submissions or let late responses cross connections', async () => {
    const { gateway, store } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    let finish!: () => void
    vi.mocked(gateway.decideWork).mockImplementation(() => new Promise((resolve) => {finish = () => resolve({})}))
    const pending = store.decide({ action: 'approve_preparation' })
    expect(store.getSnapshot().pending).toBe(true)
    expect(await store.decide({ action: 'decline' })).toBe(false)
    store.disconnect(); finish(); await pending
    expect(store.getSnapshot().status).toBe('offline')
    expect(gateway.decideWork).toHaveBeenCalledTimes(1)
  })
  it('sends snooze and change reason exactly, with server revalidation', async () => {
    const { gateway, store } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id')
    await store.decide({ action: 'snooze', snoozedUntil: '2099-09-05T12:00:00Z', comment: 'Later' })
    expect(gateway.decideWork).toHaveBeenCalledWith(expect.objectContaining({ action: 'snooze', snoozed_until: '2099-09-05T12:00:00Z', reason: 'Later', profile: 'cmo', id: 'stable-id' }))
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
      groupOrder: 0, itemOrder: 0, why_here: 'Unblocks launch'
    })
  })
  it('reconnect refreshes selection by stable profile and id', async () => {
    const { gateway, store, revise } = setup(); await store.attach(gateway, ['cmo']); await store.open('cmo', 'stable-id'); store.disconnect(); revise()
    await store.attach(gateway, ['cmo'])
    expect(store.getSnapshot().selected?.revision).toBe(3)
    expect(gateway.getWork).toHaveBeenLastCalledWith('cmo', 'stable-id')
  })
})
