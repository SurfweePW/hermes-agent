import { workCopy } from '../../copy/work'
import type { OrganizationGateway } from '../../gateway/organization-types'
import type { WorkCapability, WorkCard, WorkComment, WorkDecisionRecord, WorkDetail, WorkGateway } from '../../gateway/work-types'

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
export interface WorkStoreOptions {
  /** Signals that the owner session must be re-authorized. */
  onOwnerAuthorizationLost?: (error: unknown) => void
}
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

export function verifiedWorkProfiles(snapshot: Pick<WorkSnapshot, 'status' | 'sources'>): ReadonlySet<string> {
  if (snapshot.status !== 'verified') {return new Set()}

  return new Set(
    snapshot.sources
      .filter((source) => source.status === 'verified' && !source.incomplete)
      .map((source) => source.profile)
  )
}

const key = (profile: string, id: string) => JSON.stringify([profile, id])
const UNAUTHORIZED_SOURCE_MESSAGE = workCopy.presentation.unauthorizedSource
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type PriorityView = NonNullable<WorkCardView['priority']>

interface CanonicalAttentionItem {
  id: string
  profile: string
  actionable: boolean
  kind: 'approval' | 'question' | 'blocker' | 'completion' | 'error'
  work_ref?: { profile: string; id: string }
}

type CanonicalWorkItem = WorkCard | Pick<WorkCardView, 'id' | 'profile' | 'actionable' | 'bucket'> & {
  attentionKey?: string
  attentionDue?: boolean
  snoozedUntil?: string
}

function isDueWorkDecision(item: CanonicalWorkItem): boolean {
  return 'attention_due' in item
    ? item.state === 'needs_me' && item.attention_due
    : item.bucket === 'needs_me' && (item.attentionDue === true || !item.snoozedUntil)
}

/** Hide runtime entries only when the matching Work source is currently verified. */
export function distinctRuntimeAttention<T extends CanonicalAttentionItem>(
  work: readonly CanonicalWorkItem[],
  attention: readonly T[],
  verifiedProfiles: ReadonlySet<string>
): T[] {
  const workIdentities = new Set(
    work.filter((item) => verifiedProfiles.has(item.profile)).map((item) => key(item.profile, item.id))
  )

  return attention.filter((item) => !item.work_ref || !workIdentities.has(key(item.work_ref.profile, item.work_ref.id)))
}

/** One count for business decisions plus visible runtime attention. */
export function canonicalDecisionCount(
  work: readonly CanonicalWorkItem[],
  attention: readonly CanonicalAttentionItem[],
  verifiedProfiles: ReadonlySet<string>
): number {
  const identities = new Set<string>()

  for (const item of work) {
    if (!isDueWorkDecision(item)) {continue}
    identities.add(key(item.profile, item.id))
  }

  for (const item of distinctRuntimeAttention(work, attention, verifiedProfiles)) {
    if (!item.actionable || item.kind === 'completion' || item.kind === 'error') {continue}
    identities.add(item.work_ref ? key(item.work_ref.profile, item.work_ref.id) : key(item.profile, item.id))
  }

  return identities.size
}

function errorCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : undefined
}

function sameComment(left: WorkComment, right: WorkComment): boolean {
  return left.id === right.id && left.card_id === right.card_id && left.revision === right.revision && left.actor === right.actor
    && left.text === right.text && left.created_at === right.created_at
}

function sameDecision(left: WorkDecisionRecord, right: WorkDecisionRecord): boolean {
  return left.id === right.id && left.card_id === right.card_id && left.revision === right.revision && left.action === right.action
    && left.actor === right.actor && left.reason === right.reason && left.snoozed_until === right.snoozed_until
    && left.created_at === right.created_at && left.scope === right.scope
}

