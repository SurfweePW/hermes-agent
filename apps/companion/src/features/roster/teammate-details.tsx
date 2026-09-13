import { rosterCopy } from '../../copy/roster'
import type { GatewaySessionSummary } from '../../gateway/types'
import { PersistedConversationList } from '../conversation/persisted-conversation-list'

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
      {onBack && <button className="back-button" onClick={onBack} type="button">{rosterCopy.details.back}</button>}
      <header className="details-profile">
        <span aria-hidden="true" className={`avatar avatar--large avatar--${teammate.id}`}>{teammate.initials}</span>
        <div><p className="kicker">{teammate.role}</p><h2 id="details-title">{teammate.name}</h2><p>{teammate.summary}</p></div>
        <button className="primary-button" onClick={onMessage} type="button">{rosterCopy.details.openConversation}</button>
      </header>
      <div className="section-heading session-heading"><div><p className="kicker">{rosterCopy.details.history}</p><h3>{rosterCopy.details.recent}</h3></div><span>{rosterCopy.details.openHint}</span></div>
      {sessionsLoading && <p role="status">{rosterCopy.details.loading}</p>}
      <PersistedConversationList className="session-list" emptyCopy={rosterCopy.details.empty} emptyTitle={rosterCopy.details.emptyTitle} itemKey={(session) => session.id} items={sessions} renderItem={(session) => {
          const index = sessions.indexOf(session)
          const title = session.title || rosterCopy.details.untitled
          const slug = session.id.toLocaleLowerCase().normalize('NFKD').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'session'
          const titleId = `session-title-${slug}-${index}`
          const lastActiveDate = safeSessionDate(session.last_active)

          return (
            <article aria-labelledby={titleId} className="session-row" key={session.id}>
              <button aria-label={rosterCopy.details.open(title)} className="session-row__open" onClick={() => onOpenSession(session.resolved_id ?? session.id)} type="button">
                <span className="session-row__content">
                  <strong className="session-row__title" id={titleId}>{title}</strong>
                  <span className="session-row__preview">{session.preview || rosterCopy.details.noPreview}</span>
                  <time dateTime={lastActiveDate?.toISOString()}>{formatSessionTime(session.last_active)}</time>
                </span>
                <span aria-hidden="true" className="session-row__arrow">→</span>
              </button>
              <button aria-label={session.pinned ? rosterCopy.details.unpin(title) : rosterCopy.details.pin(title)} className="session-pin" onClick={() => onPin(session.id, !session.pinned)} title={session.pinned ? rosterCopy.details.unpinTitle : rosterCopy.details.pinTitle} type="button">{session.pinned ? '★' : '☆'}</button>
            </article>
          )
        }} showEmpty={!sessionsLoading} />
    </section>
  )
}

function formatSessionTime(timestamp: number): string {
  const date = safeSessionDate(timestamp)

  if (!date) { return rosterCopy.details.lastActivityUnknown }
  const elapsed = Date.now() - date.getTime()
  const day = 24 * 60 * 60 * 1000

  if (elapsed >= 0 && elapsed < day) {
    const hours = Math.max(1, Math.round(elapsed / (60 * 60 * 1000)))

    return rosterCopy.details.hoursAgo(hours)
  }

  return date.toLocaleString('pl-PL')
}

function safeSessionDate(timestamp: number): Date | null {
  if (!Number.isFinite(timestamp)) { return null }
  const date = new Date(timestamp * 1000)

  return Number.isNaN(date.getTime()) ? null : date
}
