export type WorkState = 'ideas' | 'in_progress' | 'needs_me' | 'done' | 'declined'
export type PreparationStatus = 'not_authorized' | 'approved_task_linking_pending' | 'linked_awaiting_triage' | 'preparing' | 'prepared' | 'blocked' | 'status_unavailable'
export type WorkAction = 'approve_preparation' | 'request_changes' | 'snooze' | 'decline'
export interface TrackerEvidence {
  state: PreparationStatus
  execution_ref?: string
  observed_at: string
  evidence: string[]
  blocker?: string
  result_evidence?: string[]
}
export interface WorkCard {
  id: string; profile: string; source_key: string; state: WorkState
  title: string; brief: string; evidence: string[]; next_action: string; owner: string; execution_ref?: string
  revision: number; version: number; created_at: string; updated_at: string
  snoozed_until: string | null; attention_due: boolean; attention_key: string
  approval: null | { revision: number; scope: 'preparation_only'; decision_id: string }
  preparation_status: PreparationStatus
  handoff_key: string | null
  execution_link: null | { execution_ref: string; acknowledged_at: string; handoff_key: string }
  tracker_evidence: TrackerEvidence | null
  completion_evidence: string | string[] | null
}
export interface WorkComment { id: string; card_id: string; revision: number; actor: 'agent' | 'human'; text: string; created_at: string }
export interface WorkDecisionRecord { id: string; card_id: string; revision: number; action: WorkAction; actor: string; reason: string; snoozed_until: string | null; created_at: string; scope: 'preparation_only' | 'none' }
export interface WorkDetail { item: WorkCard; comments: WorkComment[]; decisions: WorkDecisionRecord[]; tracker_status_history: TrackerEvidence[] }
export interface WorkCapability { can_decide: boolean; reason: string | null }
export interface WorkDecisionParams { profile: string; id: string; expected_version: number; revision: number; action: WorkAction; idempotency_key: string; reason?: string; snoozed_until?: string }
export interface WorkCommentParams { profile: string; id: string; text: string; idempotency_key: string }
export interface WorkGateway {
  workCapabilities(profile: string): Promise<WorkCapability>
  listWork(profile: string): Promise<{ items: WorkCard[] }>
  getWork(profile: string, id: string): Promise<WorkDetail>
  decideWork(params: WorkDecisionParams): Promise<unknown>
  commentWork(params: WorkCommentParams): Promise<unknown>
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const fail = (): never => {throw new Error('Malformed durable work response.')}
const strings = (o: Record<string, unknown>, keys: string[]) => keys.every((key) => typeof o[key] === 'string')
const actions = ['approve_preparation', 'request_changes', 'snooze', 'decline']

const preparationStatuses: readonly PreparationStatus[] = ['not_authorized', 'approved_task_linking_pending', 'linked_awaiting_triage', 'preparing', 'prepared', 'blocked', 'status_unavailable']

function validateTrackerEvidence(value: unknown): TrackerEvidence {
  if (!record(value) || !preparationStatuses.includes(value.state as PreparationStatus)
    || typeof value.observed_at !== 'string' || !Array.isArray(value.evidence) || !value.evidence.every((entry) => typeof entry === 'string')
    || (value.execution_ref !== undefined && typeof value.execution_ref !== 'string')
    || (value.blocker !== undefined && typeof value.blocker !== 'string')
    || (value.result_evidence !== undefined && (!Array.isArray(value.result_evidence) || !value.result_evidence.every((entry) => typeof entry === 'string')))) {return fail()}

  return value as unknown as TrackerEvidence
}

export function validateWorkCard(value: unknown, profile: string): WorkCard {
  if (!record(value) || !strings(value, ['id', 'profile', 'source_key', 'title', 'brief', 'next_action', 'owner', 'created_at', 'updated_at', 'attention_key'])
    || value.profile !== profile || !value.id || !['ideas', 'in_progress', 'needs_me', 'done', 'declined'].includes(value.state as string)
    || !Number.isInteger(value.revision) || (value.revision as number) < 1 || !Number.isInteger(value.version) || (value.version as number) < 1
    || !Array.isArray(value.evidence) || !value.evidence.every((entry) => typeof entry === 'string')
    || typeof value.attention_due !== 'boolean' || !(value.snoozed_until === null || typeof value.snoozed_until === 'string')
    || (value.execution_ref !== undefined && typeof value.execution_ref !== 'string')) {return fail()}

  if (value.approval !== null && (!record(value.approval) || value.approval.scope !== 'preparation_only' || !Number.isInteger(value.approval.revision) || typeof value.approval.decision_id !== 'string')) {return fail()}

  if (!preparationStatuses.includes(value.preparation_status as PreparationStatus)
    || !(value.handoff_key === null || typeof value.handoff_key === 'string')
    || (value.execution_link !== null && (!record(value.execution_link) || !strings(value.execution_link, ['execution_ref', 'acknowledged_at', 'handoff_key'])))
    || !(value.tracker_evidence === null || record(value.tracker_evidence))
    || !(value.completion_evidence === null || typeof value.completion_evidence === 'string' || (Array.isArray(value.completion_evidence) && value.completion_evidence.every((entry) => typeof entry === 'string')))) {return fail()}

  if (value.tracker_evidence !== null) {validateTrackerEvidence(value.tracker_evidence)}

  return value as unknown as WorkCard
}

export function validateWorkList(value: unknown, profile: string): { items: WorkCard[] } {
  if (!record(value) || !Array.isArray(value.items)) {return fail()}
  const items = value.items.map((item) => validateWorkCard(item, profile))

  if (new Set(items.map((item) => item.id)).size !== items.length) {return fail()}

  return { items }
}

export function validateWorkDetail(value: unknown, profile: string, id: string): WorkDetail {
  if (!record(value) || !Array.isArray(value.comments) || !Array.isArray(value.decisions) || !Array.isArray(value.tracker_status_history)) {return fail()}
  const item = validateWorkCard(value.item, profile)

  if (item.id !== id) {return fail()}

  for (const comment of value.comments) {
    if (!record(comment) || !strings(comment, ['id', 'card_id', 'text', 'created_at']) || comment.card_id !== id || !Number.isInteger(comment.revision) || !['human', 'agent'].includes(comment.actor as string)) {return fail()}
  }

  for (const decision of value.decisions) {
    if (!record(decision) || !strings(decision, ['id', 'card_id', 'actor', 'reason', 'created_at']) || decision.card_id !== id || !Number.isInteger(decision.revision) || !actions.includes(decision.action as string) || !['none', 'preparation_only'].includes(decision.scope as string) || !(decision.snoozed_until === null || typeof decision.snoozed_until === 'string')) {return fail()}
  }

  const tracker_status_history = value.tracker_status_history.map(validateTrackerEvidence)

  return { item, comments: value.comments as WorkComment[], decisions: value.decisions as WorkDecisionRecord[], tracker_status_history }
}

export function validateWorkCapability(value: unknown): WorkCapability {
  if (!record(value) || typeof value.can_decide !== 'boolean' || !(value.reason === null || typeof value.reason === 'string')) {return fail()}

  return value as unknown as WorkCapability
}