function view(card: WorkCard, capability: WorkCapability | undefined, detail?: WorkDetail, priority?: WorkCardView['priority']): WorkCardView {
  const snoozed = Boolean(card.snoozed_until && !card.attention_due)
  const decision = detail?.decisions.at(-1)

  return {
    id: card.id, profile: card.profile, title: card.title, brief: card.brief, revision: card.revision,
    status: card.state, bucket: card.state === 'done' || card.state === 'declined' || snoozed ? 'history' : card.state,
    evidence: card.evidence.map((label) => ({ label, url: label })),
    permitted: [workCopy.presentation.permitted],
    excluded: [workCopy.presentation.excluded],
    nextAction: card.next_action, owner: card.owner,
    recommendedAction: card.recommended_action,
    decision: decision ? `${decision.action}${decision.reason ? `: ${decision.reason}` : ''}` : card.approval ? workCopy.presentation.approvedForRevision(card.approval.revision) : '',
    ...(card.snoozed_until ? { snoozedUntil: card.snoozed_until } : {}),
    preparationStatus: workCopy.presentation.preparationStatus[card.preparation_status],
    ...(card.execution_link ? { executionAcknowledgedAt: card.execution_link.acknowledged_at } : {}),
    ...(card.tracker_evidence ? { trackerEvidence: card.tracker_evidence } : {}),
    ...(card.completion_evidence ? { completionEvidence: Array.isArray(card.completion_evidence) ? card.completion_evidence : [card.completion_evidence] } : {}),
    previews: card.execution_link ? [{ label: card.execution_link.execution_ref, url: card.execution_link.execution_ref }]
      : card.execution_ref ? [{ label: workCopy.presentation.proposedTrackerReference(card.execution_ref), url: card.execution_ref }] : [],
    attentionKey: card.attention_key,
    attentionDue: card.attention_due,
    ...(priority?.source_session ? { sourceSession: { backend: priority.source_session.namespace.backend_id, profile: priority.source_session.namespace.profile, id: priority.source_session.persisted_session_id } } : {}),
    decisionHistory: detail?.decisions.map((entry) => ({ id: entry.id, action: entry.action, revision: entry.revision, actor: entry.actor, reason: entry.reason, createdAt: entry.created_at, scope: entry.scope, snoozedUntil: entry.snoozed_until })) ?? [],
    discussion: detail?.comments.map((comment) => ({ id: comment.id, author: workCopy.presentation.discussionAuthor(comment.actor, comment.revision, comment.created_at), body: comment.text })) ?? [],
    trackerStatusHistory: detail?.tracker_status_history ?? [],
    ...(!capability?.can_decide ? { readOnlyReason: capability?.reason || workCopy.presentation.decisionLoginRequired } : {}),
    canDecide: capability?.can_decide === true,
    ...(priority ? { priority } : {}),
    actionable: capability?.can_decide === true && card.state === 'needs_me' && card.attention_due && !snoozed
  }
}

