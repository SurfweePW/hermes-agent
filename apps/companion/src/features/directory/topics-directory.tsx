import { type KeyboardEvent } from 'react'

import { TechnicalDetails } from '../../components/technical-details'
import type { TopicCollection, TopicDetail, TopicItem } from '../../gateway/topic-types'

import type { DirectorySnapshot } from './directory-store'

interface Props {
  snapshot: DirectorySnapshot
  params: URLSearchParams
  onNavigate(params: URLSearchParams): void
  onLoadOlder(kind: 'topics', profile: string): void
  onOpen(profile: string, source: string, id: string): void
}

const selected = (params: URLSearchParams, key: string) => new Set(params.getAll(key).filter(Boolean))
const displayDate = (value: string) => new Date(value).toLocaleString()

export function TopicsDirectory({ snapshot, params, onNavigate, onLoadOlder, onOpen }: Props) {
  const query = params.get('q') ?? ''
  const collections = selected(params, 'collection')
  const lifecycles = selected(params, 'lifecycle')
  const sort = params.get('sort') === 'name' ? 'name' : 'updated'
  const verified = params.get('verified') === 'true'
  const choices = [...new Set([...snapshot.topics.map((item) => item.collection), ...collections])].sort()

  const update = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)

    if (value) {next.set(key, value)} else {next.delete(key)}
    onNavigate(next)
  }

  const multi = (key: string, value: string, checked: boolean) => {
    const values = selected(params, key)

    if (checked) {values.add(value)} else {values.delete(value)}
    const next = new URLSearchParams(params)

    next.delete(key)

    for (const item of [...values].sort()) {next.append(key, item)}
    onNavigate(next)
  }

  const ready = snapshot.topicCoverage.filter((item) => item.status === 'ready')
  const loaded = ready.reduce((sum, item) => sum + item.loaded, 0)
  const total = ready.length === snapshot.topicCoverage.length && ready.every((item) => item.total !== null) ? ready.reduce((sum, item) => sum + item.total!, 0) : null
  const completeEmpty = snapshot.topicCoverage.length > 0 && snapshot.topicCoverage.every((item) => item.status === 'ready' && item.coverage?.status === 'complete' && item.total === 0)
  const filtered = Boolean(query.trim() || collections.size || lifecycles.size || verified)
  const chips = [query.trim() && `Topic: ${query.trim()}`, ...[...collections].map((value) => `Collection: ${value}`), ...[...lifecycles].map((value) => `Lifecycle: ${value}`), verified && 'Verified lifecycle only'].filter(Boolean) as string[]

  const clear = () => {
    const next = new URLSearchParams(params)

    for (const key of ['q', 'collection', 'lifecycle', 'verified']) { next.delete(key) }
    onNavigate(next)
  }

  return <>
    <div className="directory-filters">
      <label className="directory-search">Search topics<input aria-label="Search topics" onChange={(event) => update('q', event.target.value)} type="search" value={query} /></label>
      <Filter active={collections} label="Collection" onChange={(value, checked) => multi('collection', value, checked)} values={choices} />
      <Filter active={lifecycles} label="Lifecycle" onChange={(value, checked) => multi('lifecycle', value, checked)} values={['active', 'completed', 'archived']} />
      <label className="directory-checkbox"><input checked={verified} onChange={(event) => update('verified', event.target.checked ? 'true' : null)} type="checkbox" /> Verified status</label>
      <label>Sort<select aria-label="Topic sort" onChange={(event) => update('sort', event.target.value)} value={sort}><option value="updated">Recently updated</option><option value="name">Name</option></select></label>
    </div>
    {chips.length > 0 && <div aria-label="Active topic filters" className="filter-chips">{chips.map((chip) => <span key={chip}>{chip}</span>)}<button onClick={clear} type="button">Clear filters</button></div>}
    <div className="coverage-panel" role="status"><strong>{total === null ? `${loaded} topics loaded · total unknown` : `${loaded} of ${total} topics loaded`}</strong><span>{snapshot.topicCoverage.map((item) => item.message).filter(Boolean).join(' ')}</span></div>
    <TechnicalDetails><div aria-label="Topic source coverage">{snapshot.topicCoverage.map((item) => <p key={item.profile}>{item.profile}: {item.coverage?.status ?? item.status}</p>)}</div></TechnicalDetails>
    {snapshot.topics.length ? <div className="directory-list">{snapshot.topics.map((item) => <TopicRow item={item} key={`${item.source}:${item.profile}:${item.id}`} onOpen={() => onOpen(item.profile, item.source, item.id)} />)}</div> : <Empty copy={completeEmpty ? filtered ? 'The complete filtered result contains no matching topics.' : 'The organization registry returned a complete empty topic population.' : 'Companion cannot claim this directory is empty because at least one authorized source is unavailable, partial, or still loading.'} title={completeEmpty ? filtered ? 'No matching topics' : 'No topics yet' : snapshot.topicCoverage.some((item) => item.status === 'loading') ? 'Loading verified topics…' : snapshot.topicCoverage.some((item) => item.status === 'unsupported') ? 'Backend update required' : 'Topic coverage unavailable'} />}
    <div className="load-older">{snapshot.topicCoverage.filter((item) => item.hasMore).map((item) => <button className="button" key={item.profile} onClick={() => onLoadOlder('topics', item.profile)} type="button">Load more topics from {item.profile}</button>)}</div>
  </>
}

