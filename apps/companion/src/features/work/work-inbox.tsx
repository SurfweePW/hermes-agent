import './work.css'

import { useState } from 'react'

import type { NeedsMePriorityItem } from '../../gateway/organization-types'
import type { TrackerEvidence, WorkDecisionOption } from '../../gateway/work-types'

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
  recommendedAction: WorkDecisionOption
  snoozedUntil?: string
  previews: readonly { label: string; url?: string }[]
  discussion: readonly { id: string; author: string; body: string }[]
  actionable: boolean
  attentionKey?: string
  attentionDue?: boolean
  sourceSession?: { backend: string; profile: string; id: string }
  readOnlyReason?: string
  canDecide: boolean
  preparationStatus?: string
  executionAcknowledgedAt?: string
  trackerEvidence?: TrackerEvidence
  completionEvidence?: readonly string[]
  trackerStatusHistory?: readonly TrackerEvidence[]
  priority?: NeedsMePriorityItem & {
    topicName: string
    topicCollection?: string
    group: { kind: 'topic' | 'session' | 'project'; id: string; source_id?: string; profile: string; backend_namespace: string }
    groupOrder: number
    itemOrder: number
  }
  decisionHistory?: readonly { id: string; action: string; revision: number; actor: string; reason: string; createdAt: string; scope: string; snoozedUntil: string | null }[]
}
export type WorkDecision = WorkDecisionOption
export interface WorkDecisionInput { action: WorkDecision; comment?: string }
export interface WorkPriorityInput { label: string; reason: string; expiresAt: string }
export interface WorkInboxProps {
  items: readonly WorkCardView[]
  selected: WorkCardView | null
  status: 'loading' | 'verified' | 'unsupported' | 'offline' | 'error'
  pending: boolean
  message: string | null
  groupBy: 'topic' | 'session' | 'project'
  priorityWritable: boolean
  sources: readonly { profile: string; incomplete: boolean; status: 'verified' | 'unsupported' | 'error'; lastSuccess: string | null; message: string | null }[]
  onRefresh: () => void
  onGroupBy: (groupBy: 'topic' | 'session' | 'project') => void
  onOpen: (profile: string, id: string) => void
  onOpenArtifact: (profile: string, reference: string) => void
  onOpenProject?: (project: { source_id: string; profile: string; backend_namespace: string }) => void
  onOpenSourceSession?: (source: NonNullable<WorkCardView['sourceSession']>) => void
  onClose: () => void
  onDecision: (input: WorkDecisionInput) => Promise<boolean>
  onComment: (body: string) => Promise<boolean>
  onPriority: (input: WorkPriorityInput) => Promise<boolean>
  onRestorePriority: () => Promise<boolean>
}

export function safeWorkUrl(value?: string): string | undefined {
  if (!value) {return undefined}

  try {
    const url = new URL(value)

    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined
  } catch {return undefined}
}

interface StructuredWorkBrief {
  evidenceSummary?: string
  inference?: string
  decisionScope?: string
  costBoundary?: string
  scopeBoundary?: string
  forbiddenActions: string[]
  artifacts: { path: string; sha256?: string }[]
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined

export function parseWorkBrief(value: string): StructuredWorkBrief | null {
  let parsed: unknown

  try {parsed = JSON.parse(value)} catch {return null}

  if (!record(parsed)) {return null}
  const evidenceSummary = text(parsed.evidence_summary)
  const inference = text(parsed.inference)
  const decisionScope = text(parsed.decision_scope)
  const costBoundary = text(parsed.cost_boundary)
  const scopeBoundary = text(parsed.scope_boundary)
  const forbiddenActions = Array.isArray(parsed.forbidden_actions) ? parsed.forbidden_actions.map(text).filter((entry): entry is string => Boolean(entry)) : []

  const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts.flatMap((entry) => {
    if (!record(entry)) {return []}
    const path = text(entry.path)

    return path ? [{ path, ...(text(entry.sha256) ? { sha256: text(entry.sha256) } : {}) }] : []
  }) : []

  if (!evidenceSummary && !inference && !decisionScope && !costBoundary && !scopeBoundary && !forbiddenActions.length && !artifacts.length) {return null}

  return { evidenceSummary, inference, decisionScope, costBoundary, scopeBoundary, forbiddenActions, artifacts }
}

function workBriefSummary(value: string): string {
  const brief = parseWorkBrief(value)

  return brief?.evidenceSummary ?? brief?.inference ?? value
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)

