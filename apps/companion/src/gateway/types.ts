import type { CompanionOriginalRoute } from './original-route'

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

export interface GatewayProfile {
  /** Exact gateway profile name; this is the transport identity. */
  name: string
  /** Kept optional for compatibility with older gateway responses. */
  id?: string
  display_name?: string
  description?: string
  [key: string]: unknown
}

export interface ProfilesListResult {
  profiles: GatewayProfile[]
}

export interface SessionMessage {
  [key: string]: unknown
}

export interface SessionResult {
  /** Live gateway session ID used for prompts, interrupts, and approvals. */
  session_id: string
  /** Persisted transcript ID, which is distinct from the live gateway ID. */
  stored_session_id: string | null
  messages: SessionMessage[]
  [key: string]: unknown
}

export interface CreateSessionOptions {
  profile?: string
  title?: string
  hidden?: boolean
  source?: string
}

export interface GatewaySessionSummary {
  id: string
  resolved_id?: string
  title: string
  preview: string
  started_at: number
  last_active: number
  message_count: number
  source: string
  pinned: boolean
}

export interface SessionListOptions {
  profile: string
  limit?: number
  include_hidden?: boolean
  include_archived?: boolean
  title?: string
}

export interface SessionListResult { sessions: GatewaySessionSummary[] }

export interface CompanionCoverage {
  complete: boolean
  freshness: string | null
  message: string | null
}

export interface CompanionEntityRef {
  id: string
  title: string
  status?: string
}

export interface CompanionProjectRef extends CompanionEntityRef {
  profile: string
}

export interface CompanionTopicRef extends CompanionEntityRef {
  /** Profile that owns the organization topic. */
  profile: string
  /** Authoritative organization backend namespace, not the linked source project's namespace. */
  source: string
}

export interface CompanionSession {
  id: string
  title: string
  profile: string
  source: string
  origin: string | null
  opened_in: string[]
  archived: boolean
  hidden: boolean
  started_at: string | null
  last_active: string | null
  status: string | null
  /** Authoritative persisted conversation kind when the source reports it. */
  type?: string | null
  /** Positive membership, verified absence (`null`), or unknown while project coverage is incomplete (`undefined`). */
  project?: CompanionProjectRef | null
  /** Authoritative organization topic references when the source reports them. */
  topics?: CompanionEntityRef[]
  linked_work_count: number | null
  message_count: number | null
}

export interface CompanionProject {
  id: string
  title: string
  profile: string
  source: string
  type: 'desktop_project' | 'business_project' | 'discovered_repository' | 'unknown'
  archived: boolean
  last_active: string | null
  session_count: number | null
  /** Persisted lineage-root IDs from the authoritative Desktop project tree. */
  session_ids?: string[] | null
  linked_work_count: number | null
  freshness: string | null
}

export interface CompanionSessionListOptions {
  profile: string
  limit?: number
  cursor?: string
  view?: 'active' | 'hidden' | 'archived' | 'all'
  origins?: string[]
  /** Exact persisted-session backend namespaces selected by the directory. */
  sources?: string[]
  search?: string
}

export interface CompanionProjectListOptions {
  profile: string
  limit?: number
  cursor?: string
  archived?: boolean
}

export interface CompanionSessionListResult {
  sessions: CompanionSession[]
  has_more: boolean
  next_cursor: string | null
  coverage: CompanionCoverage
}

export interface CompanionProjectListResult {
  projects: CompanionProject[]
  has_more: boolean
  next_cursor: string | null
  coverage: CompanionCoverage
}

export interface CompanionHistoryEntry {
  id: string
  kind: 'message' | 'internal' | 'compression' | 'tool'
  role: 'user' | 'assistant' | 'system' | null
  content: string
  label: string | null
  occurred_at: string | null
}

export interface CompanionSessionHistoryResult {
  session_id: string
  profile: string
  /** Authoritative persisted-session backend namespace. */
  source: string
  entries: CompanionHistoryEntry[]
  linked_work: CompanionEntityRef[]
  linked_work_available: boolean
  has_more: boolean
  next_cursor: string | null
  coverage: CompanionCoverage
  original_route?: CompanionOriginalRoute
}

