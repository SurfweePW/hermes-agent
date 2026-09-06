import { describe, expect, it } from 'vitest'

import { FakeWorkGateway } from '../fixtures/fake-work-gateway'

import { validateWorkCapability, validateWorkCard, validateWorkDetail, validateWorkList } from './work-types'

describe('durable work contract validation', () => {
  it('validates explicit synthetic QA cards including preparation dispatch state', async () => {
    const gateway = new FakeWorkGateway()
    const list = validateWorkList(await gateway.listWork('atlas'), 'atlas')
    expect(list.items).toHaveLength(5)

    for (const item of list.items) {
      expect(validateWorkDetail(await gateway.getWork('atlas', item.id), 'atlas', item.id).item).toEqual(item)
      expect(item.title).toContain('[SYNTHETIC QA]')
    }
  })
  it('fails closed for older incomplete contracts, malformed handoffs and foreign identities', async () => {
    const { item } = await new FakeWorkGateway().getWork('atlas', 'fixture-review')

    for (const change of [{ preparation_status: undefined }, { preparation_status: 'running' }, { execution_link: { execution_ref: 'x' } }, { handoff_key: 5 }, { profile: 'other' }, { approval: { scope: 'publish' } }]) {
      expect(() => validateWorkCard({ ...item, ...change }, 'atlas')).toThrow('Malformed durable work response')
    }

    expect(() => validateWorkList({ items: [item, item] }, 'atlas')).toThrow()
    expect(() => validateWorkDetail({ item, comments: [], decisions: [] }, 'atlas', 'wrong-id')).toThrow()
    expect(() => validateWorkCapability({ can_decide: 'true', reason: null })).toThrow()
  })
  it('preserves current, completion and historical tracker evidence', async () => {
    const { item } = await new FakeWorkGateway().getWork('atlas', 'fixture-review')
    const blocked = { state: 'blocked', execution_ref: 'https://tracker.example/task/1', observed_at: '2026-09-06T10:00:00Z', evidence: ['https://tracker.example/event/1'], blocker: 'Waiting for legal review' }
    const prepared = { state: 'prepared', execution_ref: 'https://tracker.example/task/1', observed_at: '2026-09-06T11:00:00Z', evidence: ['https://tracker.example/event/2'], result_evidence: ['https://example.org/result'] }
    const result = validateWorkDetail({ item: { ...item, tracker_evidence: prepared, completion_evidence: ['https://example.org/final'] }, comments: [], decisions: [], tracker_status_history: [blocked, prepared] }, 'atlas', item.id)

    expect(result.item.tracker_evidence).toEqual(prepared)
    expect(result.item.completion_evidence).toEqual(['https://example.org/final'])
    expect(result.tracker_status_history).toEqual([blocked, prepared])
    expect(() => validateWorkDetail({ item, comments: [], decisions: [], tracker_status_history: [{ ...blocked, observed_at: 42 }] }, 'atlas', item.id)).toThrow()
  })
})
