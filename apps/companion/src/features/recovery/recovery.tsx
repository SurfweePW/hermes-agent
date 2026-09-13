import { recoveryCopy } from '../../copy/recovery'

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
      {onBack && <button className="back-button" onClick={onBack} type="button">{recoveryCopy.back}</button>}
      <div className="recovery-card">
        <div aria-hidden="true" className="recovery-card__signal">!</div>
        <p className="kicker">{recoveryCopy.kicker}{teammateName ? ` · ${teammateName}` : ''}</p>
        <h2 id="recovery-title">{recoveryCopy.title}</h2>
        <p>
          {hasDraft
            ? turnUncertain
              ? recoveryCopy.draftUnknown
              : recoveryCopy.draftSaved
            : ''}
          {turnUncertain
            ? recoveryCopy.turnUncertain
            : recoveryCopy.reconnectResume}
        </p>
        <p>{recoveryCopy.noReplay}</p>
        {error && <div className="decision-toast" role="alert">{error}</div>}
        <div className="recovery-actions">
          <button className="primary-button" disabled={recovering} onClick={onRetry} type="button">{recovering ? recoveryCopy.reconnecting : recoveryCopy.retry} <span aria-hidden="true">→</span></button>
          {onBack && <button className="text-button" onClick={onBack} type="button">{recoveryCopy.finish}</button>}
        </div>
      </div>
    </section>
  )
}
