import {
  type ConnectionState,
  type GatewayClientOptions,
  type GatewayEvent,
  JsonRpcGatewayClient
} from '@hermes/shared'

import {
  type LibraryChunkOptions,
  type LibraryListOptions,
  type LibraryPinOptions,
  validateLibraryCapabilities,
  validateLibraryChunk,
  validateLibraryDetail,
  validateLibraryList,
  validateLibraryProfiles,
  validateLibraryResolve
} from '../features/library/library-types'

import {
  type RestoreRecommendedParams,
  type SetPriorityOverrideParams,
  validateNeedsMePriorities,
  validateOrganizationCapability,
  validateRestoreRecommended,
  validateSetPriorityOverride
} from './organization-types'
import { validateOriginalRoute } from './original-route'
import type { TopicDetail, TopicListOptions, TopicListResult } from './topic-types'
import { validateTopicDetail, validateTopicList } from './topic-validation'
import type {
  ApprovalChoice,
  ApprovalRequestPayload,
  ApprovalRespondResult,
  AttentionListResult,
  CompanionEvent,
  CompanionEventHandler,
  CompanionHistoryEntry,
  CompanionProject,
  CompanionProjectDetail,
  CompanionProjectListOptions,
  CompanionProjectListResult,
  CompanionSession,
  CompanionSessionCreationReceipt,
  CompanionSessionHistoryResult,
  CompanionSessionListOptions,
  CompanionSessionListResult,
  ContinueCompanionSessionOptions,
  ContinueCompanionSessionResult,
  CreateCompanionSessionRequest,
  CreateSessionOptions,
  GatewayAttentionItem,
  GatewaySessionSummary,
  MessageCompleteEvent,
  PendingApprovalsResult,
  ProfilesListResult,
  PromptSubmitResult,
  ReconcileCompanionSessionCreationRequest,
  ReconcileCompanionSessionOptions,
  ReconcileCompanionSessionResult,
  SessionInterruptResult,
  SessionListOptions,
  SessionListResult,
  SessionResult,
  SetPinnedResult
} from './types'
import { validateWorkCapability, validateWorkCommentResult, validateWorkDecisionResult, validateWorkDetail, validateWorkList, type WorkCommentParams, type WorkDecisionParams } from './work-types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const CREATION_RECEIPT_KEYS = [
  'version', 'operation_kind', 'backend_namespace', 'profile', 'client_request_id',
  'project_id', 'stored_session_id', 'row_state', 'operation_status', 'runtime_session_id'
] as const

const CREATION_STATUSES = new Set([
  'not_found', 'preparing', 'claimed', 'admitted', 'running', 'completed', 'failed',
  'cancelled', 'not_admitted', 'interrupted_outcome_unknown', 'recovery_required'
])

const CREATION_ROW_STATES = new Set(['absent', 'present', 'unavailable'])
const CANONICAL_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/ // eslint-disable-line no-control-regex -- control characters are exactly what must be rejected

function protocolString(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && !CONTROL_CHARACTER.test(value)
    && new TextEncoder().encode(value).length <= maximumBytes
}

function malformedCreationReceipt(): never {
  throw new Error('Malformed companion.sessions.create receipt.')
}

export function validateCompanionSessionCreationReceipt(
  value: unknown,
  expected: Pick<CreateCompanionSessionRequest, 'backend_namespace' | 'profile' | 'client_request_id'>
): CompanionSessionCreationReceipt {
  if (!isRecord(value)
    || Object.keys(value).length !== CREATION_RECEIPT_KEYS.length
    || CREATION_RECEIPT_KEYS.some((key) => !Object.hasOwn(value, key))
    || value.version !== 1
    || value.operation_kind !== 'create'
    || value.backend_namespace !== expected.backend_namespace
    || value.profile !== expected.profile
    || value.client_request_id !== expected.client_request_id
    || !protocolString(value.backend_namespace, 4_096)
    || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.profile as string)
    || !CANONICAL_UUID_V4.test(value.client_request_id as string)
    || (value.project_id !== null && !protocolString(value.project_id, 512))
    || (value.stored_session_id !== null && !protocolString(value.stored_session_id, 512))
    || !CREATION_ROW_STATES.has(value.row_state as string)
    || !CREATION_STATUSES.has(value.operation_status as string)
    || (value.runtime_session_id !== null && !protocolString(value.runtime_session_id, 512))) {
    return malformedCreationReceipt()
  }

  const receipt = value as unknown as CompanionSessionCreationReceipt
  const notFound = receipt.operation_status === 'not_found'

  if ((notFound && (receipt.row_state !== 'absent' || receipt.project_id !== null
      || receipt.stored_session_id !== null || receipt.runtime_session_id !== null))
    || (!notFound && receipt.stored_session_id === null)
    || (receipt.runtime_session_id !== null && receipt.row_state !== 'present')) {
    return malformedCreationReceipt()
  }

  return receipt
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