/** In-memory verified projection only. Server owns all business state. */
export function createWorkStore(options: WorkStoreOptions = {}): WorkStore {
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

  const ownerAuthorizationLost = (error: unknown) => {
    if (errorCode(error) !== 4401) {return false}
    options.onOwnerAuthorizationLost?.(error)

    return true
  }

  const markProfileUnauthorized = (profile: string) => {
    for (const cardKey of [...cards.keys()]) {
      if (JSON.parse(cardKey)[0] === profile) {cards.delete(cardKey)}
    }

    for (const priorityKey of [...priorities.keys()]) {
      if (JSON.parse(priorityKey)[0] === profile) {priorities.delete(priorityKey)}
    }

    for (const priorityKey of [...latestPriorities.keys()]) {
      if (JSON.parse(priorityKey)[0] === profile) {latestPriorities.delete(priorityKey)}
    }

    capabilities.delete(profile)

    if (selection?.profile === profile || detail?.item.profile === profile) {
      selection = null
      detail = null
    }

    sourceStates.set(profile, {
      profile,
      incomplete: true,
      status: 'error',
      lastSuccess: sourceStates.get(profile)?.lastSuccess ?? null,
      message: UNAUTHORIZED_SOURCE_MESSAGE
    })
  }

  const sourceProjection = () => profiles.map((profile) => sourceStates.get(profile)!).filter(Boolean)
  const aggregateStatus = (): WorkSnapshot['status'] => {
    const sources = sourceProjection()

    if (sources.some((source) => source.status === 'verified')) {return 'verified'}
    if (sources.length > 0 && sources.every((source) => source.status === 'unsupported')) {return 'unsupported'}

    return 'error'
  }

  const projection = () => ({
    items: [...cards.values()].map((card) => view(card, capabilities.get(card.profile), undefined, priorities.get(key(card.profile, card.id)))),
    selected: detail ? view(detail.item, capabilities.get(detail.item.profile), detail, priorities.get(key(detail.item.profile, detail.item.id))) : null
  })

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

    for (const response of successful) {
      for (const existingKey of [...cards.keys()]) {
        if (JSON.parse(existingKey)[0] === response.profile) {cards.delete(existingKey)}
      }

      for (const existingKey of [...latestPriorities.keys()]) {
        if (JSON.parse(existingKey)[0] === response.profile) {latestPriorities.delete(existingKey)}
      }

      const incoming = new Map<string, PriorityView>()

      for (const card of response.list.items) {cards.set(key(card.profile, card.id), card)}
      response.recommended?.groups.forEach((group, groupOrder) => group.items.forEach((item, itemOrder) => incoming.set(key(item.profile, item.work_id), {
        ...item,
        topicName: group.group.name,
        ...(group.group.collection ? { topicCollection: group.group.collection } : {}),
        group: {
          kind: group.group.kind,
          id: group.group.id,
          ...(group.group.kind === 'project' && group.group.source_id && group.group.namespace
            ? { source_id: group.group.source_id, profile: group.group.namespace.profile, backend_namespace: group.group.namespace.backend_id }
            : { profile: response.recommended!.profile, backend_namespace: response.recommended!.backend_namespace })
        },
        groupOrder,
        itemOrder
      })))

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
      ownerAuthorizationLost(response.error)
      const code = errorCode(response.error)

      if (code === 4403) {
        markProfileUnauthorized(response.profile)
      } else {
        const unsupported = code === -32601
        sourceStates.set(response.profile, { profile: response.profile, incomplete: true, status: unsupported ? 'unsupported' : 'error', lastSuccess: sourceStates.get(response.profile)?.lastSuccess ?? null, message: unsupported ? workCopy.presentation.unsupportedSource : workCopy.presentation.refreshFailed })
      }
    }

    try {
      detail = selection && successful.some(({ profile }) => profile === selection?.profile) ? await client.getWork(selection.profile, selection.id) : detail
    } catch (error) {
      ownerAuthorizationLost(error)

      if (selection && errorCode(error) === 4403) {
        markProfileUnauthorized(selection.profile)
      }
      // Keep the last verified detail for non-authorization failures; source
      // coverage already communicates an incomplete refresh.
    }

    if (generation !== epoch || gateway !== client) {return}

    if (detail) {cards.set(key(detail.item.profile, detail.item.id), detail.item)}
    const reasons = [...new Set(successful
      .filter(({ profile, capability }) => sourceStates.get(profile)?.status === 'verified' && !capability.can_decide)
      .map(({ capability }) => capability.reason || workCopy.presentation.decisionLoginRequired))]
    publish({ ...projection(), status: aggregateStatus(), priorityWritable, sources: sourceProjection(), message: reasons.join(' ') || null })
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
      publish({ message: input ? workCopy.presentation.prioritySaved : workCopy.presentation.recommendedPriorityRestored })

      return true
    } catch (error) {
      if (generation !== epoch || gateway !== client) {return false}
      ownerAuthorizationLost(error)
      publish({ pending: false })

      if (errorCode(error) === 4403) {
        markProfileUnauthorized(current.profile)
        publish({ ...projection(), status: aggregateStatus(), sources: sourceProjection(), message: UNAUTHORIZED_SOURCE_MESSAGE })
      } else if (errorCode(error) === 4090) {
        await refresh()
        publish({ message: workCopy.presentation.priorityChanged })
      } else {
        publish({ status: 'error', message: workCopy.presentation.prioritySaveUnverified })
      }

      return false
    }
  }

  const mutate = async (input: WorkDecisionInput | { text: string }): Promise<boolean> => {
    const client = gateway
    const current = detail?.item

    if (!client || !current || snapshot.status !== 'verified' || snapshot.pending) {return false}

    const capability = capabilities.get(current.profile)

    if (capability?.can_decide !== true) {return false}

    if ('action' in input && !view(current, capability).actionable) {return false}

    if ('text' in input && !input.text.trim()) {return false}

    if ('action' in input && input.action === 'request_changes' && !input.comment?.trim()) {return false}
    const generation = ++epoch
    const idempotency_key = crypto.randomUUID()
    publish({ pending: true, message: null })

    try {
      let confirmed: boolean

      if ('text' in input) {
        const submittedText = input.text.trim()
        const { comment } = await client.commentWork({ profile: current.profile, id: current.id, text: submittedText, idempotency_key })

        if (!uuid.test(comment.id) || comment.id === idempotency_key || comment.revision !== current.revision || comment.text !== submittedText) {confirmed = false} else {
          if (generation !== epoch || gateway !== client) {return false}
          await refresh(true)
          confirmed = detail?.comments.some((entry) => sameComment(entry, comment)) === true
        }
      } else {
        const action = input.action === 'remind_in_2_hours' ? 'snooze' : input.action
        const reason = input.comment ?? ''
        const snoozedUntil = input.action === 'remind_in_2_hours' ? new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString() : null
        const { decision } = await client.decideWork({ profile: current.profile, id: current.id, expected_version: current.version, revision: current.revision, action, idempotency_key,
          ...(input.comment ? { reason: input.comment } : {}), ...(snoozedUntil ? { snoozed_until: snoozedUntil } : {}) })

        if (!uuid.test(decision.id) || decision.id === idempotency_key || decision.revision !== current.revision || decision.action !== action || decision.reason !== reason || decision.snoozed_until !== snoozedUntil) {confirmed = false} else {
          if (generation !== epoch || gateway !== client) {return false}
          await refresh(true)
          confirmed = detail?.decisions.some((entry) => sameDecision(entry, decision)) === true
        }
      }

      if (gateway !== client) {return false}
      publish({ pending: false })

      if (snapshot.status !== 'verified') {return false}

      if (!confirmed) {
        publish({ message: workCopy.presentation.exactRecordUnconfirmed })

        return false
      }

      publish({ message: workCopy.presentation.saved })

      return true
    } catch (error) {
      if (generation !== epoch || gateway !== client) {return false}
      ownerAuthorizationLost(error)
      publish({ pending: false })

      if (errorCode(error) === 4409) {
        publish({ status: 'error' })
        await refresh()
        publish({ message: workCopy.presentation.decisionChanged })
      } else if (errorCode(error) === 4403) {
        markProfileUnauthorized(current.profile)
        publish({ ...projection(), status: aggregateStatus(), sources: sourceProjection(), message: UNAUTHORIZED_SOURCE_MESSAGE })
      } else {
        publish({ status: 'error', message: workCopy.presentation.saveUnverified })
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
        } catch (error) {
          ownerAuthorizationLost(error)
          priorityWritable = false
        }
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
