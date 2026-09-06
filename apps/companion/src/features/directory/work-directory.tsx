import { type KeyboardEvent, useMemo } from 'react'

import type { CompanionProject, CompanionSession } from '../../gateway/types'
import { MessageContent } from '../conversation/message-content'

import type { DirectorySnapshot, DirectoryStatus } from './directory-store'
import { EntityWork, TopicDetailView, TopicsDirectory } from './topics-directory'

export type WorkSection = 'topics' | 'projects' | 'sessions'
interface DirectoryProps {
  snapshot: DirectorySnapshot
  params: URLSearchParams
  onNavigate(params: URLSearchParams): void
  onLoadOlder(kind: 'sessions' | 'projects' | 'topics', profile: string): void
  onLoadOlderHistory(): void
  onLoadOlderProjectSessions(): void
  onRefresh(): void
  onBack(): void
}

const projectType = { desktop_project: 'Desktop project', business_project: 'Business project', discovered_repository: 'Discovered repository', unknown: 'Unknown project type' } as const
const displayDate = (value: string | null) => value ? new Date(value).toLocaleString() : 'Freshness unknown'
const count = (value: number | null, noun: string) => value === null ? `${noun} count unknown` : `${value} ${noun}`
const selected = (params: URLSearchParams, key: string) => new Set(params.getAll(key).filter(Boolean))
const statusLabel = (status: DirectoryStatus) => status === 'unsupported' ? 'Backend update required' : status[0].toUpperCase() + status.slice(1)
const domSlug = (value: string) => value.toLocaleLowerCase().normalize('NFKD').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
const tabId = (prefix: string, kind: 'tab' | 'panel', value: string) => `${domSlug(prefix)}-${kind}-${domSlug(value)}`

const enumParam = <T extends string>(params: URLSearchParams, key: string, allowed: readonly T[], fallback: T): T => {
  const value = params.get(key)

  return value && allowed.includes(value as T) ? value as T : fallback
}

export function WorkDirectory(props: DirectoryProps) {
  const section = (['topics', 'projects', 'sessions'].includes(props.params.get('section') ?? '') ? props.params.get('section') : 'topics') as WorkSection
  const focus = props.params.get('focus')
  const focusProfile = props.params.get('focusProfile')

  const detailTab = section === 'projects'
    ? enumParam(props.params, 'tab', ['overview', 'sessions', 'topics', 'needs me', 'work', 'files'] as const, 'overview')
    : section === 'topics'
      ? enumParam(props.params, 'tab', ['overview', 'needs_me', 'work', 'files', 'sources'] as const, 'overview')
      : enumParam(props.params, 'tab', ['overview', 'history', 'linked work', 'files'] as const, 'overview')

  const setParams = (change: Record<string, string | null>) => {
    const next = new URLSearchParams(props.params)

    for (const [key, value] of Object.entries(change)) {if (value === null) {next.delete(key)} else {next.set(key, value)}}
    props.onNavigate(next)
  }

  const open = (kind: 'project' | 'session' | 'topic', profile: string, source: string, id: string) => {
    setParams({ section: `${kind}s`, focus: id, focusProfile: profile, focusSource: source, tab: 'overview' })
  }

  if (focus && focusProfile && section === 'topics') {
    return <TopicDetailView onNavigate={props.onNavigate} onOpenSource={(kind, profile, source, id) => open(kind, profile, source, id)} onTab={(tab) => setParams({ tab })} params={props.params} snapshot={props.snapshot} tab={detailTab} />
  }

  if (focus && focusProfile && section === 'projects') {
    return <ProjectDetail {...props} onOpenSession={(item) => open('session', item.profile, item.source, item.id)} onTab={(tab) => setParams({ tab })} tab={detailTab} />
  }

  if (focus && focusProfile && section === 'sessions') {
    return <SessionDetail {...props} onTab={(tab) => setParams({ tab })} tab={detailTab} />
  }

  return <section aria-labelledby="work-directory-title" className="directory-screen">
    <div className="directory-heading"><div><p className="kicker">Source directories</p><h2 id="work-directory-title">Work</h2><p className="screen-lede">Browse persisted source records, including empty and unlinked records. Browsing never activates a project or resumes a session.</p></div><button className="button" onClick={props.onRefresh} type="button">Refresh sources</button></div>
    <TabList className="directory-tabs" idPrefix="work-directory" label="Work directories" onSelect={(item) => setParams({ section: item as WorkSection, focus: null, focusProfile: null, focusSource: null, tab: null })} selected={section} tabs={['topics', 'projects', 'sessions']} />
    {section !== 'topics' && <Coverage coverage={props.snapshot.coverage} />}
    {(['topics', 'projects', 'sessions'] as const).map((item) => <div aria-labelledby={tabId('work-directory', 'tab', item)} hidden={section !== item} id={tabId('work-directory', 'panel', item)} key={item} role="tabpanel">
      {section === item && (item === 'topics'
        ? <TopicsDirectory onLoadOlder={(kind, profile) => props.onLoadOlder(kind, profile)} onNavigate={props.onNavigate} onOpen={(profile, source, id) => open('topic', profile, source, id)} params={props.params} snapshot={props.snapshot} />
        : <DirectoryList {...props} kind={item} onOpen={open} />)}
    </div>)}
  </section>
}

