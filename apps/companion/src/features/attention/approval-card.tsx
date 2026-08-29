export type ApprovalDecision = 'once' | 'session' | 'deny'

interface ApprovalCardProps {
  onDecision: (decision: ApprovalDecision) => void
}

export function ApprovalCard({ onDecision }: ApprovalCardProps) {
  return (
    <section aria-labelledby="approval-title" className="approval-card">
      <div className="approval-card__top">
        <span aria-hidden="true" className="approval-icon">!</span>
        <div>
          <p className="kicker">Your approval</p>
          <h3 id="approval-title">Publish the investment brief?</h3>
        </div>
      </div>
      <p>Atlas checked the sources and prepared the final PDF. This will post it to the Investments group.</p>
      <dl className="approval-facts">
        <div><dt>Audience</dt><dd>8 group members</dd></div>
        <div><dt>Can undo</dt><dd>Yes, delete the post</dd></div>
      </dl>
      <div aria-label="Approval choices" className="approval-actions" role="group">
        <button className="button button--deny" onClick={() => onDecision('deny')} type="button">Deny</button>
        <button className="button" onClick={() => onDecision('session')} type="button">Approve for session</button>
        <button className="button button--primary" onClick={() => onDecision('once')} type="button">Approve once</button>
      </div>
    </section>
  )
}
