import { useEffect, useRef } from 'react'

import type { ApprovalChoice } from '../../gateway/types'
import type { CompanionMessage, PendingApproval, TurnStatus } from '../../state/companion-store'
import { ApprovalCard } from '../attention/approval-card'
import type { Teammate } from '../roster/roster'

import { isContextCompactionMessage, MessageContent } from './message-content'

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
  onApproval
}: ConversationProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const working = turnStatus === 'submitting' || turnStatus === 'streaming'
  const canSubmit = connected && Boolean(draft.trim()) && !working

  useEffect(() => {
    const textarea = textareaRef.current

    if (!textarea) { return }
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px`
  }, [draft])

  const submit = () => {
    if (canSubmit) { onSubmit() }
  }

  return (
    <section aria-labelledby="conversation-title" className="conversation-screen">
      <header className="conversation-head">
        <div aria-hidden="true" className={`avatar avatar--${teammate.id}`}>{teammate.initials}</div>
        <div><p className="kicker">Conversation</p><h2 id="conversation-title">{teammate.name}</h2></div>
        <span className="presence"><span aria-hidden="true">●</span> {connected ? 'Online' : 'Offline'}</span>
      </header>
      <div className="message-list">
        <div className="transcript">
          {messages.length === 0 && <p className="screen-lede conversation-empty">Start a conversation with {teammate.name}.</p>}
          {messages.map((message) => {
            const presentationRole = message.role === 'system' || isContextCompactionMessage(message.role, message.text)
              ? 'system'
              : message.role === 'user' ? 'mine' : 'theirs'

            return (
              <article className={`message message--${presentationRole}`} key={message.id}>
                {message.role === 'assistant' && <span className="message__author">{teammate.name}</span>}
                <MessageContent role={message.role} text={message.text} />
              </article>
            )
          })}
          {(working || streamingText) && (
            <div aria-atomic="true" aria-live="polite" className="streaming-card" role="status">
              <span aria-hidden="true" className="streaming-mark"><i /><i /><i /></span>
              <span><strong>{teammate.name} is working</strong>{streamingText ? <div className="streaming-text"><MessageContent role="assistant" text={streamingText} /></div> : <small>Starting the turn…</small>}</span>
              <button className="text-button" onClick={onInterrupt} type="button">Stop</button>
            </div>
          )}
          {turnStatus === 'uncertain' && <div className="decision-toast decision-toast--conversation" role="status">Connection closed after the turn was accepted. Its server-side outcome is not yet known.</div>}
          {approval && <ApprovalCard approval={approval} onDecision={onApproval} />}
        </div>
      </div>
      <div className="composer-dock">
        <form className="composer" onSubmit={(event) => { event.preventDefault(); submit() }}>
          <label className="sr-only" htmlFor="message-draft">Message {teammate.name}</label>
          <textarea
            id="message-draft"
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
            placeholder={`Message ${teammate.name}…`}
            ref={textareaRef}
            rows={1}
            value={draft}
          />
          <button aria-label="Send message" disabled={!canSubmit} type="submit">↑</button>
        </form>
        <p className="composer-hint">Enter to send · Shift+Enter for a new line</p>
      </div>
    </section>
  )
}
