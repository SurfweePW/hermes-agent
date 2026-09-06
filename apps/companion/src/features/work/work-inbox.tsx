import './work.css'

import { useState } from 'react'

/** Presentation model, deliberately independent of the gateway wire contract. */
export interface WorkCardView {
  id: string
  profile: string
  title: string
  brief: string
  revision: number
  status: string
  bucket: 'needs_me' | 'in_progress' | 'ideas' | 'history'
  evidence: readonly { label: string; url?: string }[]
  permitted: readonly string[]
  excluded: readonly string[]
  nextAction: string
  owner: string
  decision: string
  snoozedUntil?: string
  previews: readonly { label: string; url?: string }[]
  discussion: readonly { id: string; author: string; body: string }[]
  actionable: boolean
  readOnlyReason?: string
  preparationStatus?: string
  executionAcknowledgedAt?: string
  decisionHistory?: readonly { id: string; action: string; revision: number; actor: string; reason: string; createdAt: string; scope: string; snoozedUntil: string | null }[]
}
export type WorkDecision = 'approve_preparation' | 'request_changes' | 'snooze' | 'decline'
export interface WorkDecisionInput { action: WorkDecision; comment?: string; snoozedUntil?: string }
export interface WorkInboxProps {
  items: readonly WorkCardView[]
  selected: WorkCardView | null
  status: 'loading' | 'verified' | 'unsupported' | 'offline' | 'error'
  pending: boolean
  message: string | null
  onRefresh: () => void
  onOpen: (profile: string, id: string) => void
  onClose: () => void
  onDecision: (input: WorkDecisionInput) => Promise<boolean>
  onComment: (body: string) => Promise<boolean>
}

export function safeWorkUrl(value?: string): string | undefined {
  if (!value) {return undefined}

  try {
    const url = new URL(value)

    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined
  } catch {return undefined}
}

function WorkLinks({ links }: { links: WorkCardView['evidence'] }) {
  return <ul>{links.map((link, index) => {
    const url = safeWorkUrl(link.url)

    return <li key={index}>{url ? <a href={url} rel="noopener noreferrer" target="_blank">{link.label} ↗</a> : <span>{link.label}</span>}</li>
  })}</ul>
}

export function WorkInbox(props: WorkInboxProps) {
  const [filter, setFilter] = useState<WorkCardView['bucket']>('needs_me')
  const [history, setHistory] = useState(false)
  const visible = props.items.filter((item) => item.bucket === (history ? 'history' : filter))

  return <section aria-labelledby="work-title" className="work-inbox">
    <div className="section-heading"><div><p className="kicker">Persisted business work</p><h2 id="work-title">Decision inbox</h2></div><button disabled={props.status === 'loading' || props.pending} onClick={props.onRefresh} type="button">Refresh work</button></div>
    <p>Ideas, preparation decisions and focused discussion, shared across your devices. Separate from runtime tool permissions.</p>
    {props.status === 'unsupported' && <p role="status">This gateway does not support the durable work inbox. Upgrade the server to use business decisions; runtime attention remains available below.</p>}
    {props.status === 'loading' && <p role="status">Verifying persisted work… Decisions are disabled until refreshed.</p>}
    {(props.status === 'offline' || props.status === 'error') && <p role="alert">Work could not be verified. The last view is retained; reconnect and refresh before making decisions.</p>}
    {props.message && <p role="status">{props.message}</p>}
    <div aria-label="Work filters" className="work-filters" role="group">
      {([['needs_me', 'Needs Me'], ['in_progress', 'In Progress'], ['ideas', 'Ideas']] as const).map(([id, label]) => <button aria-pressed={!history && filter === id} disabled={props.pending} key={id} onClick={() => {setFilter(id); setHistory(false);

 if (props.selected) {props.onClose()}}} type="button">{label}</button>)}
      <button aria-pressed={history} disabled={props.pending} onClick={() => {setHistory(!history);

 if (props.selected) {props.onClose()}}} type="button">History &amp; snoozed</button>
    </div>
    {props.selected ? <WorkDetail key={`${props.selected.profile}:${props.selected.id}`} {...props} item={props.selected} /> : <div className="work-list">
      {visible.map((item) => <button className="work-summary" disabled={props.status !== 'verified' || props.pending} key={`${item.profile}:${item.id}`} onClick={() => props.onOpen(item.profile, item.id)} type="button"><span className="label">{item.profile} · {item.status} · Revision {item.revision}</span><strong>{item.title}</strong><span>{item.brief}</span><small>{item.owner}: {item.nextAction}</small>{item.preparationStatus && <small>{item.preparationStatus}</small>}</button>)}
      {props.status === 'verified' && visible.length === 0 && <p>No work in this view. Completed, declined and snoozed work remains in history.</p>}
    </div>}
  </section>
}

