import { useState } from 'react'

import { ApprovalCard, type ApprovalDecision } from '../attention/approval-card'

interface ConversationProps {
  decision?: string
  isStreaming: boolean
  onApproval: (decision: ApprovalDecision) => void
}

export function Conversation({ decision, isStreaming, onApproval }: ConversationProps) {
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<string[]>([])

  const send = () => {
    const message = draft.trim()

    if (!message) {return}
    setMessages((current) => [...current, message])
    setDraft('')
  }

  return (
    <section aria-labelledby="conversation-title" className="conversation-screen">
      <header className="conversation-head">
        <div aria-hidden="true" className="avatar avatar--atlas">A</div>
        <div><p className="kicker">Conversation</p><h2 id="conversation-title">Atlas</h2></div>
        <span className="presence"><span aria-hidden="true">●</span> Online</span>
      </header>
      <div className="message-list">
        <article className="message message--mine"><p>Check the results, write a short brief, and prepare it for the Investments group.</p><time dateTime="15:38">3:38 PM</time></article>
        <article className="message message--theirs"><span className="message__author">Atlas · 3:42 PM</span><p>I checked the source set and the previous report. The figures agree. I’ve prepared the final brief and kept the source trail.</p></article>
        {messages.map((message, index) => <article className="message message--mine" key={`${message}-${index}`}><p>{message}</p><time dateTime={new Date().toISOString()}>Now</time></article>)}
        {isStreaming && (
          <div aria-atomic="true" aria-live="polite" className="streaming-card" role="status">
            <span aria-hidden="true" className="streaming-mark"><i /><i /><i /></span>
            <span><strong>Atlas is working</strong><small>Checking the final sources</small></span>
          </div>
        )}
        {decision
          ? <div aria-atomic="true" className="decision-toast decision-toast--conversation" role="status">Choice saved: <strong>{decision}</strong></div>
          : <ApprovalCard onDecision={onApproval} />}
      </div>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); send() }}>
        <label className="sr-only" htmlFor="message-draft">Message Atlas</label>
        <input id="message-draft" onChange={(event) => setDraft(event.target.value)} placeholder="Message Atlas…" value={draft} />
        <button aria-label="Send message" type="submit">↑</button>
      </form>
    </section>
  )
}