function Coverage({ coverage }: { coverage: DirectorySnapshot['coverage'] }) {
  if (!coverage.length) {return <div className="coverage-panel" role="status"><strong>Coverage not configured</strong><span>No authorized profile sources were reported.</span></div>}

  return <div aria-label="Source coverage" className="coverage-grid">{coverage.map((source) => <article className={`coverage-card coverage-card--${source.status}`} key={source.profile}><strong>{source.profile}</strong><span>{source.complete ? 'Complete source coverage' : statusLabel(source.status)}</span><small>Sessions: {statusLabel(source.sessionStatus)} · Projects: {statusLabel(source.projectStatus)}</small><small>{source.freshness ? `Fresh ${displayDate(source.freshness)}` : 'Freshness unknown'}{source.message ? ` · ${source.message}` : ''}</small></article>)}</div>
}

function DirectoryList({ snapshot, params, kind, onOpen, onLoadOlder, onNavigate }: DirectoryProps & { kind: 'projects' | 'sessions'; onOpen: (kind: 'project' | 'session', profile: string, source: string, id: string) => void }) {
  const query = params.get('q') ?? ''
  const sources = selected(params, 'source')
  const profiles = selected(params, 'profile')
  const origins = selected(params, 'origin')
  const visibility = enumParam(params, 'visibility', ['current', 'all', 'hidden', 'archived'] as const, kind === 'sessions' ? 'all' : 'current')
  const legacyArchive = enumParam(params, 'archive', ['current', 'all', 'archived'] as const, kind === 'sessions' ? 'all' : 'current')
  const archive = params.has('visibility') ? visibility : legacyArchive
  const topics = selected(params, 'topic')
  const projects = selected(params, 'project')
  const types = selected(params, 'type')
  const dateFrom = params.get('dateFrom') ?? ''
  const dateTo = params.get('dateTo') ?? ''
  const sort = params.get('sort') === 'name' ? 'name' : 'recent'
  const group = enumParam(params, 'group', kind === 'sessions' ? ['none', 'profile', 'source', 'origin'] as const : ['none', 'profile', 'source'] as const, 'none')
  const population = kind === 'sessions' ? snapshot.sessions : snapshot.projects
  const availableSources = [...new Set([...population.map((item) => item.source), ...sources])].sort()
  const availableProfiles = [...new Set(snapshot.coverage.map((item) => item.profile))].sort()
  const availableOrigins = [...new Set(snapshot.sessions.map((item) => item.origin ?? 'unknown'))].sort()
  const availableTopics = [...new Map(snapshot.sessions.flatMap((item) => item.topics ?? []).map((item) => [item.id, item])).values()].sort((left, right) => left.title.localeCompare(right.title))
  const availableProjects = [...new Map(snapshot.sessions.flatMap((item) => item.project ? [[item.project.id, item.project] as const] : [])).values()].sort((left, right) => left.title.localeCompare(right.title))
  const availableTypes = [...new Set(snapshot.sessions.map((item) => item.type).filter((item): item is string => Boolean(item)))].sort()

  const items = useMemo(() => population.filter((item) => {
    const origin = 'origin' in item ? item.origin ?? 'unknown' : null
    const activityDate = item.last_active?.slice(0, 10) ?? ''
    const session = kind === 'sessions' ? item as CompanionSession : null

    return item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
      && (!sources.size || sources.has(item.source))
      && (!profiles.size || profiles.has(item.profile))
      && (kind !== 'sessions' || !origins.size || origins.has(origin!))
      && (kind !== 'sessions' || !topics.size || session!.topics?.some((topic) => topics.has(topic.id)) === true)
      && (kind !== 'sessions' || !projects.size || Boolean(session!.project && projects.has(session!.project.id)))
      && (kind !== 'sessions' || !types.size || Boolean(session!.type && types.has(session!.type)))
      && (!dateFrom || Boolean(activityDate && activityDate >= dateFrom))
      && (!dateTo || Boolean(activityDate && activityDate <= dateTo))
      && (archive === 'all' || (archive === 'hidden' ? 'hidden' in item && item.hidden : archive === 'archived' ? item.archived : !item.archived && (!('hidden' in item) || !item.hidden)))
  }).sort((left, right) => sort === 'name'
    ? left.title.localeCompare(right.title)
    : (right.last_active ?? '').localeCompare(left.last_active ?? '') || left.title.localeCompare(right.title)), [archive, dateFrom, dateTo, kind, origins, population, profiles, projects, query, sort, sources, topics, types])

  const updateMulti = (key: string, value: string, checked: boolean) => {
    const values = selected(params, key);

 if (checked) {values.add(value)} else {values.delete(value)}
    const next = new URLSearchParams(params); next.delete(key);

 for (const item of values) {next.append(key, item)}; onNavigate(next)
  }

  const clear = () => {const next = new URLSearchParams(params);

 for (const key of ['q', 'source', 'profile', 'origin', 'visibility', 'archive', 'dateFrom', 'dateTo', 'topic', 'project', 'type']) {next.delete(key)}; onNavigate(next)}

  const chips = [query && `Title: ${query}`, ...[...sources].map((value) => `Source: ${value}`), ...[...profiles].map((value) => `Profile: ${value}`), ...[...origins].map((value) => `Origin: ${value}`), ...[...topics].map((value) => `Topic: ${availableTopics.find((item) => item.id === value)?.title ?? value}`), ...[...projects].map((value) => `Project: ${availableProjects.find((item) => item.id === value)?.title ?? value}`), ...[...types].map((value) => `Type: ${value}`), dateFrom && `From: ${dateFrom}`, dateTo && `To: ${dateTo}`, archive !== (kind === 'sessions' ? 'all' : 'current') && `Visibility: ${archive}`].filter(Boolean) as string[]
  const statuses = snapshot.coverage.map((item) => kind === 'sessions' ? item.sessionStatus : item.projectStatus)
  const unavailable = statuses.some((item) => item === 'unsupported')
  const failed = statuses.some((item) => item === 'error' || item === 'offline')
  const loading = statuses.length === 0 || statuses.some((item) => item === 'loading')

  const verifiedComplete = snapshot.coverage.length > 0 && snapshot.coverage.every((item) => kind === 'sessions'
    ? item.sessionStatus === 'ready' && item.sessionComplete && !item.sessionsHasMore
    : item.projectStatus === 'ready' && item.projectComplete && !item.projectsHasMore)

  const groupKey = (item: CompanionSession | CompanionProject) => group === 'profile' ? item.profile : group === 'source' ? item.source : group === 'origin' && 'origin' in item ? item.origin ?? 'Unknown origin' : ''
  const groups = [...new Set(items.map(groupKey))]

  return <>
    <div className="directory-filters">
      <label className="directory-search">Search titles<input aria-label="Search titles" onChange={(event) => {const next = new URLSearchParams(params);

 if (event.target.value) {next.set('q', event.target.value)} else {next.delete('q')}; onNavigate(next)}} type="search" value={query} /></label>
      <FilterMenu active={sources} label="Source" onChange={(value, checked) => updateMulti('source', value, checked)} values={availableSources} />
      <FilterMenu active={profiles} label="Profile" onChange={(value, checked) => updateMulti('profile', value, checked)} values={availableProfiles} />
      {kind === 'sessions' && <FilterMenu active={origins} label="Origin" onChange={(value, checked) => updateMulti('origin', value, checked)} values={availableOrigins} />}
      {kind === 'sessions' && <LabeledFilterMenu active={topics} label="Topic" onChange={(value, checked) => updateMulti('topic', value, checked)} values={availableTopics} />}
      {kind === 'sessions' && <LabeledFilterMenu active={projects} label="Project" onChange={(value, checked) => updateMulti('project', value, checked)} values={availableProjects} />}
      {kind === 'sessions' && <FilterMenu active={types} label="Type" onChange={(value, checked) => updateMulti('type', value, checked)} values={availableTypes} />}
      {kind === 'sessions' && <label>From<input aria-label="From date" onChange={(event) => updateParam(params, onNavigate, 'dateFrom', event.target.value)} type="date" value={dateFrom} /></label>}
      {kind === 'sessions' && <label>To<input aria-label="To date" onChange={(event) => updateParam(params, onNavigate, 'dateTo', event.target.value)} type="date" value={dateTo} /></label>}
      <label>Visibility<select aria-label="Visibility" onChange={(event) => {const next = new URLSearchParams(params); next.delete('archive'); next.set('visibility', event.target.value); onNavigate(next)}} value={archive}><option value="all">All eligible</option><option value="current">Current</option>{kind === 'sessions' && <option value="hidden">Hidden</option>}<option value="archived">Archived</option></select></label>
      <label>Sort<select aria-label="Sort" onChange={(event) => {const next = new URLSearchParams(params); next.set('sort', event.target.value); onNavigate(next)}} value={sort}><option value="recent">Recent activity</option><option value="name">Name</option></select></label>
      <label>Group by<select aria-label="Group by" onChange={(event) => {const next = new URLSearchParams(params); next.set('group', event.target.value); onNavigate(next)}} value={group}><option value="none">No grouping</option><option value="profile">Profile</option><option value="source">Source backend</option>{kind === 'sessions' && <option value="origin">Origin</option>}</select></label>
    </div>
    {chips.length > 0 && <div aria-label="Active filters" className="filter-chips">{chips.map((chip) => <span key={chip}>{chip}</span>)}<button onClick={clear} type="button">Clear filters</button></div>}
    {items.length ? <div className="directory-groups">{groups.map((name) => <section aria-label={name || 'Directory results'} key={name || 'all'}>{name && <h3>{name}</h3>}<div className="directory-list">{items.filter((item) => groupKey(item) === name).map((item) => kind === 'sessions' ? <SessionRow item={item as CompanionSession} key={`${item.source}:${item.profile}:${item.id}`} onOpen={() => onOpen('session', item.profile, item.source, item.id)} /> : <ProjectRow item={item as CompanionProject} key={`${item.source}:${item.profile}:${item.id}`} onOpen={() => onOpen('project', item.profile, item.source, item.id)} />)}</div></section>)}</div>
      : <Unavailable copy={loading ? 'Waiting for authorized source APIs.' : unavailable || failed || !verifiedComplete ? 'At least one source cannot verify this directory, so this is not a complete empty result.' : chips.length ? 'Clear one or more filters to restore eligible records.' : 'Every configured source returned a complete empty result.'} title={loading ? 'Loading verified source records…' : unavailable ? 'Backend update required' : failed || !verifiedComplete ? 'Source coverage unavailable' : chips.length ? 'No matching items' : 'No eligible records'} />}
    <div className="load-older">{snapshot.coverage.filter((item) => kind === 'sessions' ? item.sessionsHasMore : item.projectsHasMore).map((item) => <button className="button" key={item.profile} onClick={() => onLoadOlder(kind, item.profile)} type="button">Load older from {item.profile}</button>)}</div>
  </>
}

