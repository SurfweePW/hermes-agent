import './work.css'

import { useState } from 'react'

import { workCopy } from '../../copy/work'
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
    || /^\.?[^\s/\\]+\.[a-z0-9]{1,12}$/i.test(value.trim())) {return workCopy.artifact.unverified}

  return value
}

function artifactKind(value: string): string {
  const extension = value.split(/[?#]/, 1)[0].split('.').at(-1)?.toLocaleLowerCase()

  return ({
    md: workCopy.artifact.markdown, markdown: workCopy.artifact.markdown, pdf: workCopy.artifact.pdf, json: workCopy.artifact.data, csv: workCopy.artifact.spreadsheetData,
    xlsx: workCopy.artifact.spreadsheet, png: workCopy.artifact.image, jpg: workCopy.artifact.image, jpeg: workCopy.artifact.image, webp: workCopy.artifact.image, gif: workCopy.artifact.image,
    svg: workCopy.artifact.image, mp4: workCopy.artifact.video, mov: workCopy.artifact.video, mp3: workCopy.artifact.audio, wav: workCopy.artifact.audio, html: workCopy.artifact.html, htm: workCopy.artifact.html
  } as Record<string, string>)[extension ?? ''] ?? workCopy.artifact.file
}

function WorkLinks({ links, profile, onOpenArtifact }: { links: WorkCardView['evidence']; profile: string; onOpenArtifact: WorkInboxProps['onOpenArtifact'] }) {
  return <ul>{links.map((link, index) => {
    const url = safeWorkUrl(link.url)
    const reference = safeLibraryReference(link.url)
    const label = safeArtifactLabel(link.label)

    return <li className="work-file" key={index}><span><strong>{artifactKind(label)}</strong><span>{label}</span></span>{url
      ? <a aria-label={workCopy.artifact.openLabel(label)} href={url} rel="noopener noreferrer" target="_blank">{workCopy.artifact.openSource}</a>
      : reference
        ? <button aria-label={workCopy.artifact.openInFilesLabel(label)} onClick={() => onOpenArtifact(profile, reference)} type="button">{workCopy.artifact.open}</button>
        : null}</li>
  })}</ul>
}

function TrackerStatus({ evidence, heading, profile, onOpenArtifact }: { evidence: TrackerEvidence; heading?: string; profile: string; onOpenArtifact: WorkInboxProps['onOpenArtifact'] }) {
  return <section className="work-tracker-status">{heading && <h4>{heading}</h4>}<p><strong>{evidence.state.replaceAll('_', ' ')}</strong> · {workCopy.tracker.observed} {evidence.observed_at}</p>{evidence.blocker && <p><strong>{workCopy.tracker.blocker}</strong> {evidence.blocker}</p>}{evidence.result_evidence?.length ? <p><strong>{workCopy.tracker.result}</strong> {evidence.result_evidence.map(safeArtifactLabel).join(' · ')}</p> : null}<WorkLinks links={evidence.evidence.map((label) => ({ label, url: label }))} onOpenArtifact={onOpenArtifact} profile={profile} /></section>
}

function WorkBrief({ value, profile, onOpenArtifact, showInference = true }: { value: string; profile: string; onOpenArtifact: WorkInboxProps['onOpenArtifact']; showInference?: boolean }) {
  const brief = parseWorkBrief(value)

  if (!brief) {return <section className="work-brief"><h4>{workCopy.brief.about}</h4><p className="work-plain-text">{value}</p></section>}

  return <section className="work-brief">
    <h4>{workCopy.brief.about}</h4>
    <p>{brief.evidenceSummary ?? workCopy.brief.fallback}</p>
    {brief.decisionScope && <p><strong>{workCopy.brief.decisionScope}</strong> {brief.decisionScope.replaceAll('_', ' ')}</p>}
    {showInference && brief.inference && <><h4>{workCopy.brief.proposedWhy}</h4><p>{brief.inference}</p></>}
    {(brief.scopeBoundary || brief.costBoundary) && <div className="work-boundary-grid">
      {brief.scopeBoundary && <section><strong>{workCopy.brief.authorizedScope}</strong><p>{brief.scopeBoundary}</p></section>}
      {brief.costBoundary && <section><strong>{workCopy.brief.costBoundary}</strong><p>{brief.costBoundary}</p></section>}
    </div>}
    {brief.forbiddenActions.length > 0 && <section className="work-not-authorized"><strong>{workCopy.brief.notAuthorized}</strong><ul>{brief.forbiddenActions.map((action) => <li key={action}>{action.replaceAll('_', ' ')}</li>)}</ul></section>}
    {brief.artifacts.length > 0 && <><h4>{workCopy.brief.files}</h4><ul>{brief.artifacts.map((artifact) => {
      const reference = safeLibraryReference(artifact.path)
      const label = safeArtifactLabel(artifact.path)

      return <li className="work-file" key={artifact.path}><span><strong>{artifactKind(label)}</strong><span>{label}</span>{artifact.sha256 && <small>SHA-256: {artifact.sha256}</small>}</span>{reference && <button aria-label={workCopy.artifact.openInFilesLabel(label)} onClick={() => onOpenArtifact(profile, reference)} type="button">{workCopy.artifact.open}</button>}</li>
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
    <div className="section-heading"><div><p className="kicker">{workCopy.chrome.kicker}</p><h2 id="work-title">{workCopy.chrome.title}</h2></div><button disabled={props.status === 'loading' || props.pending} onClick={props.onRefresh} type="button">{workCopy.chrome.refresh}</button></div>
    <p>{workCopy.chrome.lede}</p>
    {props.status === 'unsupported' && <p role="status">{workCopy.status.unsupported}</p>}
    {props.status === 'loading' && <p role="status">{workCopy.status.loading}</p>}
    {(props.status === 'offline' || props.status === 'error') && <p role="alert">{workCopy.status.unavailable}</p>}
    {props.message && <p role="status">{props.message}</p>}
    {props.sources.some((source) => source.incomplete) && <details className="work-source-coverage-panel"><summary>{workCopy.coverage.incomplete(props.sources.filter((source) => source.incomplete).length, props.sources.length)}</summary><ul aria-label={workCopy.coverage.label} className="work-source-coverage">{props.sources.map((source) => <li key={source.profile}><strong>{source.profile}</strong>: {source.incomplete ? workCopy.coverage.incompleteStatus(source.status) : workCopy.coverage.complete} · {workCopy.coverage.lastSuccess}: {source.lastSuccess ?? workCopy.coverage.never}{source.message ? ` · ${source.message}` : ''}</li>)}</ul></details>}
    <details className="work-source-coverage-panel"><summary>{workCopy.chrome.viewOptions}</summary>
      <div className="work-group-control"><label htmlFor="needs-me-group">{workCopy.group.label}</label><select disabled={props.pending} id="needs-me-group" onChange={(event) => props.onGroupBy(event.target.value as WorkInboxProps['groupBy'])} value={props.groupBy}><option value="topic">{workCopy.group.topic}</option><option value="session">{workCopy.group.session}</option><option value="project">{workCopy.group.project}</option></select></div>
      <div aria-label={workCopy.chrome.filtersLabel} className="work-filters" role="group">
      {([['needs_me', workCopy.filters.needsMe], ['in_progress', workCopy.filters.inProgress], ['ideas', workCopy.filters.ideas]] as const).map(([id, label]) => <button aria-pressed={!history && filter === id} disabled={props.pending} key={id} onClick={() => {setFilter(id); setHistory(false);

 if (props.selected) {props.onClose()}}} type="button">{label}</button>)}
      <button aria-pressed={history} disabled={props.pending} onClick={() => {setHistory(!history);

 if (props.selected) {props.onClose()}}} type="button">{workCopy.filters.history}</button>
      </div>
    </details>
    {props.selected ? <WorkDetail key={`${props.selected.profile}:${props.selected.id}`} {...props} item={props.selected} /> : <div className="work-list">
      {visible.map((item, index) => <div className="work-priority-row" key={`${item.profile}:${item.id}`}>
        {!history && filter === 'needs_me' && item.priority && (index === 0 || visible[index - 1]?.priority?.groupOrder !== item.priority.groupOrder) && <header className="work-topic-heading">
          <p className="kicker">{workCopy.group[item.priority.group.kind]}{item.priority.topicCollection ? ` · ${item.priority.topicCollection}` : ''}</p>
          <h3>{item.priority.topicName}</h3>
          <p>{workCopy.summary.recommended} · {item.priority.eligibility.replaceAll('_', ' ')}</p>
        </header>}
        <button className="work-summary" disabled={props.status !== 'verified' || props.pending} onClick={() => props.onOpen(item.profile, item.id)} type="button">
          <span className="label">{item.profile} · {item.status} · {workCopy.summary.revision} {item.revision}</span>
          <strong>{item.title}</strong><span>{workBriefSummary(item.brief)}</span>
          {item.priority && <>
            <small><strong>{workCopy.summary.whyHere}</strong> {item.priority.why_here}</small>
            <small><strong>{workCopy.summary.nextStep}</strong> {item.priority.next_step}</small>
            <small><strong>{workCopy.summary.tradeOff}</strong> {item.priority.trade_off}</small>
            <small><strong>{workCopy.summary.freshness}</strong> {item.priority.assessed_at ?? workCopy.summary.notAssessed}</small>
            <small><strong>{workCopy.summary.evidence}</strong> {item.priority.evidence.length ? item.priority.evidence.join(' · ') : workCopy.summary.noEvidence}</small>
            <small>{workCopy.summary.benefit} {item.priority.assessment?.benefit ?? workCopy.summary.unassessed} · {workCopy.summary.confidence} {item.priority.assessment?.confidence ?? workCopy.summary.unknown}</small>
            {item.priority.override && <small className="work-override">{item.priority.override.active ? workCopy.summary.activeOverride : workCopy.summary.reviewOverride}: {item.priority.override.label} — {item.priority.override.reason}</small>}
          </>}
          <small>{item.owner}: {item.nextAction}</small>
          {item.preparationStatus && <small>{item.preparationStatus}</small>}
        </button>
      </div>)}
      {props.status === 'verified' && visible.length === 0 && <p>{workCopy.summary.empty}</p>}
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

    if (action === 'request_changes' && !comment.trim()) {setValidation(workCopy.decisions.validation);

 return}

    setValidation('')

    if (await onDecision({ action, ...(comment.trim() ? { comment: comment.trim() } : {}) })) {setComment('')}
  }

  return <article aria-labelledby="work-detail-title" className="work-detail">
    <button disabled={pending} onClick={onClose} type="button">{workCopy.chrome.back}</button>
    <p className="label">{item.profile} · {item.status} · {workCopy.summary.revision} {item.revision}</p>
    <h3 id="work-detail-title">{item.title}</h3>
    <section aria-labelledby="work-decision-request-title" className="work-decision-request"><p className="kicker">{workCopy.detail.businessDecision}</p><h4 id="work-decision-request-title">{workCopy.detail.needed}</h4><p>{item.nextAction || workCopy.detail.neededFallback}</p></section>
    <section><h4>{workCopy.detail.whyNow}</h4><p>{item.priority?.why_here ?? brief?.inference ?? workBriefSummary(item.brief)}</p></section>
    <section><h4>{workCopy.detail.recommendation}</h4><p><strong>{workCopy.detail.serverRecommendation}</strong> {{ approve_preparation: workCopy.decisions.approve, request_changes: workCopy.decisions.requestChanges, remind_in_2_hours: workCopy.decisions.remind }[item.recommendedAction]}</p>{item.priority && <p><strong>{workCopy.detail.priorityContext}</strong> {item.priority.next_step} · {item.priority.trade_off}</p>}</section>
    <section className="work-boundary"><h4>{workCopy.detail.clickEffect}</h4><ul>
      <li><strong>{workCopy.decisions.approve}</strong> {workCopy.detail.approveEffect}</li>
      <li><strong>{workCopy.decisions.requestChanges}</strong> {workCopy.detail.changesEffect}</li>
      <li><strong>{workCopy.decisions.remind}</strong> {workCopy.detail.reminderEffect}</li>
    </ul></section>
    {item.priority?.group.kind === 'project' && item.priority.group.source_id && onOpenProject ? <button onClick={() => onOpenProject({ source_id: item.priority!.group.source_id!, profile: item.priority!.group.profile, backend_namespace: item.priority!.group.backend_namespace })} type="button">{workCopy.detail.openProject}</button> : null}
    {item.sourceSession && onOpenSourceSession ? <button onClick={() => onOpenSourceSession(item.sourceSession!)} type="button">{workCopy.detail.openSourceSession}</button> : <p>{workCopy.detail.noSourceSession}</p>}
    <WorkBrief onOpenArtifact={onOpenArtifact} profile={item.profile} showInference={false} value={item.brief} />
    <dl><dt>{workCopy.detail.owner}</dt><dd>{item.owner || workCopy.detail.unassigned}</dd><dt>{workCopy.detail.currentDecision}</dt><dd>{item.decision || workCopy.detail.noDecision}</dd>{item.snoozedUntil && <><dt>{workCopy.detail.snoozedUntil}</dt><dd>{item.snoozedUntil}</dd></>}</dl>
    {item.preparationStatus && <p className="work-boundary">{item.preparationStatus}</p>}
    {item.priority && <section aria-labelledby="priority-control-title" className="work-priority-control">
      <h4 id="priority-control-title">{workCopy.priority.title}</h4>
      <p>{workCopy.priority.help}</p>
      <label htmlFor="work-priority-label">{workCopy.priority.label}</label><input disabled={!verified || !priorityWritable} id="work-priority-label" onChange={(event) => setPriorityLabel(event.target.value)} value={priorityLabel} />
      <label htmlFor="work-priority-reason">{workCopy.priority.reason}</label><textarea disabled={!verified || !priorityWritable} id="work-priority-reason" onChange={(event) => setPriorityReason(event.target.value)} rows={2} value={priorityReason} />
      <label htmlFor="work-priority-expiry">{workCopy.priority.expiry}</label><input aria-describedby="work-priority-expiry-help" disabled={!verified || !priorityWritable} id="work-priority-expiry" onChange={(event) => setPriorityExpiry(event.target.value)} required type="datetime-local" value={priorityExpiry} />
      <small id="work-priority-expiry-help">{priorityExpiry ? workCopy.priority.chooseFuture : workCopy.priority.chooseExpiry}</small>
      <div className="work-actions"><button disabled={!verified || !priorityWritable || !priorityLabel.trim() || !priorityReason.trim() || !priorityExpiryValid} onClick={() => void onPriority({ label: priorityLabel.trim(), reason: priorityReason.trim(), expiresAt: new Date(priorityExpiry).toISOString() })} type="button">{workCopy.priority.set}</button>
        <button disabled={!verified || !priorityWritable || !item.priority.override?.active || !item.priority.override.version} onClick={() => void onRestorePriority()} type="button">{workCopy.priority.restore}</button></div>
      {!priorityWritable && <p>{workCopy.priority.ownerRequired}</p>}
    </section>}
    {item.executionAcknowledgedAt && <p>{workCopy.tracker.acknowledged} {item.executionAcknowledgedAt}</p>}
    {item.trackerEvidence && <TrackerStatus evidence={item.trackerEvidence} heading={workCopy.tracker.currentEvidence} onOpenArtifact={onOpenArtifact} profile={item.profile} />}
    {item.completionEvidence?.length ? <><h4>{workCopy.tracker.completionEvidence}</h4><WorkLinks links={item.completionEvidence.map((label) => ({ label, url: label }))} onOpenArtifact={onOpenArtifact} profile={item.profile} /></> : null}
    <h4>{workCopy.tracker.history}</h4>
    {item.trackerStatusHistory?.length ? <ol className="work-discussion">{item.trackerStatusHistory.map((entry, index) => <li key={`${entry.observed_at}:${index}`}><TrackerStatus evidence={entry} onOpenArtifact={onOpenArtifact} profile={item.profile} /></li>)}</ol> : <p>{workCopy.tracker.empty}</p>}
    <h4>{workCopy.detail.evidence}</h4>{item.evidence.length ? <WorkLinks links={item.evidence} onOpenArtifact={onOpenArtifact} profile={item.profile} /> : <p>{workCopy.detail.noEvidence}</p>}
    <div className="work-scope"><section><h4>{workCopy.detail.proposedScope}</h4><ul>{item.permitted.map((text, i) => <li key={i}>{text}</li>)}</ul></section><section><h4>{workCopy.detail.excludedScope}</h4><ul>{item.excluded.map((text, i) => <li key={i}>{text}</li>)}</ul></section></div>
    <h4>{workCopy.detail.previews}</h4>{item.previews.length ? <WorkLinks links={item.previews} onOpenArtifact={onOpenArtifact} profile={item.profile} /> : <p>{workCopy.detail.noPreviews}</p>}

    <h4>{workCopy.detail.decisionHistory}</h4>
    {item.decisionHistory?.length ? <ol className="work-discussion">{item.decisionHistory.map((entry) => <li key={entry.id}><strong>{entry.action.replaceAll('_', ' ')} · {workCopy.summary.revision} {entry.revision}</strong><p>{entry.actor} · {entry.createdAt} · {workCopy.detail.scope} {entry.scope.replaceAll('_', ' ')}</p>{entry.reason && <p className="work-plain-text">{entry.reason}</p>}{entry.snoozedUntil && <p>{workCopy.detail.snoozedUntil}: {entry.snoozedUntil}</p>}</li>)}</ol> : <p>{workCopy.detail.noDecisions}</p>}
    <h4>{workCopy.detail.discussion}</h4>
    <p>{workCopy.detail.discussionHelp}</p>
    <ol className="work-discussion">{item.discussion.map((entry) => <li key={entry.id}><strong>{entry.author}</strong><p className="work-plain-text">{entry.body}</p></li>)}</ol>
    <label htmlFor="work-comment">{workCopy.detail.discussionLabel}</label><textarea disabled={!verified || !item.canDecide} id="work-comment" onChange={(event) => setComment(event.target.value)} rows={3} value={comment} />
    <button disabled={!verified || !item.canDecide || !comment.trim()} onClick={() => void onComment(comment.trim()).then((saved) => {if (saved) {setComment('')}})} type="button">{workCopy.detail.addComment}</button>
    {validation && <p role="alert">{validation}</p>}
    <fieldset disabled={!enabled}><legend>{workCopy.detail.decisionForRevision(item.revision)}</legend><div className="work-actions">{([
      ['approve_preparation', workCopy.decisions.approve], ['request_changes', workCopy.decisions.requestChanges], ['remind_in_2_hours', workCopy.decisions.remind]
    ] as const).map(([action, label]) => <button className={item.recommendedAction === action ? 'primary-button' : undefined} key={action} onClick={() => void decide(action)} type="button">{label}{item.recommendedAction === action && <strong aria-hidden="true"> · {workCopy.decisions.recommended}</strong>}</button>)}</div></fieldset>
    {pending && <p role="status">{workCopy.detail.saving}</p>}
    {!item.actionable && <p>{item.readOnlyReason || workCopy.detail.readOnly}</p>}
  </article>
}
