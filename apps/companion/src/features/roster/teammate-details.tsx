import type { GatewaySessionSummary } from '../../gateway/types'

import type { Teammate } from './roster'

interface TeammateDetailsProps {
  teammate: Teammate
  sessions: readonly GatewaySessionSummary[]
  sessionsLoading: boolean
  onMessage: () => void
  onOpenSession: (sessionId: string) => void
  onPin: (sessionId: string, pinned: boolean) => void
  onBack?: () => void
}

export function TeammateDetails({ teammate, sessions, sessionsLoading, onMessage, onOpenSession, onPin, onBack }: TeammateDetailsProps) {
  return (
    <section aria-labelledby="details-title" className="details-screen">
      {onBack && <button className="back-button" onClick={onBack} type="button">← Back</button>}
      <header className="details-profile">
        <span aria-hidden="true" className={`avatar avatar--large avatar--${teammate.id}`}>{teammate.initials}</span>
        <div><p className="kicker">{teammate.role}</p><h2 id="details-title">{teammate.name}</h2><p>{teammate.summary}</p></div>
        <button className="primary-button" onClick={onMessage} type="button">Open conversation</button>
      </header>
      <div className="section-heading session-heading"><div><p className="kicker">Conversation history</p><h3>Recent sessions</h3></div><span>Click a session to open it</span></div>
      {sessionsLoading && <p role="status">Loading sessions…</p>}
      <div className="session-list">
        {sessions.map((session) => {
          const title = session.title || 'Untitled session'
          const titleId = `session-title-${session.id}`
          const lastActiveDate = safeSessionDate(session.last_active)

          return (
            <article aria-labelledby={titleId} className="session-row" key={session.id}>
              <button aria-label={`Open session ${title}`} className="session-row__open" onClick={() => onOpenSession(session.resolved_id ?? session.id)} type="button">
                <span className="session-row__content">
                  <strong className="session-row__title" id={titleId}>{title}</strong>
                  <span className="session-row__preview">{session.preview || 'No preview available'}</span>
                  <time dateTime={lastActiveDate?.toISOString()}>{formatSessionTime(session.last_active)}</time>
                </span>
                <span aria-hidden="true" className="session-row__arrow">→</span>
              </button>
              <button aria-label={`${session.pinned ? 'Unpin' : 'Pin'} ${title}`} className="session-pin" onClick={() => onPin(session.id, !session.pinned)} title={session.pinned ? 'Unpin session' : 'Pin session'} type="button">{session.pinned ? '★' : '☆'}</button>
            </article>
          )
        })}
      </div>
      {!sessionsLoading && sessions.length === 0 && <p>No recent visible sessions for this profile.</p>}
    </section>
  )
}

function formatSessionTime(timestamp: number): string {
  const date = safeSessionDate(timestamp)

  if (!date) { return 'Last activity unknown' }
  const elapsed = Date.now() - date.getTime()
  const day = 24 * 60 * 60 * 1000

  if (elapsed >= 0 && elapsed < day) {
    const hours = Math.max(1, Math.round(elapsed / (60 * 60 * 1000)))

    return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  }

  return date.toLocaleString()
}

function safeSessionDate(timestamp: number): Date | null {
  if (!Number.isFinite(timestamp)) { return null }
  const date = new Date(timestamp * 1000)

  return Number.isNaN(date.getTime()) ? null : date
}