function FilterMenu({ label, values, active, onChange }: { label: string; values: readonly string[]; active: Set<string>; onChange(value: string, checked: boolean): void }) {
  return <details className="filter-menu"><summary>{label}{active.size ? ` (${active.size})` : ''}</summary><div>{values.length ? values.map((value) => <label key={value}><input checked={active.has(value)} onChange={(event) => onChange(value, event.target.checked)} type="checkbox" />{value === 'unknown' ? 'Unknown origin' : value}</label>) : <span>No values reported</span>}</div></details>
}

function LabeledFilterMenu({ label, values, active, onChange }: { label: string; values: readonly { id: string; title: string }[]; active: Set<string>; onChange(value: string, checked: boolean): void }) {
  return <details className="filter-menu"><summary>{label}{active.size ? ` (${active.size})` : ''}</summary><div>{values.length ? values.map((value) => <label key={value.id}><input checked={active.has(value.id)} onChange={(event) => onChange(value.id, event.target.checked)} type="checkbox" />{value.title}</label>) : <span>No values reported</span>}</div></details>
}

function updateParam(params: URLSearchParams, onNavigate: (params: URLSearchParams) => void, key: string, value: string) {
  const next = new URLSearchParams(params)

  if (value) {next.set(key, value)} else {next.delete(key)}
  onNavigate(next)
}

