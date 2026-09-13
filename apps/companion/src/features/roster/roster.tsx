import { rosterCopy } from '../../copy/roster'

export type TeammateStatus = 'idle' | 'working' | 'completed' | 'blocked' | 'needs-approval'

export interface Teammate {
  id: string
  initials: string
  name: string
  role: string
  status: TeammateStatus
  summary: string
}

interface RosterAvailability {
  teammateId: string
  selectable: boolean
  statusLabel: string | null
  detail: string | null
}

interface RosterProps {
  teammates: readonly Teammate[]
  onSelect: (teammate: Teammate) => void
  availability?: readonly RosterAvailability[]
  compact?: boolean
}

export function Roster({ teammates, onSelect, availability = [], compact = false }: RosterProps) {
  return (
    <div className={compact ? 'roster roster--compact' : 'roster'}>
      {teammates.map((teammate) => {
        const profile = availability.find((item) => item.teammateId === teammate.id)
        const disabled = profile?.selectable === false

        return (
          <button aria-describedby={disabled ? `profile-unavailable-${teammate.id}` : undefined} className="teammate-card" disabled={disabled} key={teammate.id} onClick={() => onSelect(teammate)} title={disabled ? profile.detail ?? undefined : undefined} type="button">
            <span aria-hidden="true" className={`avatar avatar--${teammate.id}`}>{teammate.initials}</span>
            <span className="teammate-card__body">
              <span className="teammate-card__heading">
                <strong>{teammate.name}</strong>
                <span className={`status status--${disabled ? 'blocked' : teammate.status}`} id={disabled ? `profile-unavailable-${teammate.id}` : undefined}>{disabled ? profile.statusLabel : rosterCopy.status[teammate.status]}</span>
              </span>
              <span className="teammate-card__role">{teammate.role}</span>
              {!compact && <span className="teammate-card__summary">{disabled ? profile.detail : teammate.summary}</span>}
            </span>
            <span aria-hidden="true" className="card-arrow">↗</span>
          </button>
        )
      })}
    </div>
  )
}
