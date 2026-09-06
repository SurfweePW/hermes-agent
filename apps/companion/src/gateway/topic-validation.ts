import type {
  SourceNamespace,
  TopicCollection,
  TopicCoverage,
  TopicDetail,
  TopicItem,
  TopicListResult,
  TopicSourceItem,
  TopicWorkItem
} from './topic-types'

const malformed = (method: string): never => { throw new Error(`Malformed ${method} response.`) }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, method: string, maximum = 10_000) => {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum) { return malformed(method) }

  return value
}

const integer = (value: unknown, method: string) => {
  if (!Number.isInteger(value) || (value as number) < 0) { return malformed(method) }

  return value as number
}

const instant = (value: unknown, method: string, nullable = false): string | null => {
  if (nullable && value === null) { return null }

  if (typeof value !== 'string' || !value || !Number.isFinite(new Date(value).valueOf())) { return malformed(method) }

  return new Date(value).toISOString()
}

const stringList = (value: unknown, method: string): string[] => {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) { return malformed(method) }

  return [...value]
}

const identity = (value: Record<string, unknown>, method: string, expectedProfile: string) => {
  const profile = text(value.profile, method, 100)
  const backend = text(value.backend_namespace, method, 500)

  if (profile !== expectedProfile || /[\\/]/.test(profile) || profile.includes('://')) { return malformed(method) }

  return { profile, backend }
}

const cursor = (value: Record<string, unknown>, method: string) => {
  if (typeof value.has_more !== 'boolean' || (value.next_cursor !== null && typeof value.next_cursor !== 'string') || (value.has_more && !value.next_cursor) || (!value.has_more && value.next_cursor !== null)) { return malformed(method) }

  return value.next_cursor as string | null
}

const namespace = (value: unknown, backend: string, method: string): SourceNamespace => {
  if (!record(value) || Object.keys(value).some((key) => !['backend_id', 'profile'].includes(key))) { return malformed(method) }
  const backendId = text(value.backend_id, method, 500)
  const profile = text(value.profile, method, 100)

  if (backendId !== backend || /[\\/]/.test(profile) || profile.includes('://')) { return malformed(method) }

  return { backend_id: backendId, profile }
}

const nextAction = (value: unknown, method: string): TopicItem['next_useful_action'] => {
  if (!record(value) || (value.availability !== 'available' && value.availability !== 'unknown')) { return malformed(method) }

  if (value.availability === 'unknown') {
    if (value.coverage !== 'unavailable' || typeof value.reason !== 'string') { return malformed(method) }

    return { availability: 'unknown', coverage: 'unavailable', reason: value.reason }
  }

  const references = stringList(value.references, method)
  const assessedAt = instant(value.assessed_at, method)

  if (!references.length || typeof value.potential !== 'number' || !Number.isFinite(value.potential)) { return malformed(method) }

  return {
    availability: 'available', assessment_id: text(value.assessment_id, method, 200), outcome_id: text(value.outcome_id, method, 200), action_id: text(value.action_id, method, 200), references,
    assessed_at: assessedAt!, confidence: text(value.confidence, method, 100), benefit: text(value.benefit, method, 100), potential: value.potential
  }
}

const topic = (value: unknown, method: string): TopicItem => {
  if (!record(value) || !record(value.verified_status) || !record(value.linked_work) || !['active', 'completed', 'archived'].includes(value.lifecycle as string)) { return malformed(method) }
  const lifecycle = value.lifecycle as TopicItem['lifecycle']
  const observedAt = instant(value.verified_status.observed_at, method)

  if (value.verified_status.value !== lifecycle || value.verified_status.verified !== true || value.verified_status.authority !== 'organization.topic.lifecycle' || value.linked_work.coverage !== 'partial' || !['complete', 'partial'].includes(value.linked_work.organization_bindings as string) || value.linked_work.source_records !== 'unavailable' || typeof value.linked_work.authorization_filtered !== 'boolean') { return malformed(method) }

  return {
    id: text(value.id, method, 200), canonical_id: text(value.canonical_id, method, 1000), collection: text(value.collection, method, 200), name: text(value.name, method), objective: text(value.objective, method), lifecycle,
    version: integer(value.version, method), created_at: instant(value.created_at, method)!, updated_at: instant(value.updated_at, method)!,
    verified_status: { value: lifecycle, verified: true, authority: 'organization.topic.lifecycle', observed_at: observedAt! }, next_useful_action: nextAction(value.next_useful_action, method),
    linked_work: { coverage: 'partial', organization_bindings: value.linked_work.organization_bindings as 'complete' | 'partial', source_records: 'unavailable', authorization_filtered: value.linked_work.authorization_filtered }
  }
}

