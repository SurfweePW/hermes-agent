import type { ApprovalChoice } from '../../gateway/types'
import type { CompanionMessage, PendingApproval, TurnStatus } from '../../state/companion-store'
import { ApprovalCard } from '../attention/approval-card'
import type { Teammate } from '../roster/roster'

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
  const working = turnStatus === 'submitting' || turnStatus === 'streaming'

  return (
    <section aria-labelledby="conversation-title" className="conversation-screen">
      <header className="conversation-head">
        <div aria-hidden="true" className={`avatar avatar--${teammate.id}`}>{teammate.initials}</div>
        <div><p className="kicker">Conversation</p><h2 id="conversation-title">{teammate.name}</h2></div>
        <span className="presence"><span aria-hidden="true">●</span> {connected ? 'Online' : 'Offline'}</span>
      </header>
      <div className="message-list">
        {messages.length === 0 && <p className="screen-lede">Start a conversation with {teammate.name}.</p>}
        {messages.map((message) => (
          <article className={`message message--${message.role === 'user' ? 'mine' : 'theirs'}`} key={message.id}>
            {message.role !== 'user' && <span className="message__author">{teammate.name}</span>}
            <p>{message.text}</p>
          </article>
        ))}
        {(working || streamingText) && (
          <div aria-atomic="true" aria-live="polite" className="streaming-card" role="status">
            <span aria-hidden="true" className="streaming-mark"><i /><i /><i /></span>
            <span><strong>{teammate.name} is working</strong><small>{streamingText || 'Starting the turn…'}</small></span>
            <button className="text-button" onClick={onInterrupt} type="button">Stop</button>
          </div>
        )}
        {turnStatus === 'uncertain' && <div className="decision-toast decision-toast--conversation" role="status">Connection closed after the turn was accepted. Its server-side outcome is not yet known.</div>}
        {approval && <ApprovalCard approval={approval} onDecision={onApproval} />}
      </div>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
        <label className="sr-only" htmlFor="message-draft">Message {teammate.name}</label>
        <input id="message-draft" onChange={(event) => onDraftChange(event.target.value)} placeholder={`Message ${teammate.name}…`} value={draft} />
        <button aria-label="Send message" disabled={!connected || !draft.trim() || working} type="submit">↑</button>
      </form>
    </section>
  )
}