const directoryError = (method: string): never => {throw new Error(`Malformed ${method} response.`)}

const optionalCursor = (record: Record<string, unknown>, method: string): string | null => {
  if (record.next_cursor !== null && typeof record.next_cursor !== 'string') {return directoryError(method)}

  if (typeof record.has_more !== 'boolean' || (record.has_more && !record.next_cursor)) {return directoryError(method)}

  return record.next_cursor
}

const nonNegativeInteger = (value: unknown, method: string): number => {
  if (!Number.isInteger(value) || (value as number) < 0) {return directoryError(method)}

  return value as number
}

const timestamp = (value: unknown, method: string): string | null => {
  if (value === null || value === undefined || value === 0 || value === '') {return null}
  const date = typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000) : typeof value === 'string' ? new Date(value) : null

  if (!date || !Number.isFinite(date.valueOf())) {return directoryError(method)}

  return date.toISOString()
}

const warnings = (value: unknown, method: string): string[] => {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {return directoryError(method)}

  return [...value]
}

const backendProfile = (record: Record<string, unknown>, method: string, expectedProfile?: string) => {
  const profile = requiredString(record, 'profile', `Malformed ${method} response.`)
  const source = requiredString(record, 'backend_namespace', `Malformed ${method} response.`)

  if (!profile || !source || (expectedProfile !== undefined && profile !== expectedProfile)) {return directoryError(method)}

  return { profile, source }
}

const projectTypes = new Set(['desktop_project', 'business_project', 'discovered_repository', 'unknown'])

const projectFromRaw = (value: unknown, method: string, freshness: string, expectedProfile?: string, expectedSource?: string): CompanionProject => {
  if (!isRecord(value) || typeof value.archived !== 'boolean') {return directoryError(method)}
  const type = value.kind

  if (typeof type !== 'string' || !projectTypes.has(type)) {return directoryError(method)}
  const { profile, source } = backendProfile(value, method, expectedProfile)

  if (expectedSource !== undefined && source !== expectedSource) {return directoryError(method)}
  const sessionCount = value.session_count === null || value.session_count === undefined ? null : nonNegativeInteger(value.session_count, method)

  const sessionIds = value.session_ids === null || value.session_ids === undefined
    ? null
    : Array.isArray(value.session_ids)
      && value.session_ids.every((item): item is string => typeof item === 'string' && item.length > 0)
      && new Set(value.session_ids).size === value.session_ids.length
      ? [...value.session_ids]
      : directoryError(method)

  return {
    id: requiredString(value, 'id', `Malformed ${method} response.`),
    title: requiredString(value, 'name', `Malformed ${method} response.`),
    profile,
    source,
    type: type as CompanionProject['type'],
    archived: value.archived,
    last_active: timestamp(value.last_active, method),
    session_count: sessionCount,
    session_ids: sessionIds,
    linked_work_count: null,
    freshness
  }
}

const sessionFromListRaw = (value: unknown, method: string, profile: string, source: string): CompanionSession => {
  if (!isRecord(value) || typeof value.archived !== 'boolean' || typeof value.hidden !== 'boolean') {return directoryError(method)}
  const identity = value.identity

  if (!isRecord(identity) || identity.profile !== profile || identity.backend_namespace !== source) {return directoryError(method)}
  const id = requiredString(value, 'root_id', `Malformed ${method} response.`)

  if (identity.root_id !== id) {return directoryError(method)}
  const origin = requiredString(value, 'origin', `Malformed ${method} response.`)

  return {
    id,
    title: requiredString(value, 'title', `Malformed ${method} response.`),
    profile,
    source,
    origin: origin || null,
    opened_in: [],
    archived: value.archived,
    hidden: value.hidden,
    started_at: timestamp(value.started_at, method),
    last_active: timestamp(value.last_active, method),
    status: null,
    project: null,
    linked_work_count: null,
    message_count: nonNegativeInteger(value.message_count, method)
  }
}