function ProjectRow({ item, onOpen }: { item: CompanionProject; onOpen(): void }) {return <button className="directory-row" onClick={onOpen} type="button"><span><strong>{item.title}</strong><small>{projectType[item.type]} · {item.source} · {item.profile}{item.archived ? ' · Archived' : ''}</small></span><span><small>{count(item.session_count, 'sessions')} · {count(item.linked_work_count, 'linked work')}</small><small>{displayDate(item.last_active)}</small></span><b aria-hidden="true">→</b></button>}

function SessionRow({ item, onOpen }: { item: CompanionSession; onOpen(): void }) {return <button className="directory-row" onClick={onOpen} type="button"><span><strong>{item.title || 'Untitled saved session'}</strong><small>{item.source} · {item.profile} · Origin: {item.origin ?? 'Unknown'}{item.archived ? ' · Archived' : ''}{item.hidden ? ' · Hidden' : ''}</small></span><span><small>{item.project?.title ?? 'Project membership not reported'} · {count(item.message_count, 'messages')} · {count(item.linked_work_count, 'linked work')}</small><small>{displayDate(item.last_active)}</small></span><b aria-hidden="true">→</b></button>}

function ProjectDetail({ snapshot, tab, onTab, onBack, onOpenSession, onNavigate, onLoadOlderProjectSessions, params }: DirectoryProps & { tab: string; onTab(tab: string): void; onOpenSession(item: CompanionSession): void }) {
  const detail = snapshot.selectedProject

  return <section className="directory-detail"><BackButton label="projects" onBack={onBack} onNavigate={onNavigate} params={params} />{detail ? <><p className="kicker">{projectType[detail.project.type]} · {detail.project.source} · {detail.project.profile}</p><h2>{detail.project.title}</h2><p className="read-only-note">Read-only source detail</p><DetailCoverage coverage={detail.coverage} label="Membership coverage" /><DetailTabs idPrefix="project-detail" onTab={onTab} tab={tab} tabs={['Overview', 'Sessions', 'Topics', 'Needs Me', 'Work', 'Files']} /><div aria-labelledby={tabId('project-detail', 'tab', tab)} id={tabId('project-detail', 'panel', tab)} role="tabpanel">{tab === 'overview' && <dl className="detail-facts"><div><dt>Last activity</dt><dd>{displayDate(detail.project.last_active)}</dd></div><div><dt>Sessions</dt><dd>{count(detail.project.session_count, 'sessions')}</dd></div><div><dt>Linked work</dt><dd>{count(detail.project.linked_work_count, 'items')}</dd></div></dl>}{tab === 'sessions' && <>{detail.sessions.length ? <div className="directory-list">{detail.sessions.map((item) => <SessionRow item={item} key={`${item.source}:${item.profile}:${item.id}`} onOpen={() => onOpenSession(item)} />)}</div> : <Unavailable copy={detail.coverage.complete ? 'This eligible project exists without an authoritative session membership.' : detail.coverage.message ?? 'The source did not report complete project membership.'} title={detail.coverage.complete ? 'No sessions yet' : 'Session membership unavailable'} />}{detail.membership_has_more && <button className="button" onClick={onLoadOlderProjectSessions} type="button">Load complete project membership</button>}</>}{tab === 'topics' && (detail.organization_available ? <Refs empty={tab === 'topics' ? 'No linked topics yet' : 'No linked work yet'} items={tab === 'topics' ? detail.topics : tab === 'needs me' ? detail.needs_me : detail.work} /> : <Unavailable copy="This gateway does not expose verified topic or work bindings; no empty relationship is being claimed." title="Organization data unavailable" />)}{tab === 'needs me' && <EntityWork projection={snapshot.entityProjection} type="needsMe" />}{tab === 'work' && <EntityWork projection={snapshot.entityProjection} type="work" />}{tab === 'files' && <FilesLibraryLink onNavigate={onNavigate} params={params} />}</div></> : <DetailLoading snapshot={snapshot} />}</section>
}

