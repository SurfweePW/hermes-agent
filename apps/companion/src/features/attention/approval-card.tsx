import type { ApprovalChoice } from '../../gateway/types'
import type { PendingApproval } from '../../state/companion-store'

interface ApprovalCardProps {
  approval: PendingApproval
  onDecision: (decision: ApprovalChoice) => void
}

const labels: Record<ApprovalChoice, string> = {
  once: 'Approve once',
  session: 'Approve for session',
  always: 'Always approve',
  deny: 'Deny'
}

export function ApprovalCard({ approval, onDecision }: ApprovalCardProps) {
  return (
    <section aria-labelledby="approval-title" className="approval-card">
      <div className="approval-card__top">
        <span aria-hidden="true" className="approval-icon">!</span>
        <div><p className="kicker">Your approval</p><h3 id="approval-title">{approval.title}</h3></div>
      </div>
      <p>{approval.description}</p>
      {approval.command && <pre aria-label="Requested command">{approval.command}</pre>}
      <div aria-label="Approval choices" className="approval-actions" role="group">
        {approval.choices.map((choice) => (
          <button
            className={`button${choice === 'deny' ? ' button--deny' : choice === 'once' ? ' button--primary' : ''}`}
            disabled={approval.responding}
            key={choice}
            onClick={() => onDecision(choice)}
            type="button"
          >
            {labels[choice]}
          </button>
        ))}
      </div>
    </section>
  )
}
