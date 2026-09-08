import type { OrganizationGateway } from '../../gateway/organization-types'
import type { WorkCapability, WorkCard, WorkDetail, WorkGateway } from '../../gateway/work-types'

import type { WorkCardView, WorkDecisionInput, WorkInboxProps, WorkPriorityInput } from './work-inbox'

export interface WorkSnapshot {
  items: readonly WorkCardView[]
  selected: WorkCardView | null
  status: WorkInboxProps['status']
  pending: boolean
  message: string | null
  groupBy: 'topic' | 'session' | 'project'
  priorityWritable: boolean
  sources: readonly WorkSourceState[]
}
export interface WorkSourceState { profile: string; incomplete: boolean; status: 'verified' | 'unsupported' | 'error'; lastSuccess: string | null; message: string | null }
export interface WorkStore {
  getSnapshot(): WorkSnapshot
  subscribe(listener: () => void): () => void
  attach(gateway: Partial<WorkGateway & OrganizationGateway>, profiles: string[], ownerAuthorized?: boolean): Promise<void>
  disconnect(): void
  reset(): void
  refresh(): Promise<void>
  setGroupBy(groupBy: 'topic' | 'session' | 'project'): Promise<void>
  open(profile: string, id: string): Promise<void>
  close(): void
  decide(input: WorkDecisionInput): Promise<boolean>
  comment(text: string): Promise<boolean>
  setPriority(input: WorkPriorityInput): Promise<boolean>
  restoreRecommended(): Promise<boolean>
}
const key = (profile: string, id: string) => JSON.stringify([profile, id])
type PriorityView = NonNullable<WorkCardView['priority']>

function errorCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : undefined
}

function view(card: WorkCard, capability: WorkCapability | undefined, detail?: WorkDetail, priority?: WorkCardView['priority']): WorkCardView {
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
      approved_task_linking_pending: 'Preparation approved — awaiting execution tracker task link',
      linked_awaiting_triage: 'Linked to execution tracker — awaiting triage',
      preparing: 'Preparation in progress — verified from the execution tracker',
      prepared: 'Preparation completed — publication still not authorized',
      blocked: 'Preparation blocked — review tracker evidence',
      status_unavailable: 'Execution tracker status unavailable — handoff reconciliation required'
    }[card.preparation_status],
    ...(card.execution_link ? { executionAcknowledgedAt: card.execution_link.acknowledged_at } : {}),
    ...(card.tracker_evidence ? { trackerEvidence: card.tracker_evidence } : {}),
    ...(card.completion_evidence ? { completionEvidence: Array.isArray(card.completion_evidence) ? card.completion_evidence : [card.completion_evidence] } : {}),
    previews: card.execution_link ? [{ label: card.execution_link.execution_ref, url: card.execution_link.execution_ref }]
      : card.execution_ref ? [{ label: `Proposed tracker reference: ${card.execution_ref}`, url: card.execution_ref }] : [],
    decisionHistory: detail?.decisions.map((entry) => ({ id: entry.id, action: entry.action, revision: entry.revision, actor: entry.actor, reason: entry.reason, createdAt: entry.created_at, scope: entry.scope, snoozedUntil: entry.snoozed_until })) ?? [],
    discussion: detail?.comments.map((comment) => ({ id: comment.id, author: `${comment.actor} · Revision ${comment.revision} · ${comment.created_at}`, body: comment.text })) ?? [],
    trackerStatusHistory: detail?.tracker_status_history ?? [],
    ...(!capability?.can_decide ? { readOnlyReason: capability?.reason || 'Human-authenticated dashboard login is required for business decisions.' } : {}),
    ...(priority ? { priority } : {}),
    actionable: capability?.can_decide === true && card.state === 'needs_me' && card.attention_due && !snoozed
  }
}

