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

export type AttentionKind = 'approval' | 'question' | 'blocker' | 'completion' | 'error'
export type AttentionResolution = 'approval' | 'open_session' | 'unsupported_here'
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
  status: 'streaming'
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
