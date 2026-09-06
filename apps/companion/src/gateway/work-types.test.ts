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
})