const coverage = (value: unknown, asOf: string, method: string): TopicCoverage => {
  if (!record(value) || typeof value.configured !== 'boolean' || !['complete', 'partial', 'unconfigured'].includes(value.status as string) || typeof value.population !== 'string' || value.source !== 'organization.db' || !record(value.freshness) || !record(value.linked_collections)) { return malformed(method) }
  const coverageAsOf = instant(value.freshness.as_of, method)
  const updatedAt = instant(value.freshness.organization_updated_at, method, true)

  if (coverageAsOf !== asOf || value.configured !== (value.status !== 'unconfigured') || value.linked_collections.needs_me !== 'unavailable' || value.linked_collections.work_source_records !== 'unavailable' || value.linked_collections.files !== 'unavailable' || value.linked_collections.source_details !== 'unavailable' || (value.authorization_filtered !== undefined && typeof value.authorization_filtered !== 'boolean')) { return malformed(method) }

  return { configured: value.configured, status: value.status as TopicCoverage['status'], population: value.population, source: 'organization.db', freshness: { as_of: coverageAsOf!, organization_updated_at: updatedAt }, ...(typeof value.authorization_filtered === 'boolean' ? { authorization_filtered: value.authorization_filtered } : {}), linked_collections: { needs_me: 'unavailable', work_source_records: 'unavailable', files: 'unavailable', source_details: 'unavailable' } }
}

export function validateTopicList(value: unknown, expectedProfile: string): TopicListResult {
  const method = 'companion.topics.list'

  if (!record(value) || !Array.isArray(value.items)) { return malformed(method) }
  const { profile, backend } = identity(value, method, expectedProfile)
  const asOf = instant(value.as_of, method)
  const items = value.items.map((item) => topic(item, method))
  const total = integer(value.total, method)
  const nextCursor = cursor(value, method)

  if (items.length > total) { return malformed(method) }

  return { items, total, has_more: value.has_more as boolean, next_cursor: nextCursor, as_of: asOf!, profile, backend_namespace: backend, coverage: coverage(value.coverage, asOf!, method), warnings: stringList(value.warnings, method) }
}

const collection = <T>(value: unknown, method: string, parse: (item: unknown) => T, nullable: boolean): TopicCollection<T> => {
  if (!record(value) || !record(value.coverage) || typeof value.coverage.status !== 'string' || !['complete', 'partial', 'unavailable'].includes(value.coverage.status) || (!Array.isArray(value.items) && !(nullable && value.items === null)) || (value.items === null && value.coverage.status !== 'unavailable')) { return malformed(method) }

  return { items: value.items === null ? null : value.items.map(parse), coverage: { ...value.coverage } as Record<string, string | boolean> }
}

export function validateTopicDetail(value: unknown, expectedProfile: string, expectedId: string): TopicDetail {
  const method = 'companion.topics.get'

  if (!record(value) || !record(value.overview) || !record(value.overview.coverage) || !Array.isArray(value.tabs) || value.tabs.join(',') !== 'overview,needs_me,work,files,sources') { return malformed(method) }
  const { profile, backend } = identity(value, method, expectedProfile)
  const asOf = instant(value.as_of, method)
  const item = topic(value.topic, method)

  if (item.id !== expectedId || value.overview.objective !== item.objective || value.overview.coverage.status !== 'complete' || value.overview.coverage.authority !== 'organization.db' || !record(value.overview.verified_status) || value.overview.verified_status.value !== item.lifecycle) { return malformed(method) }

  const work = collection<TopicWorkItem>(value.work, method, (raw) => {
    if (!record(raw) || !record(raw.source_status) || !['primary', 'related'].includes(raw.relationship as string) || typeof raw.authorization_filtered !== 'boolean' || raw.source_status.availability !== 'unknown' || raw.source_status.coverage !== 'unavailable') { return malformed(method) }
    const updatedAt = instant(raw.updated_at, method)

    return { id: text(raw.id, method, 200), canonical_id: text(raw.canonical_id, method, 1000), work_kind: text(raw.work_kind, method, 200), source_work_id: text(raw.source_work_id, method, 200), source_namespace: namespace(raw.source_namespace, backend, method), relationship: raw.relationship as 'primary' | 'related', version: integer(raw.version, method), updated_at: updatedAt!, authorization_filtered: raw.authorization_filtered, source_status: { availability: 'unknown', coverage: 'unavailable' } }
  }, false)

  const sources = collection<TopicSourceItem>(value.sources, method, (raw) => {
    if (!record(raw) || !['namespace', 'project', 'session'].includes(raw.kind as string)) { return malformed(method) }
    const namespaceRaw = raw.kind === 'session' && record(raw.session) ? raw.session.namespace : raw.namespace

    return { kind: raw.kind as TopicSourceItem['kind'], canonical_id: text(raw.canonical_id, method, 1000), relationship: text(raw.relationship, method, 200), ...(namespaceRaw ? { namespace: namespace(namespaceRaw, backend, method) } : {}) }
  }, false)

  const needsMe = collection<never>(value.needs_me, method, () => malformed(method), true)
  const files = collection<never>(value.files, method, () => malformed(method), true)

  return { topic: item, overview: { objective: item.objective, next_useful_action: item.next_useful_action, verified_status: item.verified_status, coverage: { status: 'complete', authority: 'organization.db' } }, needs_me: needsMe, work, files, sources, tabs: ['overview', 'needs_me', 'work', 'files', 'sources'], as_of: asOf!, profile, backend_namespace: backend, coverage: coverage(value.coverage, asOf!, method), warnings: stringList(value.warnings, method) }
}
