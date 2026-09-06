import type { WorkCapability, WorkCard, WorkDetail, WorkGateway } from '../../gateway/work-types'

import type { WorkCardView, WorkDecisionInput, WorkInboxProps } from './work-inbox'

export interface WorkSnapshot {
  items: readonly WorkCardView[]
  selected: WorkCardView | null
  status: WorkInboxProps['status']
  pending: boolean
  message: string | null
}
export interface WorkStore {
  getSnapshot(): WorkSnapshot
  subscribe(listener: () => void): () => void
  attach(gateway: Partial<WorkGateway>, profiles: string[]): Promise<void>
  disconnect(): void
  reset(): void
  refresh(): Promise<void>
  open(profile: string, id: string): Promise<void>
  close(): void
  decide(input: WorkDecisionInput): Promise<boolean>
  comment(text: string): Promise<boolean>
}
const key = (profile: string, id: string) => JSON.stringify([profile, id])

function errorCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : undefined
}

function view(card: WorkCard, capability: WorkCapability | undefined, detail?: WorkDetail): WorkCardView {
  const snoozed = Boolean(card.snoozed_until && !card.attention_due)
  const decision = detail?.decisions.at(-1)

  return {
    id: card.id, profile: card.profile, title: card.title, brief: card.brief, revision: card.revision,
    status: card.state, bucket: card.state === 'done' || card.state === 'declined' || snoozed ? 'history' : card.state,
    evidence: card.evidence.map((label) => ({ label, url: label })),
    permitted: ['Prepare only the work described in this revision’s brief.'],
    excluded: ['Publishing, paid activation, live store changes, sending, spending and other external writes require separate authorization.'],
    nextAction: card.next_action, owner: card.owner,
    decision: decision ? `${decision.action}${decision.reason ? `: ${decision.reason}` : ''}` : card.approval ? `Preparation approved for revision ${card.approval.revision}` : '',
    ...(card.snoozed_until ? { snoozedUntil: card.snoozed_until } : {}),
    preparationStatus: {
      not_authorized: 'Preparation not authorized',
      dispatch_pending: 'Preparation approved — awaiting execution tracker handoff',
      linked: 'Linked to execution tracker — not proof of running or completion',
      completed: 'Preparation completed — publication still not authorized'
    }[card.preparation_status],
    ...(card.execution_link ? { executionAcknowledgedAt: card.execution_link.acknowledged_at } : {}),
    previews: card.execution_link ? [{ label: card.execution_link.execution_ref, url: card.execution_link.execution_ref }]
      : card.execution_ref ? [{ label: `Proposed tracker reference: ${card.execution_ref}`, url: card.execution_ref }] : [],
    decisionHistory: detail?.decisions.map((entry) => ({ id: entry.id, action: entry.action, revision: entry.revision, actor: entry.actor, reason: entry.reason, createdAt: entry.created_at, scope: entry.scope, snoozedUntil: entry.snoozed_until })) ?? [],
    discussion: detail?.comments.map((comment) => ({ id: comment.id, author: `${comment.actor} · Revision ${comment.revision} · ${comment.created_at}`, body: comment.text })) ?? [],
    ...(!capability?.can_decide ? { readOnlyReason: capability?.reason || 'Human-authenticated dashboard login is required for business decisions.' } : {}),
    actionable: capability?.can_decide === true && card.state === 'needs_me' && card.attention_due && !snoozed
  }
}

