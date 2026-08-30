interface NeedsMeProps {
  approvalTitle?: string
  disconnected: boolean
  onOpenApproval: () => void
  onOpenRecovery: () => void
}

export function NeedsMe({ approvalTitle, disconnected, onOpenApproval, onOpenRecovery }: NeedsMeProps) {
  const count = Number(Boolean(approvalTitle)) + Number(disconnected)

  return (
    <section aria-labelledby="needs-title" className="needs-screen">
      <p className="kicker">A short queue, not another inbox</p>
      <h2 id="needs-title">Needs Me <span className="heading-count">{count}</span></h2>
      <p className="screen-lede">Only live decisions and connection interruptions that need your judgment.</p>
      <div className="attention-list">
        {approvalTitle && <button className="attention-item attention-item--amber" onClick={onOpenApproval} type="button"><span className="attention-item__number">!</span><span><span className="label">Approval</span><strong>{approvalTitle}</strong><small>Waiting for your choice</small></span><span aria-hidden="true">→</span></button>}
        {disconnected && <button className="attention-item attention-item--coral" onClick={onOpenRecovery} type="button"><span className="attention-item__number">!</span><span><span className="label">Connection</span><strong>Companion is disconnected</strong><small>Drafts remain on this device</small></span><span aria-hidden="true">→</span></button>}
      </div>
      {count === 0 && <div className="all-clear"><span aria-hidden="true">✓</span><div><strong>Nothing needs you right now</strong><p>Your teammates can continue without a decision.</p></div></div>}
    </section>
  )
}