function Filter({ label, values, active, onChange }: { label: string; values: string[]; active: Set<string>; onChange(value: string, checked: boolean): void }) {
  return <details className="filter-menu"><summary>{label}{active.size ? ` (${active.size})` : ''}</summary><div>{values.map((value) => <label key={value}><input checked={active.has(value)} onChange={(event) => onChange(value, event.target.checked)} type="checkbox" />{value}</label>)}</div></details>
}

function TopicRow({ item, onOpen }: { item: TopicItem & { profile: string; source: string }; onOpen(): void }) {
  const action = item.next_useful_action.availability === 'available' ? item.next_useful_action.references?.join(', ') : 'Next useful action unknown'

  return <article className="directory-row-shell"><button className="directory-row directory-row--topic" onClick={onOpen} type="button"><span><strong>{item.name}</strong><small>{item.objective}</small><small>{item.collection} · Profil: {item.profile}</small></span><span><small>{action}</small><small>{displayDate(item.updated_at)}</small></span><b aria-hidden="true">→</b></button><TechnicalDetails><dl><div><dt>Backend</dt><dd>{item.source}</dd></div><div><dt>Cykl życia</dt><dd>{item.lifecycle}</dd></div><div><dt>Zakres powiązań</dt><dd>{item.linked_work.coverage}</dd></div><div><dt>ID źródła</dt><dd>{item.id}</dd></div></dl></TechnicalDetails></article>
}

export function TopicDetailView({ snapshot, params, onNavigate, onOpenSource, tab, onTab }: { snapshot: DirectorySnapshot; params: URLSearchParams; onNavigate(params: URLSearchParams): void; onOpenSource(kind: 'project' | 'session', profile: string, source: string, id: string): void; tab: string; onTab(tab: string): void }) {
  const detail = snapshot.selectedTopic

  const back = () => {
    const next = new URLSearchParams(params)

    for (const key of ['focus', 'focusProfile', 'focusSource', 'tab']) {next.delete(key)}
    onNavigate(next)
  }

  const tabs = [['overview', 'Overview'], ['needs_me', 'Needs Me'], ['work', 'Work'], ['files', 'Files'], ['sources', 'Sources']] as const

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { nextIndex = (index + 1) % tabs.length }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { nextIndex = (index - 1 + tabs.length) % tabs.length }

    if (event.key === 'Home') { nextIndex = 0 }

    if (event.key === 'End') { nextIndex = tabs.length - 1 }

    if (nextIndex === null) { return }
    event.preventDefault()
    onTab(tabs[nextIndex][0])
    const list = event.currentTarget.parentElement
    requestAnimationFrame(() => list?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex!]?.focus())
  }

  return <section className="directory-detail"><button className="back-button" onClick={back} type="button">← Back to topics</button>{detail ? <><p className="kicker">Topic · {detail.topic.collection} · Profil: {detail.profile}</p><h2>{detail.topic.name}</h2><TechnicalDetails><dl><div><dt>Backend</dt><dd>{detail.backend_namespace}</dd></div><div><dt>ID źródła</dt><dd>{detail.topic.id}</dd></div></dl></TechnicalDetails><p className="read-only-note">Read-only organization detail</p><div aria-label="Topic detail" className="detail-tabs" role="tablist">{tabs.map(([value, label], index) => <button aria-controls={`topic-detail-panel-${value}`} aria-selected={tab === value} id={`topic-detail-tab-${value}`} key={value} onClick={() => onTab(value)} onKeyDown={(event) => onKeyDown(event, index)} role="tab" tabIndex={tab === value ? 0 : -1} type="button">{label}</button>)}</div>{tabs.map(([value]) => <div aria-labelledby={`topic-detail-tab-${value}`} hidden={tab !== value} id={`topic-detail-panel-${value}`} key={value} role="tabpanel">{tab === value && <Panel detail={detail} onNavigate={onNavigate} onOpenSource={onOpenSource} snapshot={snapshot} tab={tab} />}</div>)}</> : <Empty copy={snapshot.detailMessage ?? 'Waiting for the read-only organization projection.'} title={snapshot.detailStatus === 'loading' ? 'Loading verified topic…' : 'Topic unavailable'} />}</section>
}

