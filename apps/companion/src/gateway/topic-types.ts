export type TopicLifecycle = 'active' | 'completed' | 'archived'
export type TopicCoverageStatus = 'complete' | 'partial' | 'unconfigured'

export interface TopicNextAction {
  availability: 'available' | 'unknown'
  coverage?: 'unavailable'
  reason?: string
  assessment_id?: string
  outcome_id?: string
  action_id?: string
  references?: string[]
  assessed_at?: string
  confidence?: string
  benefit?: string
  potential?: number
}

export interface TopicItem {
  id: string
  canonical_id: string
  collection: string
  name: string
  objective: string
  lifecycle: TopicLifecycle
  version: number
  created_at: string
  updated_at: string
  verified_status: { value: TopicLifecycle; verified: true; authority: 'organization.topic.lifecycle'; observed_at: string }
  next_useful_action: TopicNextAction
  linked_work: { coverage: 'partial'; organization_bindings: 'complete' | 'partial'; source_records: 'unavailable'; authorization_filtered: boolean }
}

export interface TopicCoverage {
  configured: boolean
  status: TopicCoverageStatus
  population: string
  source: 'organization.db'
  freshness: { as_of: string; organization_updated_at: string | null }
  authorization_filtered?: boolean
  linked_collections: { needs_me: 'unavailable'; work_source_records: 'unavailable'; files: 'unavailable'; source_details: 'unavailable' }
}

export interface TopicListOptions {
  profile: string
  query?: string
  collection?: string[]
  lifecycle?: TopicLifecycle[]
  verified?: boolean
  sort?: 'updated' | 'name'
  limit?: number
  cursor?: string
}

export interface TopicListResult {
  items: TopicItem[]
  total: number
  has_more: boolean
  next_cursor: string | null
  as_of: string
  profile: string
  backend_namespace: string
  coverage: TopicCoverage
  warnings: string[]
}

export interface SourceNamespace { backend_id: string; profile: string }
export interface TopicSessionRef {
  namespace: SourceNamespace
  persisted_session_id: string
  lineage_root_id: string
  resolved_tip_id?: string | null
}
export interface TopicProjectRef {
  namespace: SourceNamespace
  source_id: string
  kind: string
}
export interface TopicCollection<T> { items: T[] | null; coverage: Record<string, string | boolean> }
export interface TopicWorkItem {
  id: string
  canonical_id: string
  work_kind: string
  source_work_id: string
  source_namespace: SourceNamespace
  relationship: 'primary' | 'related'
  version: number
  updated_at: string
  authorization_filtered: boolean
  source_status: { availability: 'unknown'; coverage: 'unavailable' }
  primary_session: TopicSessionRef | null
  related_sessions: TopicSessionRef[]
  source_projects: TopicProjectRef[]
}
export interface TopicSourceItemBase {
  canonical_id: string
  relationship: string
}
export type TopicSourceItem = TopicSourceItemBase & (
  | { kind: 'namespace'; namespace: SourceNamespace }
  | { kind: 'project'; namespace: SourceNamespace; source_id: string; project_kind: string }
  | { kind: 'session'; namespace: SourceNamespace; session: TopicSessionRef }
)
export interface TopicDetail {
  topic: TopicItem
  overview: { objective: string; next_useful_action: TopicNextAction; verified_status: TopicItem['verified_status']; coverage: { status: 'complete'; authority: 'organization.db' } }
  needs_me: TopicCollection<never>
  work: TopicCollection<TopicWorkItem>
  files: TopicCollection<never>
  sources: TopicCollection<TopicSourceItem>
  tabs: ['overview', 'needs_me', 'work', 'files', 'sources']
  as_of: string
  profile: string
  backend_namespace: string
  coverage: TopicCoverage
  warnings: string[]
}