const sessionFromProjectRaw = (value: unknown, method: string, profile: string, source: string): CompanionSession => {
  if (!isRecord(value)) {return directoryError(method)}
  const id = requiredString(value, 'id', `Malformed ${method} response.`)
  const origin = typeof value.source === 'string' ? value.source : ''

  return {
    id,
    title: typeof value.title === 'string' ? value.title : '',
    profile,
    source,
    origin: origin || null,
    opened_in: [],
    archived: value.archived === true,
    hidden: false,
    started_at: timestamp(value.started_at, method),
    last_active: timestamp(value.last_active, method),
    status: null,
    project: null,
    linked_work_count: null,
    message_count: value.message_count === undefined ? null : nonNegativeInteger(value.message_count, method)
  }
}

export function validateCompanionSessionList(value: unknown, expectedProfile?: string): CompanionSessionListResult {
  const method = 'companion.sessions.list'

  if (!isRecord(value) || !Array.isArray(value.items) || typeof value.coverage !== 'string') {return directoryError(method)}
  const { profile, source } = backendProfile(value, method, expectedProfile)
  const warningList = warnings(value.warnings, method)

  return {
    backend_namespace: source,
    sessions: value.items.map((item) => sessionFromListRaw(item, method, profile, source)),
    has_more: value.has_more as boolean,
    next_cursor: optionalCursor(value, method),
    coverage: { complete: value.coverage === 'complete', freshness: timestamp(value.as_of, method), message: warningList.join(' ') || null }
  }
}

export function validateCompanionProjectList(value: unknown, expectedProfile?: string): CompanionProjectListResult {
  const method = 'companion.projects.list'

  if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.coverage)) {return directoryError(method)}
  const { profile, source } = backendProfile(value, method, expectedProfile)
  const asOf = timestamp(value.as_of, method)

  if (!asOf) {return directoryError(method)}
  const warningList = warnings(value.warnings, method)

  return {
    backend_namespace: source,
    projects: value.items.map((item) => projectFromRaw(item, method, asOf, profile, source)),
    has_more: value.has_more as boolean,
    next_cursor: optionalCursor(value, method),
    coverage: { complete: value.coverage.named_projects === 'complete' && value.coverage.membership === 'complete', freshness: asOf, message: warningList.join(' ') || null }
  }
}

export function validateCompanionSessionHistory(value: unknown, profile: string, id: string, expectedSource?: string): CompanionSessionHistoryResult {
  const method = 'companion.sessions.history'

  if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.identity) || value.identity.profile !== profile || value.identity.root_id !== id) {return directoryError(method)}
  const source = requiredString(value.identity, 'backend_namespace', `Malformed ${method} response.`)

  if (!source || (expectedSource !== undefined && source !== expectedSource)) {return directoryError(method)}

  const entries = value.items.map((entry): CompanionHistoryEntry => {
    if (!isRecord(entry) || !Number.isInteger(entry.row_id) || typeof entry.timestamp !== 'number' || !Number.isFinite(entry.timestamp)) {return directoryError(method)}

    if (entry.kind === 'message') {
      if ((entry.role !== 'user' && entry.role !== 'assistant' && entry.role !== 'system') || typeof entry.text !== 'string') {return directoryError(method)}

      const compression = (entry.role === 'user' || entry.role === 'assistant') && (entry.text.startsWith('[CONTEXT SUMMARY]:') || entry.text.includes('[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]') || entry.text.trimEnd().endsWith('--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---'))

      return { id: String(entry.row_id), kind: compression ? 'compression' : 'message', role: entry.role, content: entry.text, label: compression ? 'Compression summary' : null, occurred_at: timestamp(entry.timestamp, method) }
    }

    if (entry.kind !== 'internal_event' || typeof entry.label !== 'string' || entry.collapsed !== true) {return directoryError(method)}

    const eventKind = typeof entry.event === 'string' ? entry.event : ''

    const kind = eventKind === 'compaction_summary'
      ? 'compression'
      : /(?:^|_)(?:tool|shell)(?:_|$)/.test(eventKind) ? 'tool' : 'internal'

    return { id: String(entry.row_id), kind, role: null, content: '', label: entry.label, occurred_at: timestamp(entry.timestamp, method) }
  })

  const warningList = warnings(value.warnings, method)
  const originalRoute = validateOriginalRoute(value.original_route, profile, id)

  return {
    session_id: id,
    profile,
    source,
    entries,
    linked_work: [],
    linked_work_available: false,
    has_more: value.has_more as boolean,
    next_cursor: optionalCursor(value, method),
    coverage: { complete: value.coverage === 'complete', freshness: timestamp(value.as_of, method), message: warningList.join(' ') || null },
    ...(originalRoute ? { original_route: originalRoute } : {})
  }
}