function Panel({ detail, tab, onNavigate, onOpenSource, snapshot }: { detail: TopicDetail; tab: string; onNavigate(params: URLSearchParams): void; onOpenSource(kind: 'project' | 'session', profile: string, source: string, id: string): void; snapshot: DirectorySnapshot }) {
  if (tab === 'overview') { return <><p>{detail.overview.objective}</p><dl className="detail-facts"><div><dt>Verified lifecycle</dt><dd>{detail.overview.verified_status.value} · observed {displayDate(detail.overview.verified_status.observed_at)}</dd></div><div><dt>Status authority</dt><dd>{detail.overview.verified_status.authority}</dd></div><div><dt>Next useful action</dt><dd>{detail.overview.next_useful_action.availability === 'available' ? detail.overview.next_useful_action.references?.join(', ') : detail.overview.next_useful_action.reason ?? 'Not available from this source'}</dd></div><div><dt>Updated</dt><dd>{displayDate(detail.topic.updated_at)}</dd></div></dl></> }

  if (tab === 'needs_me') { return <EntityWork projection={snapshot.entityProjection} type="needsMe" /> }

  if (tab === 'files') { return <div className="directory-empty" role="status"><strong>Linked Library files</strong><p>Open the authorized Library relationship filter for this topic.</p><button onClick={() => onNavigate(new URLSearchParams({ view: 'library', libraryProfile: detail.profile, libraryTopic: detail.topic.id }))} type="button">View files in Library</button></div> }

  if (tab === 'work') { return <EntityWork projection={snapshot.entityProjection} type="work" /> }

  return snapshot.topicSourceDetails.length ? <ul className="reference-list">{snapshot.topicSourceDetails.map((item) => <li key={`${item.source.kind}:${item.source.canonical_id}`}><strong>{item.title}</strong><span>{item.source.relationship} · {item.status} · {item.detail}</span>{item.source.kind === 'project' ? <button onClick={() => { if (item.source.kind === 'project') { onOpenSource('project', item.source.namespace.profile, item.source.namespace.backend_id, item.source.source_id) } }} type="button">Open project</button> : item.source.kind === 'session' ? <button onClick={() => { if (item.source.kind === 'session') { onOpenSource('session', item.source.namespace.profile, item.source.namespace.backend_id, item.source.session.persisted_session_id) } }} type="button">Open session</button> : null}</li>)}</ul> : snapshot.entityProjection?.status === 'loading' ? <Empty copy="Resolving authorized live source records." title="Loading sources…" /> : <CollectionEmpty collection={detail.sources} empty="No organization source references" unavailable="Sources unavailable" />
}

export function EntityWork({ projection, type }: { projection: DirectorySnapshot['entityProjection']; type: 'work' | 'needsMe' }) {
  if (!projection || projection.status === 'loading') { return <Empty copy="Resolving authorized organization bindings and durable work records." title="Loading verified work…" /> }

  if (projection.status !== 'ready') { return <Empty copy={projection.message ?? 'The authorized projection could not be verified.'} title="Work unavailable" /> }
  const items = projection[type]

  if (!items.length) { return <Empty copy={projection.complete ? 'The complete authorized relationship projection returned no items.' : projection.message ?? 'No empty result is being claimed because relationship coverage is incomplete.'} title={projection.complete ? type === 'needsMe' ? 'No Needs Me items' : 'No linked work' : 'Work coverage incomplete'} /> }

  return <ul className="reference-list">{items.map((entry) => <li key={entry.id}><strong>{entry.detail?.item.title ?? `${entry.binding.work_kind}: ${entry.binding.source_work_id}`}</strong><span>{entry.detail ? `${entry.detail.item.state.replaceAll('_', ' ')} · ${entry.detail.item.preparation_status.replaceAll('_', ' ')} · revision ${entry.detail.item.revision}` : 'Source record missing'}</span>{entry.priority && <span>{entry.priority.why_here} · Next: {entry.priority.next_step}</span>}</li>)}</ul>
}

function CollectionEmpty({ collection, empty, unavailable }: { collection: TopicCollection<unknown>; empty: string; unavailable: string }) {
  const status = collection.coverage.status

  if (status === 'complete') { return <Empty copy="The organization registry returned a complete empty collection." title={empty} /> }
  const reason = typeof collection.coverage.reason === 'string' ? collection.coverage.reason : status === 'partial' ? 'Only a partial authorized projection is available; no empty result is being claimed.' : 'No read-only query contract exists; no empty result is being claimed.'

  return <Empty copy={reason} title={unavailable} />
}

function Empty({ title, copy }: { title: string; copy: string }) { return <div className="directory-empty" role="status"><strong>{title}</strong><p>{copy}</p></div> }