/** In-memory verified projection only. Server owns all business state. */
export function createWorkStore(): WorkStore {
  let snapshot: WorkSnapshot = { items: [], selected: null, status: 'loading', pending: false, message: null, groupBy: 'topic', priorityWritable: false, sources: [] }
  const listeners = new Set<() => void>()
  let gateway: (WorkGateway & Partial<OrganizationGateway>) | null = null
  let profiles: string[] = []
  let epoch = 0
  let cards = new Map<string, WorkCard>()
  let priorities = new Map<string, PriorityView>()
  let latestPriorities = new Map<string, PriorityView>()
  let capabilities = new Map<string, WorkCapability>()
  let priorityWritable = false
  let detail: WorkDetail | null = null
  let selection: { profile: string; id: string } | null = null
  let sourceStates = new Map<string, WorkSourceState>()

  const publish = (change: Partial<WorkSnapshot>) => {
    snapshot = { ...snapshot, ...change }

    for (const listener of listeners) {listener()}
  }

  const projection = () => ({
    items: [...cards.values()].map((card) => view(card, capabilities.get(card.profile), undefined, priorities.get(key(card.profile, card.id)))),
    selected: detail ? view(detail.item, capabilities.get(detail.item.profile), detail, priorities.get(key(detail.item.profile, detail.item.id))) : null
  })

  const purgeUnauthorized = () => {
    ++epoch; gateway = null; profiles = []
    cards.clear(); priorities.clear(); latestPriorities.clear(); capabilities.clear(); sourceStates.clear()
    priorityWritable = false
    detail = null; selection = null
    publish({ items: [], selected: null, status: 'error', pending: false, priorityWritable: false, sources: [], message: 'This connection is not authorized to access work. Reconnect with a human-authenticated dashboard login.' })
  }

  const refresh = async (afterMutation = false): Promise<void> => {
    if (!gateway || (snapshot.pending && !afterMutation)) {return}
    const client = gateway
    const generation = ++epoch
    publish({ status: 'loading' })

    const responses = await Promise.all(profiles.map(async (profile) => {
      try {
        // Capability is the compatibility gate: do not issue newer Work or
        // organization calls to a gateway that does not support durable Work.
        const capability = await client.workCapabilities(profile)

        const [list, recommended] = await Promise.all([
          client.listWork(profile),
          client.listNeedsMePriorities?.(profile, undefined, snapshot.groupBy).catch((error) => {
            if (errorCode(error) === -32601) {return null}
            throw error
          }) ?? Promise.resolve(null)
        ])

        return { ok: true as const, profile, capability, list, recommended }
      } catch (error) {
        return { ok: false as const, profile, error }
      }
    }))

    if (generation !== epoch || gateway !== client) {return}
    const successful = responses.filter((response): response is Extract<(typeof responses)[number], { ok: true }> => response.ok)
    const failed = responses.filter((response): response is Extract<(typeof responses)[number], { ok: false }> => !response.ok)
    const refreshedAt = new Date().toISOString()

    if (failed.some(({ error }) => errorCode(error) === 4403)) {
      purgeUnauthorized()

      return
    }

    for (const response of successful) {
      for (const existingKey of [...cards.keys()]) {
        if (JSON.parse(existingKey)[0] === response.profile) {cards.delete(existingKey)}
      }

      for (const existingKey of [...latestPriorities.keys()]) {
        if (JSON.parse(existingKey)[0] === response.profile) {latestPriorities.delete(existingKey)}
      }

      const incoming = new Map<string, PriorityView>()

      for (const card of response.list.items) {cards.set(key(card.profile, card.id), card)}
      response.recommended?.groups.forEach((group, groupOrder) => group.items.forEach((item, itemOrder) => incoming.set(key(item.profile, item.work_id), { ...item, topicName: group.group.name, ...(group.group.collection ? { topicCollection: group.group.collection } : {}), groupOrder, itemOrder })))

      for (const [priorityKey, priority] of incoming) {latestPriorities.set(priorityKey, priority)}

      if (selection) {
        for (const existingKey of [...priorities.keys()]) {
          if (JSON.parse(existingKey)[0] === response.profile && !incoming.has(existingKey)) {priorities.delete(existingKey)}
        }

        for (const [priorityKey, priority] of incoming) {
          const displayed = priorities.get(priorityKey)
          priorities.set(priorityKey, displayed ? {
            ...priority,
            groupOrder: displayed.groupOrder,
            itemOrder: displayed.itemOrder
          } : priority)
        }
      } else {
        for (const existingKey of [...priorities.keys()]) {
          if (JSON.parse(existingKey)[0] === response.profile) {priorities.delete(existingKey)}
        }

        for (const [priorityKey, priority] of incoming) {priorities.set(priorityKey, priority)}
      }

      capabilities.set(response.profile, response.capability)
      sourceStates.set(response.profile, { profile: response.profile, incomplete: false, status: 'verified', lastSuccess: refreshedAt, message: null })
    }

    for (const response of failed) {
      const unsupported = errorCode(response.error) === -32601
      sourceStates.set(response.profile, { profile: response.profile, incomplete: true, status: unsupported ? 'unsupported' : 'error', lastSuccess: sourceStates.get(response.profile)?.lastSuccess ?? null, message: unsupported ? 'Durable Work is unsupported by this source.' : errorCode(response.error) === 4403 ? 'This source is not authorized.' : 'Refresh failed; the last verified view is retained.' })
    }

    try {
      detail = selection && successful.some(({ profile }) => profile === selection?.profile) ? await client.getWork(selection.profile, selection.id) : detail
    } catch (error) {
      if (errorCode(error) === 4403) {
        purgeUnauthorized()

        return
      }
      // Keep the last verified detail; source coverage already communicates an incomplete refresh.
    }

    if (generation !== epoch || gateway !== client) {return}

    if (detail) {cards.set(key(detail.item.profile, detail.item.id), detail.item)}
    const reasons = [...new Set(successful.filter(({ capability }) => !capability.can_decide).map(({ capability }) => capability.reason || 'Human-authenticated dashboard login is required for business decisions.'))]
    const status = successful.length ? 'verified' : failed.every(({ error }) => errorCode(error) === -32601) ? 'unsupported' : 'error'
    publish({ ...projection(), status, priorityWritable, sources: profiles.map((profile) => sourceStates.get(profile)!).filter(Boolean), message: reasons.join(' ') || null })
  }

  const mutatePriority = async (input?: WorkPriorityInput): Promise<boolean> => {
    const client = gateway
    const current = detail?.item
    const currentPriority = current && priorities.get(key(current.profile, current.id))
    const existing = currentPriority?.override

    if (!client || !current || !currentPriority || !priorityWritable || snapshot.status !== 'verified' || snapshot.pending
      || !client.setPriorityOverride || !client.restoreRecommendedPriority) {return false}

    if (input && (!input.label.trim() || !input.reason.trim() || !input.expiresAt)) {return false}

    if (!input && (!existing?.active || !existing.version)) {return false}

    const generation = ++epoch
    publish({ pending: true, message: null })

    try {
      const result = input
        ? await client.setPriorityOverride({
            profile: current.profile,
            id: existing?.id ?? crypto.randomUUID(),
            target_id: currentPriority.candidate_id,
            mode: 'set_priority',
            label: input.label.trim(),
            reason: input.reason.trim(),
            expires_at: input.expiresAt,
            review_id: null,
            review_at: null,
            expected_version: existing?.version ?? 0,
            idempotency_key: crypto.randomUUID()
          })
        : await client.restoreRecommendedPriority({ profile: current.profile, id: existing!.id, expected_version: existing!.version!, idempotency_key: crypto.randomUUID() })

      if (generation !== epoch || gateway !== client) {return false}
      const priorityKey = key(current.profile, current.id)
      const displayed = priorities.get(priorityKey)

      if (displayed) {
        priorities.set(priorityKey, {
          ...displayed,
          override: {
            id: result.record.id, version: result.record.version, mode: result.record.mode,
            label: result.record.label, actor: result.record.actor, reason: result.record.reason,
            expires_at: result.record.expires_at, review_id: result.record.review_id,
            review_at: result.record.review_at, active: Boolean(input)
          }
        })
      }

      await refresh(true)

      if (gateway !== client) {return false}
      publish({ pending: false })

      if (snapshot.status !== 'verified') {return false}
      publish({ message: input ? 'Priority saved and verified from the server.' : 'Recommended priority restored and verified from the server.' })

      return true
    } catch (error) {
      if (generation !== epoch || gateway !== client) {return false}
      publish({ pending: false })

      if (errorCode(error) === 4403) {purgeUnauthorized()} else if (errorCode(error) === 4090) {
        await refresh()
        publish({ message: 'This priority changed. The latest verified version was loaded; nothing was automatically retried.' })
      } else {
        publish({ status: 'error', message: 'Priority save could not be verified. Refresh before trying again; it may already have reached the server.' })
      }

      return false
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
      } else if (errorCode(error) === 4403) {
        purgeUnauthorized()
      } else {
        publish({ message: 'Save could not be verified. Refresh before trying again; it may already have reached the server.' })
      }

      return false
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {listeners.add(listener);

 return () => {listeners.delete(listener)}},
    async attach(candidate, nextProfiles, ownerAuthorized = false) {
      ++epoch
      profiles = [...new Set(nextProfiles)]

      if (!candidate.workCapabilities || !candidate.listWork || !candidate.getWork || !candidate.decideWork || !candidate.commentWork) {
        gateway = null
        publish({ status: 'unsupported', pending: false, message: null })

        return
      }

      gateway = candidate as WorkGateway & Partial<OrganizationGateway>
      priorityWritable = false

      if (ownerAuthorized && candidate.organizationCapabilities && candidate.setPriorityOverride && candidate.restoreRecommendedPriority) {
        try {
          const capability = await candidate.organizationCapabilities()
          priorityWritable = capability.owner_authorization && !capability.read_only
            && capability.mutation_methods.includes('companion.priorities.override_set')
            && capability.mutation_methods.includes('companion.priorities.restore_recommended')
        } catch { priorityWritable = false }
      }

      publish({ pending: false, priorityWritable })
      await refresh()
    },
    disconnect() {++epoch; gateway = null; publish({ status: 'offline', pending: false })},
    reset() {++epoch; gateway = null; cards.clear(); priorities.clear(); latestPriorities.clear(); capabilities.clear(); sourceStates.clear(); priorityWritable = false; detail = null; selection = null; publish({ items: [], selected: null, status: 'loading', pending: false, message: null, groupBy: 'topic', priorityWritable: false, sources: [] })},
    refresh,
    async setGroupBy(groupBy) {
      if (snapshot.groupBy === groupBy || snapshot.pending) {return}
      priorities.clear()
      publish({ groupBy, selected: null })
      selection = null
      detail = null
      await refresh()
    },
    async open(profile, id) {
      if (snapshot.pending || !profiles.includes(profile)) {return}
      selection = { profile, id }
      detail = null
      publish({ selected: null })
      await refresh()
    },
    close() {if (snapshot.pending) {return}; selection = null; detail = null; ++epoch; priorities = new Map(latestPriorities); publish({ ...projection(), selected: null }); void refresh()},
    decide: (input) => mutate(input),
    comment: (text) => mutate({ text }),
    setPriority: (input) => mutatePriority(input),
    restoreRecommended: () => mutatePriority()
  }
}
