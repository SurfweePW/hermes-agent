import {
  type ConnectionState,
  type GatewayClientOptions,
  type GatewayEvent,
  JsonRpcGatewayClient
} from '@hermes/shared'

import type {
  ApprovalChoice,
  ApprovalRequestPayload,
  ApprovalRespondResult,
  AttentionListResult,
  CompanionEvent,
  CompanionEventHandler,
  CreateSessionOptions,
  GatewayAttentionItem,
  GatewaySessionSummary,
  MessageCompleteEvent,
  PendingApprovalsResult,
  ProfilesListResult,
  PromptSubmitResult,
  SessionInterruptResult,
  SessionListOptions,
  SessionListResult,
  SessionResult,
  SetPinnedResult
} from './types'
import { validateWorkCapability, validateWorkDetail, validateWorkList, type WorkCommentParams, type WorkDecisionParams } from './work-types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isApprovalChoice(value: unknown): value is ApprovalChoice {
  return value === 'once' || value === 'session' || value === 'always' || value === 'deny'
}

function malformedPendingApprovals(): never {
  throw new Error('Malformed approval.pending response.')
}

function validatedApproval(value: unknown): ApprovalRequestPayload {
  if (!isRecord(value)
    || typeof value.request_id !== 'string'
    || value.request_id.trim().length === 0) {return malformedPendingApprovals()}

  const approval: ApprovalRequestPayload = { request_id: value.request_id }
  const optionalStrings = ['command', 'description', 'pattern_key'] as const
  const optionalBooleans = ['allow_session', 'allow_permanent', 'smart_denied'] as const

  for (const key of optionalStrings) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      if (typeof value[key] !== 'string') {return malformedPendingApprovals()}

      approval[key] = value[key]
    }
  }

  for (const key of optionalBooleans) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      if (typeof value[key] !== 'boolean') {return malformedPendingApprovals()}

      approval[key] = value[key]
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, 'choices')) {
    if (!Array.isArray(value.choices)
      || !value.choices.every(isApprovalChoice)
      || new Set(value.choices).size !== value.choices.length) {return malformedPendingApprovals()}

    approval.choices = [...value.choices]
  }

  if (Object.prototype.hasOwnProperty.call(value, 'pattern_keys')) {
    if (!Array.isArray(value.pattern_keys)
      || !value.pattern_keys.every((key): key is string => typeof key === 'string')) {return malformedPendingApprovals()}

    approval.pattern_keys = [...value.pattern_keys]
  }

  return approval
}

function validatedPendingApprovals(value: unknown): PendingApprovalsResult {
  if (!isRecord(value) || !Array.isArray(value.approvals)) {return malformedPendingApprovals()}

  return { approvals: value.approvals.map(validatedApproval) }
}

function requiredString(record: Record<string, unknown>, key: string, error: string): string {
  const value = record[key]

  if (typeof value !== 'string') {throw new Error(error)}

  return value
}

function validatedSessions(value: unknown): SessionListResult {
  const error = 'Malformed session.list response.'

  if (!isRecord(value) || !Array.isArray(value.sessions)) {throw new Error(error)}

  const sessions = value.sessions.map((candidate): GatewaySessionSummary => {
    if (!isRecord(candidate)) {throw new Error(error)}
    const id = requiredString(candidate, 'id', error)
    const title = requiredString(candidate, 'title', error)
    const preview = requiredString(candidate, 'preview', error)
    const source = requiredString(candidate, 'source', error)
    const startedAt = typeof candidate.started_at === 'number' ? candidate.started_at : 0
    const lastActive = typeof candidate.last_active === 'number' ? candidate.last_active : startedAt
    const messageCount = typeof candidate.message_count === 'number' ? candidate.message_count : 0
    const pinned = typeof candidate.pinned === 'boolean' ? candidate.pinned : false

    return {
      id, title, preview, source,
      started_at: startedAt,
      last_active: lastActive,
      message_count: messageCount,
      pinned,
      ...(typeof candidate.resolved_id === 'string' ? { resolved_id: candidate.resolved_id } : {})
    }
  })

  return { sessions }
}