/** In-memory verified projection only. Server owns all business state. */
export function createWorkStore(): WorkStore {
  let snapshot: WorkSnapshot = { items: [], selected: null, status: 'loading', pending: false, message: null }
  const listeners = new Set<() => void>()
  let gateway: WorkGateway | null = null
  let profiles: string[] = []
  let epoch = 0
  let cards = new Map<string, WorkCard>()
  let capabilities = new Map<string, WorkCapability>()
  let detail: WorkDetail | null = null
  let selection: { profile: string; id: string } | null = null

  const publish = (change: Partial<WorkSnapshot>) => {
    snapshot = { ...snapshot, ...change }

    for (const listener of listeners) {listener()}
  }

  const projection = () => ({
    items: [...cards.values()].map((card) => view(card, capabilities.get(card.profile))),
    selected: detail ? view(detail.item, capabilities.get(detail.item.profile), detail) : null
  })

  const refresh = async (afterMutation = false): Promise<void> => {
    if (!gateway || (snapshot.pending && !afterMutation)) {return}
    const client = gateway
    const generation = ++epoch
    publish({ status: 'loading' })

    try {
      const responses = await Promise.all(profiles.map(async (profile) => ({ profile, capability: await client.workCapabilities(profile), list: await client.listWork(profile) })))
      const nextDetail = selection ? await client.getWork(selection.profile, selection.id) : null

      if (generation !== epoch || gateway !== client) {return}
      cards = new Map(responses.flatMap(({ list }) => list.items.map((card) => [key(card.profile, card.id), card] as const)))
      capabilities = new Map(responses.map(({ profile, capability }) => [profile, capability]))
      detail = nextDetail

      if (nextDetail) {cards.set(key(nextDetail.item.profile, nextDetail.item.id), nextDetail.item)}
      const reasons = [...new Set(responses.filter(({ capability }) => !capability.can_decide).map(({ capability }) => capability.reason || 'Human-authenticated dashboard login is required for business decisions.'))]
      publish({ ...projection(), status: 'verified', message: reasons.join(' ') || null })
    } catch (error) {
      if (generation !== epoch || gateway !== client) {return}
      publish({ status: errorCode(error) === -32601 ? 'unsupported' : 'error', message: errorCode(error) === 4403 ? 'This connection is not authorized to access work. Reconnect with an authorized login.' : 'Unable to refresh persisted work. No decision was enabled.' })
    }
  }

  const mutate = async (input: WorkDecisionInput | { text: string }): Promise<boolean> => {
    const client = gateway
    const current = detail?.item

    if (!client || !current || snapshot.status !== 'verified' || snapshot.pending) {return false}

    if ('action' in input && !view(current, capabilities.get(current.profile)).actionable) {return false}

    if ('text' in input && !input.text.trim()) {return false}

    if ('action' in input && input.action === 'request_changes' && !input.comment?.trim()) {return false}
    const generation = ++epoch
    const idempotency_key = crypto.randomUUID()
    publish({ pending: true, message: null })

    try {
      if ('text' in input) {
        await client.commentWork({ profile: current.profile, id: current.id, text: input.text.trim(), idempotency_key })
      } else {
        await client.decideWork({ profile: current.profile, id: current.id, expected_version: current.version, revision: current.revision, action: input.action, idempotency_key,
          ...(input.comment ? { reason: input.comment } : {}), ...(input.snoozedUntil ? { snoozed_until: input.snoozedUntil } : {}) })
      }

      if (generation !== epoch || gateway !== client) {return false}
      await refresh(true)

      if (gateway !== client) {return false}
      publish({ pending: false })

      if (snapshot.status !== 'verified') {return false}
      publish({ message: 'Saved and verified from the server.' })

      return true
    } catch (error) {
      if (generation !== epoch || gateway !== client) {return false}
      publish({ pending: false, status: 'error' })

      if (errorCode(error) === 4409) {
        await refresh()
        publish({ message: 'This card changed or the decision is no longer valid. The latest revision was requested; review it before deciding again. Nothing was automatically retried.' })
      } else {
        publish({ message: errorCode(error) === 4403 ? 'This login cannot make business decisions. Reconnect with a human-authenticated dashboard login and refresh.' : 'Save could not be verified. Refresh before trying again; it may already have reached the server.' })
      }

      return false
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {listeners.add(listener);

 return () => {listeners.delete(listener)}},
    async attach(candidate, nextProfiles) {
      ++epoch
      profiles = [...new Set(nextProfiles)]

      if (!candidate.workCapabilities || !candidate.listWork || !candidate.getWork || !candidate.decideWork || !candidate.commentWork) {
        gateway = null
        publish({ status: 'unsupported', pending: false, message: null })

        return
      }

      gateway = candidate as WorkGateway
      publish({ pending: false })
      await refresh()
    },
    disconnect() {++epoch; gateway = null; publish({ status: 'offline', pending: false })},
    reset() {++epoch; gateway = null; cards.clear(); capabilities.clear(); detail = null; selection = null; publish({ items: [], selected: null, status: 'loading', pending: false, message: null })},
    refresh,
    async open(profile, id) {
      if (snapshot.pending || !profiles.includes(profile)) {return}
      selection = { profile, id }
      detail = null
      publish({ selected: null })
      await refresh()
    },
    close() {if (snapshot.pending) {return}; selection = null; detail = null; ++epoch; publish({ selected: null }); void refresh()},
    decide: (input) => mutate(input),
    comment: (text) => mutate({ text })
  }
}
