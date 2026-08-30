interface RecoveryProps {
  teammateName?: string
  hasDraft: boolean
  turnUncertain: boolean
  recovering: boolean
  error?: string | null
  onRetry: () => void
  onBack?: () => void
}

export function Recovery({ teammateName, hasDraft, turnUncertain, recovering, error, onRetry, onBack }: RecoveryProps) {
  return (
    <section aria-labelledby="recovery-title" className="recovery-screen">
      {onBack && <button className="back-button" onClick={onBack} type="button">← Back</button>}
      <div className="recovery-card">
        <div aria-hidden="true" className="recovery-card__signal">!</div>
        <p className="kicker">Disconnected{teammateName ? ` · ${teammateName}` : ''}</p>
        <h2 id="recovery-title">Connection paused. Your work is safe.</h2>
        <p>
          {hasDraft
            ? turnUncertain
              ? 'Your draft text is saved on this device while its submission outcome is unknown. '
              : 'Your unsent draft is saved on this device. '
            : ''}
          {turnUncertain
            ? 'A turn may have been accepted before the connection closed; reconnect to reconcile its server-side outcome.'
            : 'Reconnect to resume the known conversation and refresh its history.'}
        </p>
        <p>No prompt will be replayed automatically.</p>
        {error && <div className="decision-toast" role="alert">{error}</div>}
        <div className="recovery-actions">
          <button className="primary-button" disabled={recovering} onClick={onRetry} type="button">{recovering ? 'Reconnecting…' : 'Try again'} <span aria-hidden="true">→</span></button>
          {onBack && <button className="text-button" onClick={onBack} type="button">Finish safely</button>}
        </div>
      </div>
    </section>
  )
}
