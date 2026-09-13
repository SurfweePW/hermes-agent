import { useMemo } from 'react'

import { conversationCopy } from '../../copy/conversation'
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
  projectLabel = conversationCopy.fallbackProjectLabel,
  onBackToSessions,
  sessionKey = teammate.id
}: ConversationProps) {
  const sending = turnStatus === 'sending' || turnStatus === 'submitting'
  const working = sending || turnStatus === 'streaming' || turnStatus === 'stopping'
  const stopping = turnStatus === 'stopping'
  const visibleSessionTitle = sessionTitle && sessionTitle.trim() ? sessionTitle : conversationCopy.fallbackSessionTitle
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
        {onBackToSessions && <button aria-label={conversationCopy.backToSessions(teammate.name)} className="conversation-back" onClick={onBackToSessions} type="button">←</button>}
        <div aria-hidden="true" className={`avatar avatar--${teammate.id}`}>{teammate.initials}</div>
        <div className="conversation-head__title"><h2 id="conversation-title" title={visibleSessionTitle}>{visibleSessionTitle}</h2><p className="kicker">{teammate.name} · {projectLabel}</p></div>
        <span className="presence"><span aria-hidden="true">●</span> {connected ? conversationCopy.presence.connected : conversationCopy.presence.disconnected}</span>
      </header>
      <div className="message-list" onScroll={transcriptScroll.onScroll} ref={transcriptScroll.viewportRef}>
        <div className="transcript">
          {messages.length === 0 && <p className="screen-lede conversation-empty">{conversationCopy.empty(teammate.name)}</p>}
          {messages.map((message) => {
            const presentationRole = message.role === 'system' || isContextCompactionMessage(message.role, message.text)
              ? 'system'
              : message.role === 'user' ? 'mine' : 'theirs'

            return (
              <article className={`message message--${presentationRole}`} data-transcript-id={message.id} key={message.id}>
                {message.role === 'assistant' && <span className="message__author">{teammate.name}</span>}
                {message.kind && message.kind !== 'message' ? <StatusRow kind={message.kind} label={message.label} payload={message.text} state={message.kind === 'tool' ? message.toolStatus === 'complete' ? conversationCopy.statusRow.toolState.complete : message.toolStatus === 'progress' ? conversationCopy.statusRow.toolState.progress : conversationCopy.statusRow.toolState.running : null} /> : <MessageContent role={message.role} text={message.text} />}
              </article>
            )
          })}
          {(working || streamingText) && (
            <div aria-atomic="true" aria-live="polite" className="streaming-card" role="status">
              <span aria-hidden="true" className="streaming-mark"><i /><i /><i /></span>
              <span><strong>{stopping ? conversationCopy.turn.stoppingTitle(teammate.name) : sending ? conversationCopy.turn.sendingTitle : conversationCopy.turn.workingTitle(teammate.name)}</strong>{streamingText ? <div className="streaming-text"><MessageContent role="assistant" text={streamingText} /></div> : <small>{stopping ? conversationCopy.turn.stoppingDetail : sending ? conversationCopy.turn.sendingDetail : conversationCopy.turn.workingDetail}</small>}</span>
              {working && <button className="text-button" disabled={!connected || stopping} onClick={onInterrupt} type="button">{stopping ? conversationCopy.turn.stopping : conversationCopy.turn.stop}</button>}
            </div>
          )}
          {turnStatus === 'uncertain' && <div className="decision-toast decision-toast--conversation" role="status">{conversationCopy.notices.uncertain}</div>}
          {turnStatus === 'interrupted' && <div className="decision-toast decision-toast--conversation" role="status">{conversationCopy.notices.interrupted}</div>}
          {approval && <ApprovalCard approval={approval} onDecision={onApproval} />}
          <div aria-hidden="true" ref={transcriptScroll.endRef} />
        </div>
      </div>
      {transcriptScroll.showJumpToLatest && <button className="jump-to-latest" onClick={transcriptScroll.jumpToLatest} type="button">{conversationCopy.transcript.newMessages}</button>}
      <MessageComposer disabled={!connected || working} draft={draft} hint={conversationCopy.composer.hint} id="message-draft" label={conversationCopy.composer.label(teammate.name)} onDraftChange={onDraftChange} onSubmit={onSubmit} placeholder={conversationCopy.composer.placeholder(teammate.name)} sendLabel={conversationCopy.composer.send} />
    </section>
  )
}
