import type { WorkCard, WorkCommentParams, WorkDecisionParams, WorkDetail } from '../gateway/work-types'

import { FakeCompanionGateway } from './fake-gateway'

/** Synthetic visual QA only. Never selected by the real gateway or auth path. */
export class FakeWorkGateway extends FakeCompanionGateway {
  private work = new Map<string, WorkDetail>(['review', 'snoozed', 'pending', 'idea', 'closed'].map((id) => {
    const item: WorkCard = {
      id: `fixture-${id}`, profile: 'atlas', source_key: `synthetic:${id}`,
      title: `[SYNTHETIC QA] ${id === 'review' ? 'Prepare a sample campaign brief' : id === 'snoozed' ? 'Snoozed sample proposal' : id === 'pending' ? 'Approved sample awaiting tracker' : id === 'idea' ? 'Explore a sample idea' : 'Closed sample proposal'}`,
      brief: 'Fixture data only — no real customer, publication, spending or execution.\nReview a deliberately long sample brief on desktop and phone. Prepare two draft alternatives and compare the evidence before any separate external authorization.',
      state: id === 'pending' ? 'in_progress' : id === 'idea' ? 'ideas' : id === 'closed' ? 'declined' : 'needs_me',
      evidence: ['Synthetic evidence note; not a production source.', 'https://example.org/synthetic-research'],
      next_action: 'Review this synthetic revision', owner: 'Synthetic reviewer', revision: 2, version: 3,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
      snoozed_until: id === 'snoozed' ? '2099-12-01T12:00:00Z' : null,
      attention_due: id === 'review', attention_key: `synthetic:${id}:2`,
      approval: id === 'pending' ? { revision: 2, scope: 'preparation_only', decision_id: 'synthetic-approved' } : null,
      preparation_status: id === 'pending' ? 'dispatch_pending' : 'not_authorized', handoff_key: id === 'pending' ? 'synthetic-handoff' : null, execution_link: null
    }

    return [item.id, { item, comments: [{ id: `synthetic-comment-${id}`, card_id: item.id, revision: 1, actor: 'agent', text: 'Synthetic discussion: which audience should the draft address?', created_at: item.created_at }], decisions: [{ id: `synthetic-decision-${id}`, card_id: item.id, revision: 1, action: 'request_changes', actor: 'Synthetic human', reason: 'Synthetic earlier review: narrow the scope.', snoozed_until: null, created_at: item.created_at, scope: 'none' }] }]
  }))

  async workCapabilities(_profile: string) { return { can_decide: true, reason: 'SYNTHETIC QA ONLY — simulated human; no real authorization.' } }
  async listWork(profile: string) { return structuredClone({ items: [...this.work.values()].filter(({ item }) => item.profile === profile).map(({ item }) => item) }) }
  async getWork(profile: string, id: string) { return structuredClone(this.lookup(profile, id)) }
  async commentWork(params: WorkCommentParams) {
    const detail = this.lookup(params.profile, params.id)
    const comment = { id: params.idempotency_key, card_id: params.id, revision: detail.item.revision, actor: 'human' as const, text: params.text, created_at: new Date().toISOString() }
    detail.comments.push(comment)

    return structuredClone({ comment })
  }
  async decideWork(params: WorkDecisionParams) {
    const detail = this.lookup(params.profile, params.id)
    const item = detail.item

    if (item.version !== params.expected_version || item.revision !== params.revision || !item.attention_due) {throw { code: 4409 }}
    const decision = { id: params.idempotency_key, card_id: item.id, revision: item.revision, action: params.action, actor: 'Synthetic human', reason: params.reason ?? '', snoozed_until: params.snoozed_until ?? null, created_at: new Date().toISOString(), scope: params.action === 'approve_preparation' ? 'preparation_only' as const : 'none' as const }
    detail.decisions.push(decision)
    item.version += 1
    item.attention_due = false
    item.state = params.action === 'approve_preparation' ? 'in_progress' : params.action === 'decline' ? 'declined' : params.action === 'request_changes' ? 'ideas' : 'needs_me'
    item.snoozed_until = decision.snoozed_until

    if (params.action === 'approve_preparation') {
      item.approval = { revision: item.revision, scope: 'preparation_only', decision_id: decision.id }
      item.preparation_status = 'dispatch_pending'
      item.handoff_key = 'synthetic-handoff'
    }

    return structuredClone({ item, decision })
  }
  private lookup(profile: string, id: string): WorkDetail {
    const detail = this.work.get(id)

    if (!detail || detail.item.profile !== profile) {throw { code: 4404 }}

    return detail
  }
}
export const createFakeWorkGateway = () => new FakeWorkGateway()
