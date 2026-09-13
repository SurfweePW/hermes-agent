import { appCopy } from '../../copy/app'
import type { ApprovalChoice } from '../../gateway/types'
import type { PendingApproval } from '../../state/companion-store'

interface ApprovalCardProps {
  approval: PendingApproval
  onDecision: (decision: ApprovalChoice) => void
}

const labels: Record<ApprovalChoice, string> = {
  once: appCopy.attention.approval.once,
  session: appCopy.attention.approval.session,
  always: appCopy.attention.approval.always,
  deny: appCopy.attention.approval.deny
}

export function ApprovalCard({ approval, onDecision }: ApprovalCardProps) {
  return (
    <section aria-labelledby="approval-title" className="approval-card">
      <div className="approval-card__top">
        <span aria-hidden="true" className="approval-icon">!</span>
        <div><p className="kicker">{appCopy.attention.approval.kicker}</p><h3 id="approval-title">{approval.title}</h3></div>
      </div>
      <p>{approval.description}</p>
      {approval.command && <pre aria-label={appCopy.attention.approval.command}>{approval.command}</pre>}
      <div aria-label={appCopy.attention.approval.choices} className="approval-actions" role="group">
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
