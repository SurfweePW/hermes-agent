import type { GatewaySessionSummary } from '../../gateway/types'
import type { Teammate } from './roster'

interface TeammateDetailsProps {
  teammate: Teammate
  sessions: readonly GatewaySessionSummary[]
  sessionsLoading: boolean
  onMessage: () => void
  onResume: (sessionId: string) => void
  onPin: (sessionId: string, pinned: boolean) => void
  onBotChat: () => void
  onBack?: () => void
}

export function TeammateDetails({ teammate, sessions, sessionsLoading, onMessage, onResume, onPin, onBotChat, onBack }: TeammateDetailsProps) {
  return (
    <section aria-labelledby="details-title" className="details-screen">
      {onBack && <button className="back-button" onClick={onBack} type="button">← Back</button>}
      <div className="details-hero"><span aria-hidden="true" className={`avatar avatar--large avatar--${teammate.id}`}>{teammate.initials}</span><p className="kicker">Teammate details</p><h2 id="details-title">{teammate.name}</h2><p>{teammate.role}</p></div>
      <div className="details-status"><p className="label">Right now</p><h3>{teammate.summary}</h3></div>
      <div className="details-grid"><button className="primary-button" onClick={onMessage} type="button">Message {teammate.name}</button><button onClick={onBotChat} type="button">Open Bot Chat</button></div>
      <div className="section-heading"><div><p className="kicker">Selected profile only</p><h3>Recent sessions</h3></div></div>
      {sessionsLoading && <p role="status">Loading sessions…</p>}
      <div className="attention-list">
        {sessions.map((session) => <article className="attention-item" key={session.id}><button onClick={() => onResume(session.resolved_id ?? session.id)} type="button"><strong>{session.title || 'Untitled session'}</strong><small>{session.preview || 'No preview available'}</small><small>Last activity: {session.last_active ? new Date(session.last_active * 1000).toLocaleString() : 'unknown'}</small></button><button aria-label={`${session.pinned ? 'Unpin' : 'Pin'} ${session.title || 'session'}`} onClick={() => onPin(session.id, !session.pinned)} type="button">{session.pinned ? '★' : '☆'}</button></article>)}
      </div>
      {!sessionsLoading && sessions.length === 0 && <p>No recent visible sessions for this profile.</p>}
    </section>
  )
}