function SessionDetail({ snapshot, tab, onTab, onBack, onNavigate, onLoadOlderHistory, params }: DirectoryProps & { tab: string; onTab(tab: string): void }) {
  const session = snapshot.selectedSession
  const history = snapshot.history

  return <section className="directory-detail"><BackButton label="sessions" onBack={onBack} onNavigate={onNavigate} params={params} />{session || history ? <><p className="kicker">Read-only session · {session?.source ?? history?.source} · {session?.profile ?? history?.profile}</p><h2>{session?.title || 'Saved session'}</h2>{!session && <p className="coverage-warning" role="status">Listing metadata was not reported for this deep link. Only authoritative persisted history is shown.</p>}<p className="read-only-note">Viewing history does not resume or activate this session.</p>{history && <DetailCoverage coverage={history.coverage} label="History coverage" />}<DetailTabs idPrefix="session-detail" onTab={onTab} tab={tab} tabs={['Overview', 'History', 'Linked work', 'Files']} /><div aria-labelledby={tabId('session-detail', 'tab', tab)} id={tabId('session-detail', 'panel', tab)} role="tabpanel">{tab === 'overview' && (session ? <dl className="detail-facts"><div><dt>Origin</dt><dd>{session.origin ?? 'Unknown origin'}</dd></div><div><dt>Project</dt><dd>{session.project?.title ?? 'Project membership not reported'}</dd></div><div><dt>Messages</dt><dd>{count(session.message_count, 'messages')}</dd></div><div><dt>Status</dt><dd>{session.status ?? 'Status unknown'}</dd></div></dl> : <Unavailable copy="The history response verifies identity and messages, but does not provide title, origin, project membership, status, or counts." title="Listing metadata unavailable" />)}{tab === 'history' && <History onLoadOlder={onLoadOlderHistory} snapshot={snapshot} />}{tab === 'linked work' && <EntityWork projection={snapshot.entityProjection} type="work" />}{tab === 'files' && <FilesLibraryLink onNavigate={onNavigate} params={params} />}</div></> : <DetailLoading snapshot={snapshot} />}</section>
}

