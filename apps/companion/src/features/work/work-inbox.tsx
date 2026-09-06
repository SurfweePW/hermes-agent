import './work.css'

import { useState } from 'react'

import type { NeedsMePriorityItem } from '../../gateway/organization-types'
import type { TrackerEvidence } from '../../gateway/work-types'

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
  trackerEvidence?: TrackerEvidence
  completionEvidence?: readonly string[]
  trackerStatusHistory?: readonly TrackerEvidence[]
  priority?: NeedsMePriorityItem & { topicName: string; topicCollection?: string; groupOrder: number; itemOrder: number }
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
  groupBy: 'topic' | 'session' | 'project'
  sources: readonly { profile: string; incomplete: boolean; status: 'verified' | 'unsupported' | 'error'; lastSuccess: string | null; message: string | null }[]
  onRefresh: () => void
  onGroupBy: (groupBy: 'topic' | 'session' | 'project') => void
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

function TrackerStatus({ evidence, heading }: { evidence: TrackerEvidence; heading?: string }) {
  return <section className="work-tracker-status">{heading && <h4>{heading}</h4>}<p><strong>{evidence.state.replaceAll('_', ' ')}</strong> · Observed {evidence.observed_at}</p>{evidence.blocker && <p><strong>Blocker:</strong> {evidence.blocker}</p>}{evidence.result_evidence?.length ? <p><strong>Result:</strong> {evidence.result_evidence.join(' · ')}</p> : null}<WorkLinks links={evidence.evidence.map((label) => ({ label, url: label }))} /></section>
}

export function WorkInbox(props: WorkInboxProps) {
  const [filter, setFilter] = useState<WorkCardView['bucket']>('needs_me')
  const [history, setHistory] = useState(false)

  const visible = props.items.filter((item) => item.bucket === (history ? 'history' : filter)).sort((left, right) => {
    if (!history && filter === 'needs_me') {
      const priority = (left.priority?.groupOrder ?? Number.MAX_SAFE_INTEGER) - (right.priority?.groupOrder ?? Number.MAX_SAFE_INTEGER)

      if (priority) {return priority}
      const item = (left.priority?.itemOrder ?? Number.MAX_SAFE_INTEGER) - (right.priority?.itemOrder ?? Number.MAX_SAFE_INTEGER)

      if (item) {return item}
    }

    return `${left.profile}:${left.id}`.localeCompare(`${right.profile}:${right.id}`)
  })

  return <section aria-labelledby="work-title" className="work-inbox">
    <div className="section-heading"><div><p className="kicker">Persisted business work</p><h2 id="work-title">Decision inbox</h2></div><button disabled={props.status === 'loading' || props.pending} onClick={props.onRefresh} type="button">Refresh work</button></div>
    <p>Ideas, preparation decisions and focused discussion, shared across your devices. Separate from runtime tool permissions.</p>
    {props.status === 'unsupported' && <p role="status">This gateway does not support the durable work inbox. Upgrade the server to use business decisions; runtime attention remains available below.</p>}
    {props.status === 'loading' && <p role="status">Verifying persisted work… Decisions are disabled until refreshed.</p>}
    {(props.status === 'offline' || props.status === 'error') && <p role="alert">Work could not be verified. The last view is retained; reconnect and refresh before making decisions.</p>}
    {props.message && <p role="status">{props.message}</p>}
    {props.sources.some((source) => source.incomplete) && <ul aria-label="Work source coverage" className="work-source-coverage">{props.sources.map((source) => <li key={source.profile}><strong>{source.profile}</strong>: {source.incomplete ? `Incomplete (${source.status})` : 'Complete'} · Last success: {source.lastSuccess ?? 'never'}{source.message ? ` · ${source.message}` : ''}</li>)}</ul>}
    <label htmlFor="needs-me-group">Group by</label><select disabled={props.pending} id="needs-me-group" onChange={(event) => props.onGroupBy(event.target.value as WorkInboxProps['groupBy'])} value={props.groupBy}><option value="topic">Topic</option><option value="session">Session</option><option value="project">Project</option></select>
    <div aria-label="Work filters" className="work-filters" role="group">
      {([['needs_me', 'Needs Me'], ['in_progress', 'In Progress'], ['ideas', 'Ideas']] as const).map(([id, label]) => <button aria-pressed={!history && filter === id} disabled={props.pending} key={id} onClick={() => {setFilter(id); setHistory(false);

 if (props.selected) {props.onClose()}}} type="button">{label}</button>)}
      <button aria-pressed={history} disabled={props.pending} onClick={() => {setHistory(!history);

 if (props.selected) {props.onClose()}}} type="button">History &amp; snoozed</button>
    </div>
    {props.selected ? <WorkDetail key={`${props.selected.profile}:${props.selected.id}`} {...props} item={props.selected} /> : <div className="work-list">
      {visible.map((item, index) => <div className="work-priority-row" key={`${item.profile}:${item.id}`}>
        {!history && filter === 'needs_me' && item.priority && (index === 0 || visible[index - 1]?.priority?.groupOrder !== item.priority.groupOrder) && <header className="work-topic-heading">
          <p className="kicker">{props.groupBy[0].toUpperCase() + props.groupBy.slice(1)}{item.priority.topicCollection ? ` · ${item.priority.topicCollection}` : ''}</p>
          <h3>{item.priority.topicName}</h3>
          <p>Recommended · {item.priority.eligibility.replaceAll('_', ' ')}</p>
        </header>}
        <button className="work-summary" disabled={props.status !== 'verified' || props.pending} onClick={() => props.onOpen(item.profile, item.id)} type="button">
          <span className="label">{item.profile} · {item.status} · Revision {item.revision}</span>
          <strong>{item.title}</strong><span>{item.brief}</span>
          {item.priority && <>
            <small><strong>Why here:</strong> {item.priority.why_here}</small>
            <small><strong>Next step:</strong> {item.priority.next_step}</small>
            <small><strong>Trade-off:</strong> {item.priority.trade_off}</small>
            <small><strong>Assessment freshness:</strong> {item.priority.assessed_at ?? 'Not assessed'}</small>
            <small><strong>Recommendation evidence:</strong> {item.priority.evidence.length ? item.priority.evidence.join(' · ') : 'No evidence supplied'}</small>
            <small>Benefit {item.priority.assessment?.benefit ?? 'unassessed'} · Confidence {item.priority.assessment?.confidence ?? 'unknown'}</small>
            {item.priority.override && <small className="work-override">{item.priority.override.active ? 'Active review override' : 'Review override'}: {item.priority.override.label} — {item.priority.override.reason}</small>}
          </>}
          <small>{item.owner}: {item.nextAction}</small>
          {item.preparationStatus && <small>{item.preparationStatus}</small>}
        </button>
      </div>)}
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
    {item.trackerEvidence && <TrackerStatus evidence={item.trackerEvidence} heading="Current tracker evidence" />}
    {item.completionEvidence?.length ? <><h4>Completion evidence</h4><WorkLinks links={item.completionEvidence.map((label) => ({ label, url: label }))} /></> : null}
    <h4>Tracker status history</h4>
    {item.trackerStatusHistory?.length ? <ol className="work-discussion">{item.trackerStatusHistory.map((entry, index) => <li key={`${entry.observed_at}:${index}`}><TrackerStatus evidence={entry} /></li>)}</ol> : <p>No recorded tracker status.</p>}
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