export interface CompanionProjectDetail {
  project: CompanionProject
  sessions: CompanionSession[]
  topics: CompanionTopicRef[]
  needs_me: CompanionEntityRef[]
  work: CompanionEntityRef[]
  organization_available: boolean
  organization_complete: boolean
  organization_message: string | null
  membership_has_more: boolean
  membership_next_cursor: string | null
  coverage: CompanionCoverage
}

export type AttentionKind = 'approval' | 'question' | 'blocker' | 'completion' | 'error'
export type AttentionResolution = 'approval' | 'open_session' | 'unsupported_here'
export interface CanonicalWorkReference { profile: string; id: string }
export interface GatewayAttentionItem {
  id: string
  kind: AttentionKind
  profile: string
  runtime_session_id: string
  stored_session_id: string | null
  title: string
  detail: string
  occurred_at: number
  actionable: boolean
  resolution: AttentionResolution
  /** Present only when the server proves one durable Work binding for this runtime session. */
  work_ref?: CanonicalWorkReference
  request_id?: string
  request?: Pick<ApprovalRequestPayload, 'request_id' | 'allow_session' | 'allow_permanent' | 'choices'>
}
export interface AttentionListResult {
  items: GatewayAttentionItem[]
  /** attention.list is deliberately local to the connected gateway runtime. */
  scope?: string | { kind?: string; label?: string }
}
export interface SetPinnedResult { pinned: boolean; session_id: string; changed: boolean }

export interface PromptSubmitResult {
  status: 'streaming' | 'queued'
  reconciled?: boolean
}

export interface CompanionSessionTarget {
  /** Exact gateway/backend namespace returned by the read projection. */
  backend_namespace: string
  profile: string
  stored_session_id: string
}

export interface ContinueCompanionSessionOptions extends CompanionSessionTarget {
  text: string
  client_request_id: string
}

export interface AcceptedCompanionSessionResult extends SessionResult, PromptSubmitResult {
  backend_namespace: string
  profile: string
  cwd: string
}

export interface UncertainCompanionSessionResult extends CompanionSessionTarget {
  status: 'uncertain'
  reconciled: true
}

export type ContinueCompanionSessionResult = AcceptedCompanionSessionResult | UncertainCompanionSessionResult

export type CompanionContinuationOperationStatus =
  | 'claimed'
  | 'admitted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'not_admitted'
  | 'interrupted_outcome_unknown'
  | 'legacy_unknown'

export interface ReconcileCompanionSessionOptions extends CompanionSessionTarget {
  client_request_id: string
}

export interface ReconcileCompanionSessionResult extends CompanionSessionTarget {
  status: 'reconciled'
  reconciled: true
  operation_status: CompanionContinuationOperationStatus
  runtime_session_id?: string
}

export interface SessionInterruptResult {
  status?: string
  [key: string]: unknown
}

export interface ApprovalRequestPayload {
  request_id: string
  command?: string
  description?: string
  allow_session?: boolean
  allow_permanent?: boolean
  smart_denied?: boolean
  choices?: ApprovalChoice[]
  pattern_key?: string
  pattern_keys?: string[]
}

export interface PendingApprovalsResult {
  approvals: ApprovalRequestPayload[]
}

export interface ApprovalRespondResult {
  resolved: number
}

export interface MessageDeltaEvent {
  type: 'message.delta'
  session_id: string
  payload: {
    text: string
  }
}

export interface MessageCompleteEvent {
  type: 'message.complete'
  session_id: string
  payload: {
    text?: string
    interrupted?: boolean
  }
}

export interface ToolEvent {
  type: 'tool.start' | 'tool.progress' | 'tool.complete'
  session_id: string
  payload: unknown
}

export interface ApprovalRequestEvent {
  type: 'approval.request'
  session_id: string
  payload: ApprovalRequestPayload
}

export interface ErrorEvent {
  type: 'error'
  session_id: string
  payload: Record<string, unknown>
}

export type CompanionEvent =
  | MessageDeltaEvent
  | MessageCompleteEvent
  | ToolEvent
  | ApprovalRequestEvent
  | ErrorEvent

export type CompanionEventHandler = (event: CompanionEvent) => void