export function validateCompanionProjectDetail(value: unknown, profile: string, id: string): CompanionProjectDetail {
  const method = 'companion.projects.get'

  if (!isRecord(value) || !isRecord(value.item) || !isRecord(value.membership) || !Array.isArray(value.membership.items) || typeof value.membership.coverage !== 'string') {return directoryError(method)}
  const asOf = timestamp(value.as_of, method)

  if (!asOf) {return directoryError(method)}
  const envelope = backendProfile(value, method, profile)
  const project = projectFromRaw(value.item, method, asOf, profile, envelope.source)

  if (project.id !== id) {return directoryError(method)}
  const warningList = warnings(value.warnings, method)

  return {
    project,
    sessions: value.membership.items.map((item) => sessionFromProjectRaw(item, method, profile, project.source)),
    topics: [],
    needs_me: [],
    work: [],
    organization_available: false,
    organization_complete: false,
    organization_message: 'Topic relationships require the authorized organization projection.',
    membership_has_more: value.membership.has_more as boolean,
    membership_next_cursor: optionalCursor(value.membership, method),
    coverage: { complete: value.membership.coverage === 'complete', freshness: asOf, message: warningList.join(' ') || null }
  }
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

    if (candidate.work_ref !== undefined) {
      if (!isRecord(candidate.work_ref) || Object.keys(candidate.work_ref).length !== 2
        || typeof candidate.work_ref.profile !== 'string' || !candidate.work_ref.profile || candidate.work_ref.profile !== candidate.work_ref.profile.trim()
        || candidate.work_ref.profile.length > 64 || /[\\/]/.test(candidate.work_ref.profile) || candidate.work_ref.profile.includes('://')
        || typeof candidate.work_ref.id !== 'string' || !candidate.work_ref.id.trim() || candidate.work_ref.id.length > 100) {throw new Error(error)}

      item.work_ref = { profile: candidate.work_ref.profile, id: candidate.work_ref.id }
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
        completePayload.text = payload.text.slice(0, COMPANION_TERMINAL_TEXT_MAX_LENGTH)
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
      return { type: 'error', session_id, payload: { message: COMPANION_TERMINAL_ERROR_MESSAGE } }

    default:
      return null
  }
}