function BackButton({ label, onBack, onNavigate, params }: { label: string; onBack(): void; onNavigate(params: URLSearchParams): void; params: URLSearchParams }) {
  const back = () => {
    onBack()
    const next = new URLSearchParams(params)

    for (const key of ['focus', 'focusProfile', 'focusSource', 'tab']) {next.delete(key)}
    onNavigate(next)
  }

  return <button className="back-button" onClick={back} type="button">← Back to {label}</button>
}

function FilesLibraryLink({ params, onNavigate }: { params: URLSearchParams; onNavigate(params: URLSearchParams): void }) {
  const section = params.get('section')
  const focus = params.get('focus')
  const profile = params.get('focusProfile')

  const openLibrary = () => {
    const next = new URLSearchParams()
    next.set('view', 'library')

    if (profile) {next.set('libraryProfile', profile)}

    if (focus && section === 'projects') {next.set('libraryProject', focus)}

    if (focus && section === 'sessions') {next.set('librarySession', focus)}
    onNavigate(next)
  }

  return <div className="directory-empty" role="status"><strong>Linked Library files</strong><p>Open the authorized Library relationship filter for this entity.</p><button onClick={openLibrary} type="button">View files in Library</button></div>
}

function DetailTabs({ tabs, tab, onTab, idPrefix }: { tabs: readonly string[]; tab: string; onTab(tab: string): void; idPrefix: string }) {
  return <TabList className="detail-tabs" idPrefix={idPrefix} onSelect={onTab} selected={tab} tabs={tabs.map((label) => label.toLocaleLowerCase())} />
}

