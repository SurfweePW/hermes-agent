export type TeammateStatus = 'idle' | 'working' | 'completed' | 'blocked' | 'needs-approval'

export interface Teammate {
  id: string
  initials: string
  name: string
  role: string
  status: TeammateStatus
  summary: string
}

const statusLabels: Record<TeammateStatus, string> = {
  idle: 'No activity observed',
  working: 'Working',
  completed: 'Completed',
  blocked: 'Blocked',
  'needs-approval': 'Needs approval'
}

interface RosterProps {
  teammates: readonly Teammate[]
  onSelect: (teammate: Teammate) => void
  compact?: boolean
}

export function Roster({ teammates, onSelect, compact = false }: RosterProps) {
  return (
    <div className={compact ? 'roster roster--compact' : 'roster'}>
      {teammates.map((teammate) => (
        <button className="teammate-card" key={teammate.id} onClick={() => onSelect(teammate)} type="button">
          <span aria-hidden="true" className={`avatar avatar--${teammate.id}`}>{teammate.initials}</span>
          <span className="teammate-card__body">
            <span className="teammate-card__heading">
              <strong>{teammate.name}</strong>
              <span className={`status status--${teammate.status}`}>{statusLabels[teammate.status]}</span>
            </span>
            <span className="teammate-card__role">{teammate.role}</span>
            {!compact && <span className="teammate-card__summary">{teammate.summary}</span>}
          </span>
          <span aria-hidden="true" className="card-arrow">↗</span>
        </button>
      ))}
    </div>
  )
}