function validatedAttention(value: unknown): AttentionListResult {
  const error = 'Malformed attention.list response.'

  if (!isRecord(value) || !Array.isArray(value.items)) {throw new Error(error)}
  const kinds = new Set(['approval', 'question', 'blocker', 'completion', 'error'])

  const items = value.items.map((candidate): GatewayAttentionItem => {
    if (!isRecord(candidate) || !kinds.has(candidate.kind as string)) {throw new Error(error)}
    const profile = requiredString(candidate, 'profile', error)

    if (!profile || profile.length > 64 || /[\\/]/.test(profile) || profile.includes('://')) {
      throw new Error(error)
    }

    const stored = candidate.stored_session_id

    if (stored !== null && typeof stored !== 'string') {throw new Error(error)}

    if (typeof candidate.occurred_at !== 'number') {throw new Error(error)}

    const item: GatewayAttentionItem = {
      id: requiredString(candidate, 'id', error),
      kind: candidate.kind as GatewayAttentionItem['kind'],
      profile,
      runtime_session_id: requiredString(candidate, 'runtime_session_id', error),
      stored_session_id: stored,
      title: requiredString(candidate, 'title', error).slice(0, 240),
      detail: requiredString(candidate, 'detail', error).slice(0, 500),
      occurred_at: candidate.occurred_at,
      actionable: candidate.actionable === true,
      resolution: candidate.resolution === 'approval'
        || candidate.resolution === 'open_session'
        || candidate.resolution === 'unsupported_here'
        ? candidate.resolution
        : (() => {throw new Error(error)})()
    }

    if (typeof candidate.request_id === 'string') {item.request_id = candidate.request_id}

    if (candidate.request !== undefined) {
      const approval = validatedApproval(candidate.request)
      item.request = {
        request_id: approval.request_id,
        ...(approval.allow_session !== undefined ? { allow_session: approval.allow_session } : {}),
        ...(approval.allow_permanent !== undefined ? { allow_permanent: approval.allow_permanent } : {}),
        ...(approval.choices ? { choices: approval.choices } : {})
      }
    }

    return item
  })

  const scope = typeof value.scope === 'string' ? value.scope : undefined

  return { items, ...(scope ? { scope } : {}) }
}

function toCompanionEvent(event: GatewayEvent): CompanionEvent | null {
  if (typeof event.session_id !== 'string' || !isRecord(event.payload)) {
    return null
  }

  const session_id = event.session_id
  const payload = event.payload

  switch (event.type) {
    case 'message.delta':
      return typeof payload.text === 'string'
        ? { type: 'message.delta', session_id, payload: { text: payload.text } }
        : null
    case 'message.complete': {
      const completePayload: MessageCompleteEvent['payload'] = {}

      if (typeof payload.text === 'string') {
        completePayload.text = payload.text
      }

      if (typeof payload.interrupted === 'boolean') {
        completePayload.interrupted = payload.interrupted
      }

      return { type: 'message.complete', session_id, payload: completePayload }
    }

    case 'tool.start':
      return { type: 'tool.start', session_id, payload: event.payload }

    case 'tool.progress':
      return { type: 'tool.progress', session_id, payload: event.payload }

    case 'tool.complete':
      return { type: 'tool.complete', session_id, payload: event.payload }
    case 'approval.request': {
      if (typeof payload.request_id !== 'string' || payload.request_id.trim().length === 0) {
        return null
      }

      const approvalPayload: ApprovalRequestPayload = { request_id: payload.request_id }

      if (typeof payload.command === 'string') {
        approvalPayload.command = payload.command
      }

      if (typeof payload.description === 'string') {
        approvalPayload.description = payload.description
      }

      if (typeof payload.allow_session === 'boolean') {
        approvalPayload.allow_session = payload.allow_session
      }

      if (typeof payload.allow_permanent === 'boolean') {
        approvalPayload.allow_permanent = payload.allow_permanent
      }

      if (typeof payload.smart_denied === 'boolean') {
        approvalPayload.smart_denied = payload.smart_denied
      }

      if (Array.isArray(payload.choices) && payload.choices.every(isApprovalChoice)) {
        approvalPayload.choices = payload.choices
      }

      if (typeof payload.pattern_key === 'string') {
        approvalPayload.pattern_key = payload.pattern_key
      }

      if (
        Array.isArray(payload.pattern_keys) &&
        payload.pattern_keys.every((patternKey): patternKey is string => typeof patternKey === 'string')
      ) {
        approvalPayload.pattern_keys = payload.pattern_keys
      }

      return { type: 'approval.request', session_id, payload: approvalPayload }
    }

    case 'error':
      return { type: 'error', session_id, payload }

    default:
      return null
  }
}

