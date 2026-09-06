import type { ConnectionState } from '@hermes/shared'

import type {
  ApprovalChoice,
  CompanionEvent,
  CompanionEventHandler,
  CreateSessionOptions,
  SessionMessage,
  SessionResult
} from '../gateway/types'
import type { CompanionGateway } from '../state/companion-store'

const fixtureProfiles = [
  { name: 'atlas' },
  { name: 'mentor' },
  { name: 'maven' },
  { name: 'scout' }
]

const initialMessages: SessionMessage[] = [
  { role: 'assistant', content: 'I’m ready. What would you like me to move forward?' }
]

/** Deterministic QA gateway. It is used only through explicit dependency injection/build flags. */
export class FakeCompanionGateway implements CompanionGateway {
  connectionState: ConnectionState = 'idle'
  private eventHandlers = new Set<CompanionEventHandler>()
  private stateHandlers = new Set<(state: ConnectionState) => void>()
  private sessionCounter = 0
  private activeSession: SessionResult | null = null
  private pendingApproval = true

  async connect(_wsUrl: string): Promise<void> {
    this.setState('connecting')
    this.setState('open')
  }

  close(): void {
    this.setState('closed')
  }

  onEvent(handler: CompanionEventHandler): () => void {
    this.eventHandlers.add(handler)

    return () => this.eventHandlers.delete(handler)
  }

  onState(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler)
    handler(this.connectionState)

    return () => this.stateHandlers.delete(handler)
  }

  async listProfiles() {
    return { profiles: fixtureProfiles.map((profile) => ({ ...profile })) }
  }

  async createSession(options: CreateSessionOptions = {}): Promise<SessionResult> {
    const number = ++this.sessionCounter
    this.activeSession = {
      session_id: `fixture-runtime-${number}`,
      stored_session_id: `fixture-stored-${number}`,
      messages: initialMessages.map((message) => ({ ...message })),
      profile: options.profile
    }
    this.pendingApproval = true

    return { ...this.activeSession, messages: [...this.activeSession.messages] }
  }

  async resumeSession(storedSessionId: string, profile?: string): Promise<SessionResult> {
    const number = ++this.sessionCounter
    this.activeSession = {
      session_id: `fixture-runtime-${number}`,
      stored_session_id: storedSessionId,
      messages: initialMessages.map((message) => ({ ...message })),
      profile
    }

    return { ...this.activeSession, messages: [...this.activeSession.messages] }
  }

  async listSessions(options: { profile: string; limit?: number; include_hidden?: boolean; title?: string }) {
    const sessions = this.activeSession?.stored_session_id
      ? [{ id: this.activeSession.stored_session_id, title: options.title ?? 'Recent conversation', preview: 'Fixture conversation', started_at: 1, last_active: 1, message_count: 1, source: 'companion', pinned: false }]
      : []

    return { sessions }
  }

  async setSessionPinned(_profile: string, sessionId: string, pinned: boolean) {
    return { pinned, session_id: sessionId, changed: true }
  }

  async listAttention() {
    return { items: [], scope: 'This gateway runtime only' }
  }

  async submitPrompt(runtimeSessionId: string, text: string) {
    this.assertSession(runtimeSessionId)
    queueMicrotask(() => {
      this.emit({ type: 'message.delta', session_id: runtimeSessionId, payload: { text: 'I’m on it. ' } })
      this.emit({
        type: 'message.complete',
        session_id: runtimeSessionId,
        payload: { text: `I’m on it. I received: “${text}”` }
      })
    })

    return { status: 'streaming' as const }
  }

  async interruptSession(runtimeSessionId: string) {
    this.assertSession(runtimeSessionId)
    this.emit({ type: 'message.complete', session_id: runtimeSessionId, payload: { interrupted: true } })

    return { status: 'interrupted' }
  }

  async listPendingApprovals(runtimeSessionId: string) {
    this.assertSession(runtimeSessionId)

    return {
      approvals: this.pendingApproval
        ? [{
            request_id: 'fixture-approval-1',
            description: 'Publish the prepared brief?',
            command: 'Publish the brief to the selected group',
            choices: ['once', 'session', 'deny'] as ApprovalChoice[]
          }]
        : []
    }
  }

  async respondToApproval(runtimeSessionId: string, requestId: string, _choice: ApprovalChoice) {
    this.assertSession(runtimeSessionId)

    if (requestId !== 'fixture-approval-1' || !this.pendingApproval) {return { resolved: 0 }}
    this.pendingApproval = false

    return { resolved: 1 }
  }

  /** QA-only control for exercising recovery without network nondeterminism. */
  simulateDisconnect(): void {
    this.setState('closed')
  }

  private assertSession(runtimeSessionId: string): void {
    if (this.activeSession?.session_id !== runtimeSessionId) {throw new Error('Fixture session is not active.')}
  }

  private emit(event: CompanionEvent): void {
    for (const handler of this.eventHandlers) {handler(event)}
  }

  private setState(state: ConnectionState): void {
    this.connectionState = state

    for (const handler of this.stateHandlers) {handler(state)}
  }
}

export function createFakeGateway(): CompanionGateway {
  return new FakeCompanionGateway()
}