function TabList({ tabs, selected, onSelect, idPrefix, className, label }: { tabs: readonly string[]; selected: string; onSelect(tab: string): void; idPrefix: string; className: string; label?: string }) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {nextIndex = (index + 1) % tabs.length}

    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {nextIndex = (index - 1 + tabs.length) % tabs.length}

    if (event.key === 'Home') {nextIndex = 0}

    if (event.key === 'End') {nextIndex = tabs.length - 1}

    if (nextIndex === null) {return}
    event.preventDefault()
    onSelect(tabs[nextIndex])
    const list = event.currentTarget.parentElement
    requestAnimationFrame(() => (list?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex!])?.focus())
  }

  return <div aria-label={label} className={className} role="tablist">{tabs.map((value, index) => <button aria-controls={tabId(idPrefix, 'panel', value)} aria-selected={selected === value} id={tabId(idPrefix, 'tab', value)} key={value} onClick={() => onSelect(value)} onKeyDown={(event) => onKeyDown(event, index)} role="tab" tabIndex={selected === value ? 0 : -1} type="button">{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
}

function DetailCoverage({ coverage, label }: { coverage: { complete: boolean; freshness: string | null; message: string | null }; label: string }) {return <div className="coverage-panel" role="status"><strong>{label}: {coverage.complete ? 'Complete' : 'Incomplete'}</strong><span>{coverage.freshness ? `Fresh ${displayDate(coverage.freshness)}` : 'Freshness unknown'}</span><span>{coverage.message ?? 'No source warnings reported.'}</span></div>}

function History({ snapshot, onLoadOlder }: { snapshot: DirectorySnapshot; onLoadOlder(): void }) {if (!snapshot.history) {return <DetailLoading snapshot={snapshot} />};

 return <><div className="history-flow">{snapshot.history.entries.map((entry) => entry.kind === 'internal' ? <details className="internal-event" key={entry.id}><summary>{entry.label ?? 'Internal event'}{entry.occurred_at ? ` · ${displayDate(entry.occurred_at)}` : ''}</summary>{entry.content && <p>{entry.content}</p>}</details> : entry.kind === 'compression' ? <aside aria-label="Compression summary" className="compression-summary" key={entry.id}><strong>Compression summary</strong><span>Generated context carried forward from earlier history</span><MessageContent role="system" text={entry.content} /></aside> : <article className={`history-message history-message--${entry.role ?? 'system'}`} key={entry.id}><small>{entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'Assistant' : 'System'}</small><MessageContent role={entry.role ?? 'system'} text={entry.content} /></article>)}</div>{snapshot.history.has_more && <button className="button" onClick={onLoadOlder} type="button">Load older history</button>}</>}

function Refs({ items, empty }: { items: readonly { id: string; title: string; status?: string }[]; empty: string }) {return items.length ? <ul className="reference-list">{items.map((item) => <li key={item.id}><strong>{item.title}</strong>{item.status && <span>{item.status}</span>}</li>)}</ul> : <Unavailable copy="The configured source reported no verified links." title={empty} />}

function DetailLoading({ snapshot }: { snapshot: DirectorySnapshot }) {return <Unavailable copy={snapshot.detailMessage ?? 'Waiting for the persisted read-only source projection.'} title={snapshot.detailStatus === 'loading' ? 'Loading verified details…' : snapshot.detailStatus === 'unsupported' ? 'Backend update required' : 'Details unavailable'} />}

function Unavailable({ title, copy }: { title: string; copy: string }) {return <div className="directory-empty" role="status"><strong>{title}</strong><p>{copy}</p></div>}
