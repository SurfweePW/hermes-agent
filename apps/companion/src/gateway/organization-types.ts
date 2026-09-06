export type PriorityEligibility = 'urgent_protection' | 'assessed' | 'potential_validation' | 'needs_assessment'
export type NeedsMeGroupBy = 'topic' | 'session' | 'project'
export interface PriorityAssessment {
  id: string
  outcome_id: string
  action_id: string
  objective: string
  time_horizon: string
  benefit: string
  confidence: string
  cost_of_delay: string
  dependency_unblocking: string
  burden: string
  reversibility: string
  evidence: string[]
  author: string
  assessed_at: string
  policy_version: string
  next_action_refs: string[]
  potential: boolean
}
export interface PriorityOverrideView {
  id: string
  mode: 'pin_review' | 'set_priority'
  label: string
  actor: string
  reason: string
  expires_at: string | null
  review_id: string | null
  review_at: string | null
  active: boolean
}
export interface NeedsMePriorityItem {
  profile: string
  work_id: string
  candidate_id: string
  eligibility: PriorityEligibility
  why_here: string
  next_step: string
  trade_off: string
  assessed_at: string | null
  evidence: string[]
  assessment: PriorityAssessment | null
  override: PriorityOverrideView | null
}
export interface NeedsMePriorityGroup {
  id: string
  group: { kind: NeedsMeGroupBy; id: string; name: string; collection: string | null; objective: string | null }
  eligibility: PriorityEligibility
  eligible_action_count: number
  why_here: string
  items: NeedsMePriorityItem[]
}
export interface NeedsMePriorityResult {
  profile: string
  backend_namespace: string
  sort: 'recommended'
  policy_version: string
  review_id: string | null
  group_by: NeedsMeGroupBy
  groups: NeedsMePriorityGroup[]
  as_of: string
  coverage: { work: string; organization: string; authorization_filtered: boolean }
}
export interface OrganizationGateway {
  listNeedsMePriorities(profile: string, reviewId?: string, groupBy?: NeedsMeGroupBy): Promise<NeedsMePriorityResult>
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const malformed = (): never => {throw new Error('Malformed companion.organization.needs_me response.')}
const text = (value: unknown): value is string => typeof value === 'string'
const nullableText = (value: unknown): value is string | null => value === null || text(value)
const textArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const eligibility = (value: unknown): value is PriorityEligibility => ['urgent_protection', 'assessed', 'potential_validation', 'needs_assessment'].includes(value as string)

function assessment(value: unknown): PriorityAssessment | null {
  if (value === null) {return null}

  if (!record(value)
    || !['id', 'outcome_id', 'action_id', 'objective', 'time_horizon', 'benefit', 'confidence', 'cost_of_delay', 'dependency_unblocking', 'burden', 'reversibility', 'author', 'assessed_at', 'policy_version'].every((key) => text(value[key]))
    || !textArray(value.evidence) || !textArray(value.next_action_refs) || typeof value.potential !== 'boolean') {return malformed()}

  return value as unknown as PriorityAssessment
}

function override(value: unknown): PriorityOverrideView | null {
  if (value === null) {return null}

  if (!record(value) || !['id', 'label', 'actor', 'reason'].every((key) => text(value[key]))
    || !['pin_review', 'set_priority'].includes(value.mode as string)
    || !nullableText(value.expires_at) || !nullableText(value.review_id) || !nullableText(value.review_at)
    || typeof value.active !== 'boolean') {return malformed()}

  return value as unknown as PriorityOverrideView
}

function item(value: unknown, profile: string): NeedsMePriorityItem {
  if (!record(value) || value.profile !== profile
    || !['work_id', 'candidate_id', 'why_here', 'next_step', 'trade_off'].every((key) => text(value[key]))
    || !eligibility(value.eligibility) || !nullableText(value.assessed_at) || !textArray(value.evidence)) {return malformed()}

  return { ...(value as unknown as NeedsMePriorityItem), assessment: assessment(value.assessment), override: override(value.override) }
}

export function validateNeedsMePriorities(value: unknown, profile: string): NeedsMePriorityResult {
  if (!record(value) || value.profile !== profile || value.sort !== 'recommended'
    || !['backend_namespace', 'policy_version', 'as_of'].every((key) => text(value[key]))
    || !nullableText(value.review_id) || !['topic', 'session', 'project'].includes(value.group_by as string) || !Array.isArray(value.groups) || !record(value.coverage)
    || typeof value.coverage.authorization_filtered !== 'boolean' || !text(value.coverage.work) || !text(value.coverage.organization)) {return malformed()}

  const ids = new Set<string>()

  const groups = value.groups.map((raw): NeedsMePriorityGroup => {
    if (!record(raw) || !text(raw.id) || !eligibility(raw.eligibility) || !text(raw.why_here)
      || !Number.isInteger(raw.eligible_action_count) || (raw.eligible_action_count as number) < 1 || !Array.isArray(raw.items)) {return malformed()}

    if (!record(raw.group) || !['topic', 'session', 'project'].includes(raw.group.kind as string)
      || !text(raw.group.id) || !text(raw.group.name) || !nullableText(raw.group.collection) || !nullableText(raw.group.objective)) {return malformed()}

    const items = raw.items.map((entry) => item(entry, profile))

    for (const entry of items) {
      const key = `${entry.profile}\u0000${entry.work_id}`

      if (ids.has(key)) {return malformed()}
      ids.add(key)
    }

    return { ...(raw as unknown as NeedsMePriorityGroup), items }
  })

  return { ...(value as unknown as NeedsMePriorityResult), groups }
}