export const COMPANION_TERMINAL_ERROR_MESSAGE = 'Hermes reported an error while running this turn.'
export const COMPANION_TERMINAL_TEXT_MAX_LENGTH = 65_536

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

  listCompanionSessions(options: CompanionSessionListOptions): Promise<CompanionSessionListResult> {
    const params: Record<string, unknown> = { profile: options.profile }

    if (options.limit !== undefined) {params.limit = options.limit}

    if (options.cursor !== undefined) {params.cursor = options.cursor}

    if (options.view !== undefined) {params.view = options.view}

    if (options.origins !== undefined) {params.origin = options.origins}

    if (options.sources !== undefined) {params.backend_namespace = options.sources}

    if (options.search !== undefined) {params.search = options.search}

    return this.gateway.request<unknown>('companion.sessions.list', params).then((value) => validateCompanionSessionList(value, options.profile))
  }

  getCompanionSessionHistory(profile: string, id: string, cursor?: string, expectedSource?: string): Promise<CompanionSessionHistoryResult> {
    return this.gateway.request<unknown>('companion.sessions.history', { profile, session_id: id, ...(cursor ? { cursor } : {}) }).then((value) => validateCompanionSessionHistory(value, profile, id, expectedSource))
  }

  continueCompanionSession(options: ContinueCompanionSessionOptions): Promise<ContinueCompanionSessionResult> {
    return this.gateway.request('companion.sessions.continue', { ...options })
  }

  createCompanionSession(options: CreateCompanionSessionRequest): Promise<CompanionSessionCreationReceipt> {
    return this.gateway.request<unknown>('companion.sessions.create', { ...options })
      .then((value) => validateCompanionSessionCreationReceipt(value, options))
  }

  reconcileCompanionSession(options: ReconcileCompanionSessionOptions): Promise<ReconcileCompanionSessionResult> {
    return this.gateway.request('companion.sessions.reconcile', { ...options })
  }

  reconcileCompanionSessionCreation(options: ReconcileCompanionSessionCreationRequest): Promise<CompanionSessionCreationReceipt> {
    return this.gateway.request<unknown>('companion.sessions.reconcile', { ...options })
      .then((value) => validateCompanionSessionCreationReceipt(value, options))
  }

  listCompanionProjects(options: CompanionProjectListOptions): Promise<CompanionProjectListResult> {
    const params: Record<string, unknown> = { profile: options.profile }

    if (options.limit !== undefined) {params.limit = options.limit}

    if (options.cursor !== undefined) {params.cursor = options.cursor}

    if (options.archived !== undefined) {params.archived = options.archived}

    return this.gateway.request<unknown>('companion.projects.list', params).then((value) => validateCompanionProjectList(value, options.profile))
  }

  getCompanionProject(profile: string, id: string, cursor?: string): Promise<CompanionProjectDetail> {
    return this.gateway.request<unknown>('companion.projects.get', { profile, id, ...(cursor ? { cursor } : {}) }).then((value) => validateCompanionProjectDetail(value, profile, id))
  }

  listCompanionTopics(options: TopicListOptions): Promise<TopicListResult> {
    const { profile, ...filters } = options

    return this.gateway.request<unknown>('companion.topics.list', { profile, ...filters }).then((value) => validateTopicList(value, profile))
  }

  getCompanionTopic(profile: string, id: string): Promise<TopicDetail> {
    return this.gateway.request<unknown>('companion.topics.get', { profile, id }).then((value) => validateTopicDetail(value, profile, id))
  }

  libraryCapabilities() {
    return this.gateway.request<unknown>('companion.library.capabilities', {}).then(validateLibraryCapabilities)
  }

  libraryProfiles() {
    return this.gateway.request<unknown>('companion.library.profiles', {}).then(validateLibraryProfiles)
  }

  resolveLibraryReference(reference: string, profile?: string) {
    return this.gateway.request<unknown>('companion.library.resolve', { reference, ...(profile ? { profile } : {}) }).then((value) => validateLibraryResolve(value, profile))
  }

  listLibrary(options: LibraryListOptions = {}) {
    return this.gateway.request<unknown>('companion.library.list', { ...options }).then(validateLibraryList)
  }

  getLibraryArtifact(artifactId: string, profile?: string) {
    return this.gateway.request<unknown>('companion.library.get', { artifact_id: artifactId, ...(profile ? { profile } : {}) }).then(validateLibraryDetail)
  }

  previewLibraryArtifact(options: LibraryChunkOptions) {
    return this.gateway.request<unknown>('companion.library.preview', { ...options }).then((value) => validateLibraryChunk(value, 'companion.library.preview'))
  }

  downloadLibraryArtifact(options: LibraryChunkOptions) {
    return this.gateway.request<unknown>('companion.library.download', { ...options }).then((value) => validateLibraryChunk(value, 'companion.library.download'))
  }

  pinReviewedLibraryArtifact(options: LibraryPinOptions) {
    return this.gateway.request<unknown>('companion.library.pin_reviewed', { ...options })
  }

  setSessionPinned(profile: string, sessionId: string, pinned: boolean): Promise<SetPinnedResult> {
    return this.gateway.request('session.set_pinned', { profile, session_id: sessionId, pinned })
  }

  workCapabilities(profile: string) {
    return this.gateway.request<unknown>('work.capabilities', { profile }).then(validateWorkCapability)
  }

  organizationCapabilities() {
    return this.gateway.request<unknown>('companion.organization.capabilities', {}).then(validateOrganizationCapability)
  }

  listNeedsMePriorities(profile: string, reviewId?: string, groupBy: 'topic' | 'session' | 'project' = 'topic') {
    return this.gateway.request<unknown>('companion.organization.needs_me', { profile, group_by: groupBy, ...(reviewId ? { review_id: reviewId } : {}) }).then((value) => validateNeedsMePriorities(value, profile))
  }

  setPriorityOverride(params: SetPriorityOverrideParams) {
    return this.gateway.request<unknown>('companion.priorities.override_set', { ...params }).then(validateSetPriorityOverride)
  }

  restoreRecommendedPriority(params: RestoreRecommendedParams) {
    return this.gateway.request<unknown>('companion.priorities.restore_recommended', { ...params }).then(validateRestoreRecommended)
  }

  listWork(profile: string) {
    return this.gateway.request<unknown>('work.list', { profile, include_snoozed: true }).then((value) => validateWorkList(value, profile))
  }

  getWork(profile: string, id: string) {
    return this.gateway.request<unknown>('work.get', { profile, id }).then((value) => validateWorkDetail(value, profile, id))
  }

  decideWork(params: WorkDecisionParams) {
    return this.gateway.request<unknown>('work.decide', { ...params }).then((value) => validateWorkDecisionResult(value, params.id, params.idempotency_key))
  }

  commentWork(params: WorkCommentParams) {
    return this.gateway.request<unknown>('work.comment', { ...params }).then((value) => validateWorkCommentResult(value, params.id, params.idempotency_key))
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
