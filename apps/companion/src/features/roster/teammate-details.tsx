import type { Teammate } from './roster'

interface TeammateDetailsProps {
  teammate: Teammate
  onMessage: () => void
  onBack?: () => void
}

export function TeammateDetails({ teammate, onMessage, onBack }: TeammateDetailsProps) {
  return (
    <section aria-labelledby="details-title" className="details-screen">
      {onBack && <button className="back-button" onClick={onBack} type="button">← Back</button>}
      <div className="details-hero">
        <span aria-hidden="true" className={`avatar avatar--large avatar--${teammate.id}`}>{teammate.initials}</span>
        <p className="kicker">Teammate details</p>
        <h2 id="details-title">{teammate.name}</h2>
        <p>{teammate.role}</p>
      </div>
      <div className="details-status">
        <p className="label">Right now</p>
        <h3>{teammate.summary}</h3>
        <p>Hermes Companion will keep this work moving and bring you in only when your judgment is needed.</p>
      </div>
      <div className="details-grid">
        <div><strong>8</strong><span>completed this week</span></div>
        <div><strong>2</strong><span>active threads</span></div>
      </div>
      <button className="primary-button" onClick={onMessage} type="button">Message {teammate.name} <span aria-hidden="true">→</span></button>
    </section>
  )
}
