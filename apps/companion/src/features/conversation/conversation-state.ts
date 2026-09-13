import { conversationCopy } from '../../copy/conversation'
import type { TurnStatus } from '../../state/companion-store'

export type ConversationStateKind = 'working' | 'waiting' | 'completed' | 'error' | 'unknown'

export interface ConversationState {
  kind: ConversationStateKind
  label: string
}

export const formatConversationTime = (value: string | number | null | undefined): string | null => {
  if (value === null || value === undefined) {return null}
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {return null}

  return date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
}

export function deriveConversationState({
  turnStatus,
  approvalPending = false,
  error = false,
  sessionStatus,
  completedAt
}: {
  turnStatus?: TurnStatus
  approvalPending?: boolean
  error?: boolean
  sessionStatus?: string | null
  completedAt?: string | number | null
}): ConversationState {
  if (error || sessionStatus === 'error' || sessionStatus === 'failed') {
    return { kind: 'error', label: conversationCopy.state.error }
  }

  if (approvalPending || sessionStatus === 'blocked' || sessionStatus === 'awaiting_input' || sessionStatus === 'needs_attention') {
    return { kind: 'waiting', label: conversationCopy.state.waiting }
  }

  if (turnStatus === 'sending' || turnStatus === 'submitting' || turnStatus === 'streaming' || turnStatus === 'stopping'
    || sessionStatus === 'active' || sessionStatus === 'running' || sessionStatus === 'streaming' || sessionStatus === 'in_progress') {
    return { kind: 'working', label: conversationCopy.state.working }
  }

  if (sessionStatus === 'completed') {
    const time = formatConversationTime(completedAt)

    return time
      ? { kind: 'completed', label: conversationCopy.state.completed(time) }
      : { kind: 'unknown', label: conversationCopy.state.unknown }
  }

  return { kind: 'unknown', label: conversationCopy.state.unknown }
}
