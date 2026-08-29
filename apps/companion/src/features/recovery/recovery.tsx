interface RecoveryProps {
  onRetry: () => void
  onBack?: () => void
}

export function Recovery({ onRetry, onBack }: RecoveryProps) {
  return (
    <section aria-labelledby="recovery-title" className="recovery-screen">
      {onBack && <button className="back-button" onClick={onBack} type="button">← Back</button>}
      <div className="recovery-card">
        <div aria-hidden="true" className="recovery-card__signal">!</div>
        <p className="kicker">Disconnected · Maven</p>
        <h2 id="recovery-title">Connection paused. Your work is safe.</h2>
        <p>Your draft is saved on this device. Maven also kept all 183 verified records and the exact place where work stopped.</p>
        <dl className="recovery-receipt">
          <div><dt>Safe checkpoint</dt><dd>Project 184 of 236</dd></div>
          <div><dt>Saved work</dt><dd>183 verified projects</dd></div>
          <div><dt>Retry risk</dt><dd>Low · no duplicates</dd></div>
        </dl>
        <div className="recovery-actions">
          <button className="primary-button" onClick={onRetry} type="button">Try again <span aria-hidden="true">→</span></button>
          {onBack && <button className="text-button" onClick={onBack} type="button">Finish safely</button>}
        </div>
      </div>
    </section>
  )
}
