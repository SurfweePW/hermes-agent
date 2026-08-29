interface NeedsMeProps {
  onOpenApproval: () => void
  onOpenRecovery: () => void
}

export function NeedsMe({ onOpenApproval, onOpenRecovery }: NeedsMeProps) {
  return (
    <section aria-labelledby="needs-title" className="needs-screen">
      <p className="kicker">A short queue, not another inbox</p>
      <h2 id="needs-title">Needs Me <span className="heading-count">2</span></h2>
      <p className="screen-lede">Only decisions and interruptions that need your judgment.</p>
      <div className="attention-list">
        <button className="attention-item attention-item--amber" onClick={onOpenApproval} type="button">
          <span className="attention-item__number">01</span>
          <span><span className="label">Approval · Atlas</span><strong>Publish the investment brief</strong><small>Ready now · about 30 seconds</small></span>
          <span aria-hidden="true">→</span>
        </button>
        <button className="attention-item attention-item--coral" onClick={onOpenRecovery} type="button">
          <span className="attention-item__number">02</span>
          <span><span className="label">Blocked · Maven</span><strong>Portal connection expired</strong><small>Progress saved · 11 minutes ago</small></span>
          <span aria-hidden="true">→</span>
        </button>
      </div>
      <div className="all-clear"><span aria-hidden="true">✓</span><div><strong>Everything else is moving</strong><p>Mentor and Scout are working without needing you.</p></div></div>
    </section>
  )
}
