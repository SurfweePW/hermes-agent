import { useMemo } from 'react'

import type { ApprovalChoice } from '../../gateway/types'
import type { CompanionMessage, PendingApproval, TurnStatus } from '../../state/companion-store'
import { ApprovalCard } from '../attention/approval-card'
import type { Teammate } from '../roster/roster'

import { MessageComposer } from './message-composer'
import { isContextCompactionMessage, MessageContent } from './message-content'
import { StatusRow } from './status-row'
import { useTranscriptScroll } from './transcript-scroll'

interface ConversationProps {
  teammate: Teammate
  messages: readonly CompanionMessage[]
  streamingText: string
  turnStatus: TurnStatus
  approval: PendingApproval | null
  draft: string
  connected: boolean
  onDraftChange: (draft: string) => void
  onSubmit: () => void
  onInterrupt: () => void
  onApproval: (decision: ApprovalChoice) => void
  sessionTitle?: string | null
  projectLabel?: string
  onBackToSessions?: () => void
  sessionKey?: string
}

export function Conversation({
  teammate,
  messages,
  streamingText,
  turnStatus,
  approval,
  draft,
  connected,
  onDraftChange,
  onSubmit,
  onInterrupt,
  onApproval,
  sessionTitle,
  projectLabel = 'Projekt nieznany',
  onBackToSessions,
  sessionKey = teammate.id
}: ConversationProps) {
  const sending = turnStatus === 'sending' || turnStatus === 'submitting'
  const working = sending || turnStatus === 'streaming' || turnStatus === 'stopping'
  const stopping = turnStatus === 'stopping'
  const visibleSessionTitle = sessionTitle && sessionTitle.trim() ? sessionTitle : 'Nazwa rozmowy niedostępna'
  const contentVersion = useMemo(() => [
    ...messages.map((message) => `${message.id}:${message.kind ?? 'message'}:${message.toolStatus ?? ''}:${message.label ?? ''}:${message.text}`),
    `stream:${streamingText}`,
    `approval:${approval?.requestId ?? ''}`
  ].join('\u0000'), [approval?.requestId, messages, streamingText])
  const itemIds = useMemo(() => messages.map((message) => message.id), [messages])
  const transcriptScroll = useTranscriptScroll(sessionKey, itemIds, contentVersion)

  return (
    <section aria-labelledby="conversation-title" className="conversation-screen">
      <header className="conversation-head">
        {onBackToSessions && <button aria-label={`Back to ${teammate.name} sessions`} className="conversation-back" onClick={onBackToSessions} type="button">←</button>}
        <div aria-hidden="true" className={`avatar avatar--${teammate.id}`}>{teammate.initials}</div>
        <div className="conversation-head__title"><h2 id="conversation-title" title={visibleSessionTitle}>{visibleSessionTitle}</h2><p className="kicker">{teammate.name} · {projectLabel}</p></div>
        <span className="presence"><span aria-hidden="true">●</span> {connected ? 'Online' : 'Offline'}</span>
      </header>
      <div className="message-list" onScroll={transcriptScroll.onScroll} ref={transcriptScroll.viewportRef}>
        <div className="transcript">
          {messages.length === 0 && <p className="screen-lede conversation-empty">Start a conversation with {teammate.name}.</p>}
          {messages.map((message) => {
            const presentationRole = message.role === 'system' || isContextCompactionMessage(message.role, message.text)
              ? 'system'
              : message.role === 'user' ? 'mine' : 'theirs'

            return (
              <article className={`message message--${presentationRole}`} data-transcript-id={message.id} key={message.id}>
                {message.role === 'assistant' && <span className="message__author">{teammate.name}</span>}
                {message.kind && message.kind !== 'message' ? <StatusRow kind={message.kind} label={message.label} payload={message.text} state={message.kind === 'tool' ? message.toolStatus === 'complete' ? 'Complete' : message.toolStatus === 'progress' ? 'In progress' : 'Running' : null} /> : <MessageContent role={message.role} text={message.text} />}
              </article>
            )
          })}
          {(working || streamingText) && (
            <div aria-atomic="true" aria-live="polite" className="streaming-card" role="status">
              <span aria-hidden="true" className="streaming-mark"><i /><i /><i /></span>
              <span><strong>{stopping ? `Stopping ${teammate.name}…` : sending ? 'Sending your message…' : `${teammate.name} is working`}</strong>{streamingText ? <div className="streaming-text"><MessageContent role="assistant" text={streamingText} /></div> : <small>{stopping ? 'Waiting for the current turn to stop…' : sending ? 'Waiting for Hermes to accept it…' : 'The turn is running…'}</small>}</span>
              {working && <button className="text-button" disabled={!connected || stopping} onClick={onInterrupt} type="button">{stopping ? 'Stopping…' : 'Stop'}</button>}
            </div>
          )}
          {turnStatus === 'uncertain' && <div className="decision-toast decision-toast--conversation" role="status">Connection closed after the turn was accepted. Its server-side outcome is not yet known.</div>}
          {turnStatus === 'interrupted' && <div className="decision-toast decision-toast--conversation" role="status">Turn interrupted. You can send a new message when ready.</div>}
          {approval && <ApprovalCard approval={approval} onDecision={onApproval} />}
          <div aria-hidden="true" ref={transcriptScroll.endRef} />
        </div>
      </div>
      {transcriptScroll.showJumpToLatest && <button className="jump-to-latest" onClick={transcriptScroll.jumpToLatest} type="button">↓ New messages</button>}
      <MessageComposer disabled={!connected || working} draft={draft} hint="Enter adds a new line · Ctrl/Cmd+Enter sends" id="message-draft" label={`Message ${teammate.name}`} onDraftChange={onDraftChange} onSubmit={onSubmit} placeholder={`Message ${teammate.name}…`} sendLabel="Send message" />
    </section>
  )
}