    return code < 32 || code === 127
  })
}

export function safeLibraryReference(value?: string): string | undefined {
  if (!value || !value.startsWith('library:') || value.length > 1_000 || hasControlCharacters(value)) {return undefined}
  const reference = value.slice('library:'.length)

  if (!reference || reference.includes('\\') || reference.startsWith('/') || reference.includes('?') || reference.includes('#')
    || reference.includes('%') || /^[a-z][a-z0-9+.-]*:/i.test(reference)) {return undefined}

  const parts = reference.split('/')
  const filename = parts.at(-1) ?? ''

  return parts.every((part) => part && part !== '.' && part !== '..')
    && (parts.length > 1 || (filename.includes('.') && !filename.startsWith('.'))) ? value : undefined
}

function safeArtifactLabel(value: string): string {
  if (safeLibraryReference(value) || safeWorkUrl(value)) {return value}
  if (/^(?:file:|[a-z]:[\\/]|[\\/])/i.test(value) || value.includes('/') || value.includes('\\')
    || /^\.?[^\s/\\]+\.[a-z0-9]{1,12}$/i.test(value.trim())) {return 'Unverified file reference'}

  return value
}

function artifactKind(value: string): string {
  const extension = value.split(/[?#]/, 1)[0].split('.').at(-1)?.toLocaleLowerCase()

  return ({
    md: 'Markdown report', markdown: 'Markdown report', pdf: 'PDF report', json: 'Data file', csv: 'Spreadsheet data',
    xlsx: 'Spreadsheet', png: 'Image asset', jpg: 'Image asset', jpeg: 'Image asset', webp: 'Image asset', gif: 'Image asset',
    svg: 'Image asset', mp4: 'Video asset', mov: 'Video asset', mp3: 'Audio asset', wav: 'Audio asset', html: 'HTML report', htm: 'HTML report'
  } as Record<string, string>)[extension ?? ''] ?? 'File'
}

function WorkLinks({ links, profile, onOpenArtifact }: { links: WorkCardView['evidence']; profile: string; onOpenArtifact: WorkInboxProps['onOpenArtifact'] }) {
  return <ul>{links.map((link, index) => {
    const url = safeWorkUrl(link.url)
    const reference = safeLibraryReference(link.url)
    const label = safeArtifactLabel(link.label)

    return <li className="work-file" key={index}><span><strong>{artifactKind(label)}</strong><span>{label}</span></span>{url
      ? <a aria-label={`Open ${label}`} href={url} rel="noopener noreferrer" target="_blank">Open source ↗</a>
      : reference
        ? <button aria-label={`Open ${label} in Library`} onClick={() => onOpenArtifact(profile, reference)} type="button">Open in Library</button>
        : null}</li>
  })}</ul>
}

function TrackerStatus({ evidence, heading, profile, onOpenArtifact }: { evidence: TrackerEvidence; heading?: string; profile: string; onOpenArtifact: WorkInboxProps['onOpenArtifact'] }) {
  return <section className="work-tracker-status">{heading && <h4>{heading}</h4>}<p><strong>{evidence.state.replaceAll('_', ' ')}</strong> · Observed {evidence.observed_at}</p>{evidence.blocker && <p><strong>Blocker:</strong> {evidence.blocker}</p>}{evidence.result_evidence?.length ? <p><strong>Result:</strong> {evidence.result_evidence.map(safeArtifactLabel).join(' · ')}</p> : null}<WorkLinks links={evidence.evidence.map((label) => ({ label, url: label }))} onOpenArtifact={onOpenArtifact} profile={profile} /></section>
}

function WorkBrief({ value, profile, onOpenArtifact, showInference = true }: { value: string; profile: string; onOpenArtifact: WorkInboxProps['onOpenArtifact']; showInference?: boolean }) {
  const brief = parseWorkBrief(value)

  if (!brief) {return <section className="work-brief"><h4>What this is about</h4><p className="work-plain-text">{value}</p></section>}

  return <section className="work-brief">
    <h4>What this is about</h4>
    <p>{brief.evidenceSummary ?? 'This is a structured preparation request.'}</p>
    {brief.decisionScope && <p><strong>Decision scope:</strong> {brief.decisionScope.replaceAll('_', ' ')}</p>}
    {showInference && brief.inference && <><h4>Why it is being proposed</h4><p>{brief.inference}</p></>}
    {(brief.scopeBoundary || brief.costBoundary) && <div className="work-boundary-grid">
      {brief.scopeBoundary && <section><strong>Authorized scope</strong><p>{brief.scopeBoundary}</p></section>}
      {brief.costBoundary && <section><strong>Cost and activation boundary</strong><p>{brief.costBoundary}</p></section>}
    </div>}
    {brief.forbiddenActions.length > 0 && <section className="work-not-authorized"><strong>Not authorized by this decision</strong><ul>{brief.forbiddenActions.map((action) => <li key={action}>{action.replaceAll('_', ' ')}</li>)}</ul></section>}
    {brief.artifacts.length > 0 && <><h4>Files named in this brief</h4><ul>{brief.artifacts.map((artifact) => {
      const reference = safeLibraryReference(artifact.path)
      const label = safeArtifactLabel(artifact.path)

      return <li className="work-file" key={artifact.path}><span><strong>{artifactKind(label)}</strong><span>{label}</span>{artifact.sha256 && <small>SHA-256: {artifact.sha256}</small>}</span>{reference && <button aria-label={`Open ${label} in Library`} onClick={() => onOpenArtifact(profile, reference)} type="button">Open in Library</button>}</li>
    })}</ul></>}
  </section>
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
    <div className="section-heading"><div><p className="kicker">Persisted business work</p><h2 id="work-title">Do decyzji</h2></div><button disabled={props.status === 'loading' || props.pending} onClick={props.onRefresh} type="button">Refresh work</button></div>
    <p>Ideas, preparation decisions and focused discussion, shared across your devices. Separate from runtime tool permissions.</p>
    {props.status === 'unsupported' && <p role="status">This gateway does not support the durable work inbox. Upgrade the server to use business decisions; runtime attention remains available below.</p>}
    {props.status === 'loading' && <p role="status">Verifying persisted work… Decisions are disabled until refreshed.</p>}
    {(props.status === 'offline' || props.status === 'error') && <p role="alert">Work could not be verified. The last view is retained; reconnect and refresh before making decisions.</p>}
    {props.message && <p role="status">{props.message}</p>}
    {props.sources.some((source) => source.incomplete) && <details className="work-source-coverage-panel"><summary>{props.sources.filter((source) => source.incomplete).length} of {props.sources.length} work sources incomplete</summary><ul aria-label="Work source coverage" className="work-source-coverage">{props.sources.map((source) => <li key={source.profile}><strong>{source.profile}</strong>: {source.incomplete ? `Incomplete (${source.status})` : 'Complete'} · Last success: {source.lastSuccess ?? 'never'}{source.message ? ` · ${source.message}` : ''}</li>)}</ul></details>}
    <details className="work-source-coverage-panel"><summary>Opcje widoku</summary>
      <div className="work-group-control"><label htmlFor="needs-me-group">Group by</label><select disabled={props.pending} id="needs-me-group" onChange={(event) => props.onGroupBy(event.target.value as WorkInboxProps['groupBy'])} value={props.groupBy}><option value="topic">Topic</option><option value="session">Session</option><option value="project">Project</option></select></div>
      <div aria-label="Work filters" className="work-filters" role="group">
      {([['needs_me', 'Do decyzji'], ['in_progress', 'W toku'], ['ideas', 'Pomysły']] as const).map(([id, label]) => <button aria-pressed={!history && filter === id} disabled={props.pending} key={id} onClick={() => {setFilter(id); setHistory(false);

 if (props.selected) {props.onClose()}}} type="button">{label}</button>)}
      <button aria-pressed={history} disabled={props.pending} onClick={() => {setHistory(!history);

 if (props.selected) {props.onClose()}}} type="button">Historia i odłożone</button>
      </div>
    </details>
    {props.selected ? <WorkDetail key={`${props.selected.profile}:${props.selected.id}`} {...props} item={props.selected} /> : <div className="work-list">
      {visible.map((item, index) => <div className="work-priority-row" key={`${item.profile}:${item.id}`}>
        {!history && filter === 'needs_me' && item.priority && (index === 0 || visible[index - 1]?.priority?.groupOrder !== item.priority.groupOrder) && <header className="work-topic-heading">
          <p className="kicker">{item.priority.group.kind[0].toUpperCase() + item.priority.group.kind.slice(1)}{item.priority.topicCollection ? ` · ${item.priority.topicCollection}` : ''}</p>
          <h3>{item.priority.topicName}</h3>
          <p>Recommended · {item.priority.eligibility.replaceAll('_', ' ')}</p>
        </header>}
        <button className="work-summary" disabled={props.status !== 'verified' || props.pending} onClick={() => props.onOpen(item.profile, item.id)} type="button">
          <span className="label">{item.profile} · {item.status} · Revision {item.revision}</span>
          <strong>{item.title}</strong><span>{workBriefSummary(item.brief)}</span>
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

function WorkDetail({ item, status, pending, priorityWritable, onClose, onDecision, onComment, onPriority, onRestorePriority, onOpenArtifact, onOpenProject, onOpenSourceSession }: WorkInboxProps & { item: WorkCardView }) {
  const [comment, setComment] = useState('')
  const [validation, setValidation] = useState('')
  const [priorityLabel, setPriorityLabel] = useState(item.priority?.override?.label ?? '')
  const [priorityReason, setPriorityReason] = useState(item.priority?.override?.reason ?? '')
  const [priorityExpiry, setPriorityExpiry] = useState('')
  const verified = status === 'verified' && !pending
  const enabled = verified && item.actionable
  const brief = parseWorkBrief(item.brief)
  const priorityExpiryValid = Boolean(priorityExpiry && Number.isFinite(new Date(priorityExpiry).getTime()) && new Date(priorityExpiry).getTime() > Date.now())

  const decide = async (action: WorkDecision) => {
    if (!enabled) {return}

    if (action === 'request_changes' && !comment.trim()) {setValidation('Describe the changes you need in the discussion field.');

 return}

    setValidation('')

    if (await onDecision({ action, ...(comment.trim() ? { comment: comment.trim() } : {}) })) {setComment('')}
  }

  return <article aria-labelledby="work-detail-title" className="work-detail">
    <button disabled={pending} onClick={onClose} type="button">Back to work</button>
    <p className="label">{item.profile} · {item.status} · Revision {item.revision}</p>
    <h3 id="work-detail-title">{item.title}</h3>
    <section aria-labelledby="work-decision-request-title" className="work-decision-request"><p className="kicker">Decyzja biznesowa</p><h4 id="work-decision-request-title">Czego potrzebujemy od Ciebie</h4><p>{item.nextAction || 'Nie określono oczekiwanej decyzji.'}</p></section>
    <section><h4>Dlaczego teraz</h4><p>{item.priority?.why_here ?? brief?.inference ?? workBriefSummary(item.brief)}</p></section>
    <section><h4>Rekomendacja</h4><p><strong>Server recommendation:</strong> {{ approve_preparation: 'Approve', request_changes: 'Request changes', remind_in_2_hours: 'Remind in 2 hours' }[item.recommendedAction]}</p>{item.priority && <p><strong>Kontekst priorytetu:</strong> {item.priority.next_step} · {item.priority.trade_off}</p>}</section>
    <section className="work-boundary"><h4>Co zmieni kliknięcie</h4><ul>
      <li><strong>Approve</strong> autoryzuje wyłącznie przygotowanie tej rewizji; nie publikuje, nie wysyła, nie wydaje pieniędzy i nie zmienia systemu produkcyjnego.</li>
      <li><strong>Request changes</strong> zapisuje żądane poprawki i nie publikuje ani nie autoryzuje wykonania.</li>
      <li><strong>Remind in 2 hours</strong> odkłada decyzję do terminu; gdy termin nadejdzie, wraca ona do decyzji.</li>
    </ul></section>
    {item.priority?.group.kind === 'project' && item.priority.group.source_id && onOpenProject ? <button onClick={() => onOpenProject({ source_id: item.priority!.group.source_id!, profile: item.priority!.group.profile, backend_namespace: item.priority!.group.backend_namespace })} type="button">Otwórz projekt</button> : null}
    {item.sourceSession && onOpenSourceSession ? <button onClick={() => onOpenSourceSession(item.sourceSession!)} type="button">Otwórz sesję źródłową</button> : <p>Sesja źródłowa nie jest powiązana z tym rekordem.</p>}
    <WorkBrief onOpenArtifact={onOpenArtifact} profile={item.profile} showInference={false} value={item.brief} />
    <dl><dt>Owner</dt><dd>{item.owner || 'Unassigned'}</dd><dt>Current decision</dt><dd>{item.decision || 'No decision yet'}</dd>{item.snoozedUntil && <><dt>Snoozed until</dt><dd>{item.snoozedUntil}</dd></>}</dl>
    {item.preparationStatus && <p className="work-boundary">{item.preparationStatus}</p>}
    {item.priority && <section aria-labelledby="priority-control-title" className="work-priority-control">
      <h4 id="priority-control-title">Priority override</h4>
      <p>Recommended order remains stable while this card is open. The verified order is applied when you return to the list.</p>
      <label htmlFor="work-priority-label">Priority label</label><input disabled={!verified || !priorityWritable} id="work-priority-label" onChange={(event) => setPriorityLabel(event.target.value)} value={priorityLabel} />
      <label htmlFor="work-priority-reason">Reason</label><textarea disabled={!verified || !priorityWritable} id="work-priority-reason" onChange={(event) => setPriorityReason(event.target.value)} rows={2} value={priorityReason} />
      <label htmlFor="work-priority-expiry">Expires at (required)</label><input aria-describedby="work-priority-expiry-help" disabled={!verified || !priorityWritable} id="work-priority-expiry" onChange={(event) => setPriorityExpiry(event.target.value)} required type="datetime-local" value={priorityExpiry} />
      <small id="work-priority-expiry-help">{priorityExpiry ? 'Choose a future expiration for this override.' : 'Choose when this override expires.'}</small>
      <div className="work-actions"><button disabled={!verified || !priorityWritable || !priorityLabel.trim() || !priorityReason.trim() || !priorityExpiryValid} onClick={() => void onPriority({ label: priorityLabel.trim(), reason: priorityReason.trim(), expiresAt: new Date(priorityExpiry).toISOString() })} type="button">Set priority</button>
        <button disabled={!verified || !priorityWritable || !item.priority.override?.active || !item.priority.override.version} onClick={() => void onRestorePriority()} type="button">Restore recommended</button></div>
      {!priorityWritable && <p>Priority changes require an owner-authenticated connection and a compatible gateway.</p>}
    </section>}
    {item.executionAcknowledgedAt && <p>Tracker handoff acknowledged: {item.executionAcknowledgedAt}</p>}
    {item.trackerEvidence && <TrackerStatus evidence={item.trackerEvidence} heading="Current tracker evidence" onOpenArtifact={onOpenArtifact} profile={item.profile} />}
    {item.completionEvidence?.length ? <><h4>Completion evidence</h4><WorkLinks links={item.completionEvidence.map((label) => ({ label, url: label }))} onOpenArtifact={onOpenArtifact} profile={item.profile} /></> : null}
    <h4>Tracker status history</h4>
    {item.trackerStatusHistory?.length ? <ol className="work-discussion">{item.trackerStatusHistory.map((entry, index) => <li key={`${entry.observed_at}:${index}`}><TrackerStatus evidence={entry} onOpenArtifact={onOpenArtifact} profile={item.profile} /></li>)}</ol> : <p>No recorded tracker status.</p>}
    <h4>Evidence, files &amp; reports</h4>{item.evidence.length ? <WorkLinks links={item.evidence} onOpenArtifact={onOpenArtifact} profile={item.profile} /> : <p>No supporting files or links were supplied.</p>}
    <div className="work-scope"><section><h4>Proposed preparation scope</h4><ul>{item.permitted.map((text, i) => <li key={i}>{text}</li>)}</ul></section><section><h4>Excluded scope</h4><ul>{item.excluded.map((text, i) => <li key={i}>{text}</li>)}</ul></section></div>
    <h4>Previews &amp; links</h4>{item.previews.length ? <WorkLinks links={item.previews} onOpenArtifact={onOpenArtifact} profile={item.profile} /> : <p>No additional previews or links were supplied.</p>}

    <h4>Decision history</h4>
    {item.decisionHistory?.length ? <ol className="work-discussion">{item.decisionHistory.map((entry) => <li key={entry.id}><strong>{entry.action.replaceAll('_', ' ')} · Revision {entry.revision}</strong><p>{entry.actor} · {entry.createdAt} · Scope: {entry.scope.replaceAll('_', ' ')}</p>{entry.reason && <p className="work-plain-text">{entry.reason}</p>}{entry.snoozedUntil && <p>Snoozed until: {entry.snoozedUntil}</p>}</li>)}</ol> : <p>No recorded decisions.</p>}
    <h4>Focused discussion</h4>
    <p>Comments are not approval. Only the currently verified owner can add them; shared-token and agent connections remain read-only.</p>
    <ol className="work-discussion">{item.discussion.map((entry) => <li key={entry.id}><strong>{entry.author}</strong><p className="work-plain-text">{entry.body}</p></li>)}</ol>
    <label htmlFor="work-comment">Discussion / requested changes</label><textarea disabled={!verified || !item.canDecide} id="work-comment" onChange={(event) => setComment(event.target.value)} rows={3} value={comment} />
    <button disabled={!verified || !item.canDecide || !comment.trim()} onClick={() => void onComment(comment.trim()).then((saved) => {if (saved) {setComment('')}})} type="button">Add comment</button>
    {validation && <p role="alert">{validation}</p>}
    <fieldset disabled={!enabled}><legend>Decision for revision {item.revision}</legend><div className="work-actions">{([
      ['approve_preparation', 'Approve'], ['request_changes', 'Request changes'], ['remind_in_2_hours', 'Remind in 2 hours']
    ] as const).map(([action, label]) => <button className={item.recommendedAction === action ? 'primary-button' : undefined} key={action} onClick={() => void decide(action)} type="button">{label}{item.recommendedAction === action && <strong aria-hidden="true"> · Recommended</strong>}</button>)}</div></fieldset>
    {pending && <p role="status">Saving and verifying…</p>}
    {!item.actionable && <p>{item.readOnlyReason || 'This work is read-only in its current state.'}</p>}
  </article>
}
