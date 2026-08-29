export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

export interface GatewayProfile {
  id?: string
  name?: string
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
}

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

export type CompanionEvent =
  | MessageDeltaEvent
  | MessageCompleteEvent
  | ToolEvent
  | ApprovalRequestEvent

export type CompanionEventHandler = (event: CompanionEvent) => void