/** Typed Companion domain facade over the shared JSON-RPC WebSocket transport. */
export class CompanionClient {
  private readonly gateway: JsonRpcGatewayClient
  private readonly eventHandlers = new Set<CompanionEventHandler>()

  constructor(options: GatewayClientOptions = {}) {
    this.gateway = new JsonRpcGatewayClient(options)
    this.gateway.onEvent((event) => {
      const companionEvent = toCompanionEvent(event)

      if (!companionEvent) {
        return
      }

      for (const handler of this.eventHandlers) {
        handler(companionEvent)
      }
    })
  }

  get connectionState(): ConnectionState {
    return this.gateway.connectionState
  }

  connect(wsUrl: string): Promise<void> {
    return this.gateway.connect(wsUrl)
  }

  close(): void {
    this.gateway.close()
  }

  onEvent(handler: CompanionEventHandler): () => void {
    this.eventHandlers.add(handler)

    return () => this.eventHandlers.delete(handler)
  }

  onState(handler: (state: ConnectionState) => void): () => void {
    return this.gateway.onState(handler)
  }

  listProfiles(): Promise<ProfilesListResult> {
    return this.gateway.request('profiles.list', {})
  }

  createSession(options: CreateSessionOptions = {}): Promise<SessionResult> {
    const params: Record<string, unknown> = {}

    if (options.profile !== undefined) {
      params.profile = options.profile
    }

    if (options.title !== undefined) {
      params.title = options.title
    }

    if (options.hidden !== undefined) {params.hidden = options.hidden}

    if (options.source !== undefined) {params.source = options.source}

    return this.gateway.request('session.create', params)
  }

  resumeSession(storedSessionId: string, profile?: string): Promise<SessionResult> {
    const params: Record<string, unknown> = { session_id: storedSessionId }

    if (profile !== undefined) {
      params.profile = profile
    }

    return this.gateway.request('session.resume', params)
  }

  listSessions(options: SessionListOptions): Promise<SessionListResult> {
    const params: Record<string, unknown> = { profile: options.profile }

    if (options.limit !== undefined) {params.limit = options.limit}

    if (options.include_hidden !== undefined) {params.include_hidden = options.include_hidden}

    if (options.include_archived !== undefined) {params.include_archived = options.include_archived}

    if (options.title !== undefined) {params.title = options.title}

    return this.gateway.request<unknown>('session.list', params).then(validatedSessions)
  }

  setSessionPinned(profile: string, sessionId: string, pinned: boolean): Promise<SetPinnedResult> {
    return this.gateway.request('session.set_pinned', { profile, session_id: sessionId, pinned })
  }

  workCapabilities(profile: string) {
    return this.gateway.request<unknown>('work.capabilities', { profile }).then(validateWorkCapability)
  }

  listWork(profile: string) {
    return this.gateway.request<unknown>('work.list', { profile, include_snoozed: true }).then((value) => validateWorkList(value, profile))
  }

  getWork(profile: string, id: string) {
    return this.gateway.request<unknown>('work.get', { profile, id }).then((value) => validateWorkDetail(value, profile, id))
  }

  decideWork(params: WorkDecisionParams): Promise<unknown> {
    return this.gateway.request('work.decide', { ...params })
  }

  commentWork(params: WorkCommentParams): Promise<unknown> {
    return this.gateway.request('work.comment', { ...params })
  }

  listAttention(): Promise<AttentionListResult> {
    return this.gateway.request<unknown>('attention.list', {}).then(validatedAttention)
  }

  submitPrompt(runtimeSessionId: string, text: string): Promise<PromptSubmitResult> {
    return this.gateway.request('prompt.submit', {
      session_id: runtimeSessionId,
      text
    })
  }

  interruptSession(runtimeSessionId: string): Promise<SessionInterruptResult> {
    return this.gateway.request('session.interrupt', { session_id: runtimeSessionId })
  }

  listPendingApprovals(runtimeSessionId: string): Promise<PendingApprovalsResult> {
    return this.gateway.request<unknown>('approval.pending', { session_id: runtimeSessionId })
      .then(validatedPendingApprovals)
  }

  respondToApproval(
    runtimeSessionId: string,
    requestId: string,
    choice: ApprovalChoice
  ): Promise<ApprovalRespondResult> {
    return this.gateway.request('approval.respond', {
      session_id: runtimeSessionId,
      request_id: requestId,
      choice,
      all: false
    })
  }
}
