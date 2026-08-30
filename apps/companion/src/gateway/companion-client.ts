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
  CompanionEvent,
  CompanionEventHandler,
  CreateSessionOptions,
  MessageCompleteEvent,
  PendingApprovalsResult,
  ProfilesListResult,
  PromptSubmitResult,
  SessionInterruptResult,
  SessionResult
} from './types'

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

    return this.gateway.request('session.create', params)
  }

  resumeSession(storedSessionId: string, profile?: string): Promise<SessionResult> {
    const params: Record<string, unknown> = { session_id: storedSessionId }

    if (profile !== undefined) {
      params.profile = profile
    }

    return this.gateway.request('session.resume', params)
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