function WorkDetail({ item, status, pending, onClose, onDecision, onComment }: WorkInboxProps & { item: WorkCardView }) {
  const [comment, setComment] = useState('')
  const [snooze, setSnooze] = useState('')
  const [validation, setValidation] = useState('')
  const verified = status === 'verified' && !pending
  const enabled = verified && item.actionable

  const decide = async (action: WorkDecision) => {
    if (!enabled) {return}

    if (action === 'request_changes' && !comment.trim()) {setValidation('Describe the changes you need in the discussion field.');

 return}

    if (action === 'snooze' && (!snooze || !Number.isFinite(new Date(snooze).getTime()) || new Date(snooze).getTime() <= Date.now())) {setValidation('Choose a future snooze date.');

 return}

    setValidation('')

    if (await onDecision({ action, ...(comment.trim() ? { comment: comment.trim() } : {}), ...(action === 'snooze' ? { snoozedUntil: new Date(snooze).toISOString() } : {}) })) {setComment('')}
  }

  return <article aria-labelledby="work-detail-title" className="work-detail">
    <button disabled={pending} onClick={onClose} type="button">Back to work</button>
    <p className="label">{item.profile} · {item.status} · Revision {item.revision}</p>
    <h3 id="work-detail-title">{item.title}</h3><p className="work-plain-text">{item.brief}</p>
    <dl><dt>Next action</dt><dd>{item.nextAction || 'Not specified'}</dd><dt>Owner</dt><dd>{item.owner || 'Unassigned'}</dd><dt>Current decision</dt><dd>{item.decision || 'No decision yet'}</dd>{item.snoozedUntil && <><dt>Snoozed until</dt><dd>{item.snoozedUntil}</dd></>}</dl>
    {item.preparationStatus && <p className="work-boundary">{item.preparationStatus}</p>}
    {item.executionAcknowledgedAt && <p>Tracker handoff acknowledged: {item.executionAcknowledgedAt}</p>}
    <h4>Evidence</h4><WorkLinks links={item.evidence} />
    <div className="work-scope"><section><h4>Proposed preparation scope</h4><ul>{item.permitted.map((text, i) => <li key={i}>{text}</li>)}</ul></section><section><h4>Excluded scope</h4><ul>{item.excluded.map((text, i) => <li key={i}>{text}</li>)}</ul></section></div>
    <h4>Previews &amp; links</h4><WorkLinks links={item.previews} />
    <p className="work-boundary">Approval authorizes preparation only. It never authorizes publishing, sending, spending, or permanent tool permissions.</p>
    <h4>Decision history</h4>
    {item.decisionHistory?.length ? <ol className="work-discussion">{item.decisionHistory.map((entry) => <li key={entry.id}><strong>{entry.action.replaceAll('_', ' ')} · Revision {entry.revision}</strong><p>{entry.actor} · {entry.createdAt} · Scope: {entry.scope.replaceAll('_', ' ')}</p>{entry.reason && <p className="work-plain-text">{entry.reason}</p>}{entry.snoozedUntil && <p>Snoozed until: {entry.snoozedUntil}</p>}</li>)}</ol> : <p>No recorded decisions.</p>}
    <h4>Focused discussion</h4>
    <p>Comments are not approval. The server assigns the author; shared-token connections comment as an agent, not an authenticated human.</p>
    <ol className="work-discussion">{item.discussion.map((entry) => <li key={entry.id}><strong>{entry.author}</strong><p className="work-plain-text">{entry.body}</p></li>)}</ol>
    <label htmlFor="work-comment">Discussion / requested changes</label><textarea disabled={!verified} id="work-comment" onChange={(event) => setComment(event.target.value)} rows={3} value={comment} />
    <button disabled={!verified || !comment.trim()} onClick={() => void onComment(comment.trim()).then((saved) => {if (saved) {setComment('')}})} type="button">Add comment</button>
    {validation && <p role="alert">{validation}</p>}
    <fieldset disabled={!enabled}><legend>Decision for revision {item.revision}</legend><div className="work-actions"><button className="primary-button" onClick={() => void decide('approve_preparation')} type="button">Approve preparation</button><button onClick={() => void decide('request_changes')} type="button">Request changes</button><button onClick={() => void decide('decline')} type="button">Decline</button></div><label htmlFor="work-snooze">Snooze until</label><input id="work-snooze" onChange={(event) => setSnooze(event.target.value)} type="datetime-local" value={snooze} /><button onClick={() => void decide('snooze')} type="button">Snooze</button></fieldset>
    {pending && <p role="status">Saving and verifying…</p>}
    {!item.actionable && <p>{item.readOnlyReason || 'This work is read-only in its current state.'}</p>}
  </article>
}
