import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'

import { TechnicalDetails } from '../../components/technical-details'
import { conversationCopy } from '../../copy/conversation'
import { directoryCopy } from '../../copy/directory'
import type { CompanionOriginalRoute } from '../../gateway/original-route'
import type { CompanionProject, CompanionSession, CompanionSessionTarget } from '../../gateway/types'
import type { ConversationCreationResult } from '../../state/companion-store'
import type { ProfileSelectorOption } from '../../state/profile-selector'
import { deriveConversationState, formatConversationTime } from '../conversation/conversation-state'
import { MessageComposer } from '../conversation/message-composer'
import { MessageContent } from '../conversation/message-content'
import { PersistedConversationList } from '../conversation/persisted-conversation-list'
import { StatusRow } from '../conversation/status-row'
import { transcriptSessionKey, useTranscriptScroll } from '../conversation/transcript-scroll'

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
  onOpenOriginal?(route: CompanionOriginalRoute, profile: string, sessionId: string): Promise<void>
}

const projectType = directoryCopy.projectType
const displayDate = (value: string | null) => value ? new Date(value).toLocaleString('pl-PL') : directoryCopy.freshnessUnknown
const count = (value: number | null, noun: string) => value === null ? directoryCopy.countUnknown(noun) : `${value} ${noun}`
const selected = (params: URLSearchParams, key: string) => new Set(params.getAll(key).filter(Boolean))
const statusLabel = (status: DirectoryStatus) => directoryCopy.status[status]

const entityStatusLabel = (status: string | null | undefined) => status
  ? directoryCopy.entityStatus[status as keyof typeof directoryCopy.entityStatus] ?? directoryCopy.details.unknownStatus
  : directoryCopy.details.unknownStatus
const domSlug = (value: string) => value.toLocaleLowerCase().normalize('NFKD').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
const tabId = (prefix: string, kind: 'tab' | 'panel', value: string) => `${domSlug(prefix)}-${kind}-${domSlug(value)}`
const chatProfileStorageKey = 'hermes.companion.chats.profile'
const chatKey = (source: string, profile: string, id: string) => JSON.stringify([source, profile, id])
const profileLabel = (profile: string) => profile ? profile[0].toLocaleUpperCase() + profile.slice(1) : directoryCopy.profileFallback
const tabLabel: Record<string, string> = {
  recent: directoryCopy.chrome.recentConversations,
  topics: directoryCopy.chrome.topics,
  projects: directoryCopy.chrome.projects,
  sessions: directoryCopy.chrome.sessions,
  overview: directoryCopy.details.overview,
  'needs me': directoryCopy.details.decisions,
  needs_me: directoryCopy.details.decisions,
  work: directoryCopy.details.work,
  files: directoryCopy.details.files,
  history: directoryCopy.details.history,
  'linked work': directoryCopy.details.linkedWork,
  sources: directoryCopy.details.sources
}

const enumParam = <T extends string>(params: URLSearchParams, key: string, allowed: readonly T[], fallback: T): T => {
  const value = params.get(key)

  return value && allowed.includes(value as T) ? value as T : fallback
}

interface ChatsDirectoryProps extends DirectoryProps {
  onOpenSession(item: CompanionSession): void
  onSubmitSession?(item: CompanionSession, text: string): Promise<void>
  onCreateConversation?(teammateId: string, text: string): Promise<ConversationCreationResult>
  profileOptions?: readonly ProfileSelectorOption[]
  draft?: string
  onDraftChange?(draft: string): void
  onActivateSessionDraft?(target: CompanionSessionTarget): void
}

function useMobileLayout() {
  const [mobile, setMobile] = useState(() => window.innerWidth <= 780)

  useEffect(() => {
    const update = () => setMobile(window.innerWidth <= 780)
    window.addEventListener('resize', update)

    return () => window.removeEventListener('resize', update)
  }, [])

  return mobile
}

function MobileConversationEntry({ profileOptions, draft, onDraftChange, onCreate }: { profileOptions: readonly ProfileSelectorOption[]; draft: string; onDraftChange(text: string): void; onCreate(teammateId: string, text: string): Promise<ConversationCreationResult> }) {
  const defaultTarget = profileOptions.find((option) => option.teammateId === 'atlas' && option.selectable)?.teammateId
    ?? profileOptions.find((option) => option.selectable)?.teammateId ?? ''
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState(defaultTarget)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) {messageRef.current?.focus()}
  }, [open])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const option = profileOptions.find((item) => item.teammateId === target)

    if (!option?.selectable || !draft.trim() || submitting) {return}
    setSubmitting(true)
    setError(null)

    try {
      const result = await onCreate(target, draft)

      if (result.status === 'refused') {
        setError('Nie można teraz utworzyć rozmowy z tym profilem. Wybierz dostępny profil lub odśwież połączenie.')
      } else if (result.status === 'unknown') {
        setError('Nie można potwierdzić utworzenia rozmowy. Wiadomość została zachowana; odśwież połączenie, aby sprawdzić wynik.')
      }
    } catch {
      setError('Nie można teraz utworzyć rozmowy z tym profilem. Wybierz dostępny profil lub odśwież połączenie.')
    } finally {
      setSubmitting(false)
    }
  }

  return <div className="mobile-new-conversation">
    <button aria-controls="mobile-new-conversation-form" aria-expanded={open} className="primary-button mobile-new-conversation__toggle" onClick={() => setOpen((value) => !value)} type="button">Nowa rozmowa</button>
    {open && <form aria-label="Nowa rozmowa" className="mobile-new-conversation__form" id="mobile-new-conversation-form" onSubmit={(event) => void submit(event)}>
      <label htmlFor="mobile-conversation-profile">Rozmawiaj z</label>
      <select id="mobile-conversation-profile" onChange={(event) => setTarget(event.target.value)} required value={target}>
        {!defaultTarget && <option value="">Wybierz profil</option>}
        {profileOptions.map((option) => <option disabled={!option.selectable} key={option.teammateId} value={option.teammateId}>{option.optionLabel}</option>)}
      </select>
      <label htmlFor="mobile-conversation-message">Pierwsza wiadomość</label>
      <textarea id="mobile-conversation-message" onChange={(event) => onDraftChange(event.target.value)} placeholder="Od czego zaczynamy?" ref={messageRef} rows={3} value={draft} />
      <button className="primary-button" disabled={!profileOptions.some((option) => option.teammateId === target && option.selectable) || !draft.trim() || submitting} type="submit">{submitting ? 'Tworzenie…' : 'Rozpocznij rozmowę'}</button>
      {error && <p role="alert">{error}</p>}
    </form>}
  </div>
}

function safeStoredChatProfile(): string | null {
  try { return window.localStorage.getItem(chatProfileStorageKey) } catch { return null }
}

function persistChatProfile(profile: string) {
  try { window.localStorage.setItem(chatProfileStorageKey, profile) } catch { /* Presentation preference only. */ }
}

export function ChatsDirectory(props: ChatsDirectoryProps) {
  const mobileLayout = useMobileLayout()
  const profileOptions = props.profileOptions ?? []
  const selectableProfiles = profileOptions.filter((option) => option.selectable).map((option) => option.profile)
  const requestedProfile = props.params.get('agent') ?? safeStoredChatProfile()
  const profile = requestedProfile && selectableProfiles.includes(requestedProfile) ? requestedProfile : 'all'
  const mode = enumParam(props.params, 'chatView', ['projects', 'recent'] as const, 'recent')
  const query = props.params.get('chatQ') ?? ''
  const legacySession = props.params.get('section') === 'sessions'
  const focusedId = props.params.get('chat') ?? (legacySession ? props.params.get('focus') : null)
  const focusedProfile = props.params.get('chatProfile') ?? (legacySession ? props.params.get('focusProfile') : null)
  const focusedSource = props.params.get('chatSource') ?? (legacySession ? props.params.get('focusSource') : null)
  const focusedSessionKey = focusedId && focusedProfile && focusedSource ? chatKey(focusedSource, focusedProfile, focusedId) : null
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const value = JSON.parse(props.params.get('chatExpanded') ?? '[]') as unknown

      return new Set(Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [])
    } catch { return new Set() }
  })
  const draft = props.draft ?? ''
  const [submittingSessions, setSubmittingSessions] = useState<Set<string>>(() => new Set())
  const [submitErrors, setSubmitErrors] = useState<Map<string, string>>(() => new Map())
  const rootRef = useRef<HTMLElement>(null)
  const listScroll = useRef(Number(props.params.get('chatScroll')) || 0)
  const submitting = focusedSessionKey ? submittingSessions.has(focusedSessionKey) : false
  const submitError = focusedSessionKey ? submitErrors.get(focusedSessionKey) ?? null : null

  const setParams = (change: Record<string, string | null>) => {
    const next = new URLSearchParams(props.params)

    for (const [key, value] of Object.entries(change)) { if (value === null) { next.delete(key) } else { next.set(key, value) } }
    props.onNavigate(next)
  }

  useEffect(() => {
    if (focusedId) {return}
    const top = Number(props.params.get('chatScroll')) || 0
    requestAnimationFrame(() => {
      const main = rootRef.current?.closest('main')

      if (mobileLayout) {window.scrollTo({ top })} else if (main) {main.scrollTop = top}
    })
  }, [focusedId, mobileLayout])

  useEffect(() => {
    if (!focusedId || !focusedProfile || !focusedSource) {return}
    const item = props.snapshot.selectedSession?.id === focusedId
      && props.snapshot.selectedSession.profile === focusedProfile
      && props.snapshot.selectedSession.source === focusedSource
      ? props.snapshot.selectedSession
      : props.snapshot.sessions.find((candidate) => candidate.id === focusedId && candidate.profile === focusedProfile && candidate.source === focusedSource)

    if (item) {props.onActivateSessionDraft?.({ backend_namespace: item.source, profile: item.profile, stored_session_id: item.id })}
  }, [focusedId, focusedProfile, focusedSource, props.onActivateSessionDraft, props.snapshot.selectedSession, props.snapshot.sessions])

  const matchingSessions = useMemo(() => props.snapshot.sessions
    .filter((item) => profile === 'all' || item.profile === profile)
    .filter((item) => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
      || item.project?.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((left, right) => (right.last_active ?? '').localeCompare(left.last_active ?? '') || left.title.localeCompare(right.title)), [profile, props.snapshot.sessions, query])

  const matchingProjects = useMemo(() => props.snapshot.projects
    .filter((item) => profile === 'all' || item.profile === profile)
    .filter((item) => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
      || matchingSessions.some((session) => session.project?.id === item.id && session.profile === item.profile && session.source === item.source))
    .sort((left, right) => (right.last_active ?? '').localeCompare(left.last_active ?? '') || left.title.localeCompare(right.title)), [matchingSessions, profile, props.snapshot.projects, query])

  const openSession = (item: CompanionSession) => {
    listScroll.current = mobileLayout ? window.scrollY : rootRef.current?.closest('main')?.scrollTop ?? 0
    setParams({ chatScroll: String(Math.round(listScroll.current)) })
    props.onOpenSession(item)
  }

  const goBack = () => {
    props.onBack()
    setParams({ chat: null, chatProfile: null, chatSource: null })
    requestAnimationFrame(() => {
      const main = rootRef.current?.closest('main')

      if (mobileLayout) {window.scrollTo({ top: listScroll.current })} else if (main) {main.scrollTop = listScroll.current}
    })
  }

  const submitSession = (item: CompanionSession) => {
    if (!props.onSubmitSession) {return}
    const submissionKey = chatKey(item.source, item.profile, item.id)

    if (submittingSessions.has(submissionKey)) {return}
    setSubmitErrors((current) => {
      const next = new Map(current)
      next.delete(submissionKey)
      return next
    })
    setSubmittingSessions((current) => new Set(current).add(submissionKey))
    void props.onSubmitSession(item, draft)
      .catch(() => setSubmitErrors((current) => new Map(current).set(submissionKey, 'Nie udało się wysłać wiadomości. Treść pozostała w polu — spróbuj ponownie.')))
      .finally(() => setSubmittingSessions((current) => {
        const next = new Set(current)
        next.delete(submissionKey)
        return next
      }))
  }

  if (focusedId && focusedProfile && focusedSource) {
    const selectedSession = props.snapshot.selectedSession
    const selectedMatches = selectedSession?.id === focusedId && selectedSession.profile === focusedProfile && selectedSession.source === focusedSource
    const item = selectedMatches ? selectedSession : props.snapshot.sessions.find((session) => session.id === focusedId && session.profile === focusedProfile && session.source === focusedSource)

    const project = item?.project === null ? 'Bez projektu' : item?.project?.title ?? 'Projekt nieznany'
    const state = deriveConversationState({ sessionStatus: item?.status, completedAt: item?.last_active })
    const refreshedTime = formatConversationTime(props.snapshot.history?.coverage.freshness)

    return <section aria-labelledby="saved-conversation-title" className="chats-screen chats-screen--conversation" ref={rootRef}>
      <header className="chat-history-head"><button aria-label={conversationCopy.backToSessions(profileLabel(focusedProfile))} className="conversation-back" onClick={goBack} type="button">←</button><div><h2 id="saved-conversation-title" title={item?.title || conversationCopy.fallbackSessionTitle}>{item?.title || conversationCopy.fallbackSessionTitle}</h2></div><span className={`conversation-state conversation-state--${state.kind}`}>{state.label}</span>{refreshedTime && <time className="conversation-updated" dateTime={props.snapshot.history?.coverage.freshness ?? undefined}>{conversationCopy.state.updated(refreshedTime)}</time>}</header>
      <div className="chat-history-body">
        {props.snapshot.history ? <><TechnicalDetails><p>{profileLabel(focusedProfile)} · {project}</p><DetailCoverage coverage={props.snapshot.history.coverage} label={directoryCopy.details.historyCoverage} /></TechnicalDetails><History onLoadOlder={props.onLoadOlderHistory} snapshot={props.snapshot} /></> : <Unavailable copy={props.snapshot.detailMessage ?? 'Pobieramy istniejącą historię z autorytatywnego źródła.'} title={props.snapshot.detailStatus === 'error' ? 'Nie udało się wczytać historii' : 'Ładowanie historii…'} />}
      </div>
      <MessageComposer disabled={!props.onSubmitSession} draft={draft} hint="Enter dodaje nową linię · Ctrl/Cmd+Enter wysyła" id="chat-session-draft" label={`Wiadomość do ${profileLabel(focusedProfile)}`} onDraftChange={(value) => props.onDraftChange?.(value)} onSubmit={() => {if (item) {submitSession(item)}}} placeholder={`Wiadomość do ${profileLabel(focusedProfile)}…`} sendLabel="Wyślij wiadomość" submitting={submitting} />
      {submitError && <p className="chat-composer-status" role="alert">{submitError}</p>}
      {!props.onSubmitSession && <p className="chat-composer-status" role="status">Historia jest aktywna do odczytu. Wysyłanie do tej zapisanej rozmowy zostanie podłączone przez istniejący gateway.</p>}
    </section>
  }

  const sessionStates = props.snapshot.coverage.map((item) => item.sessionStatus)
  const loading = sessionStates.length === 0 || sessionStates.some((item) => item === 'loading')
  const failed = sessionStates.some((item) => item === 'error' || item === 'offline' || item === 'unsupported')
  const complete = props.snapshot.coverage.length > 0 && props.snapshot.coverage.every((item) => item.sessionStatus === 'ready' && item.sessionComplete && !item.sessionsHasMore
    && (mode === 'recent' || item.projectStatus === 'ready' && item.projectComplete && !item.projectsHasMore))
  const emptyTitle = loading ? 'Ładowanie rozmów…' : failed || !complete ? 'Niepełne dane rozmów' : query ? 'Brak pasujących rozmów' : 'Brak rozmów'
  const emptyCopy = loading ? 'Czekamy na autoryzowane źródła.' : failed || !complete ? 'Co najmniej jedno źródło nie potwierdziło pełnej listy.' : query ? 'Zmień nazwę lub zakres profilu.' : 'Autoryzowane źródła zwróciły kompletną pustą listę.'
  const unassigned = matchingSessions.filter((item) => item.project === null)
  const unknownMembership = matchingSessions.filter((item) => item.project === undefined)
  const unmatched = matchingSessions.filter((item) => item.project && !matchingProjects.some((project) => project.id === item.project?.id && project.profile === item.profile && project.source === item.source))
  const pagedProfiles = props.snapshot.coverage.filter((item) => item.sessionsHasMore && (profile === 'all' || item.profile === profile))
  const pagedProjectProfiles = props.snapshot.coverage.filter((item) => item.projectsHasMore && (profile === 'all' || item.profile === profile))

  return <section aria-labelledby="chats-title" className="chats-screen" ref={rootRef}>
    <div className="directory-heading"><div><p className="kicker">Istniejące zapisane rozmowy</p><h2 id="chats-title">Rozmowy</h2><p className="screen-lede">Otwórz historię bez tworzenia nowej rozmowy i bez wznawiania jej przy samym wejściu.</p></div><button className="button" onClick={props.onRefresh} type="button">Odśwież</button></div>
    {mobileLayout && props.onCreateConversation && <MobileConversationEntry draft={draft} onCreate={props.onCreateConversation} onDraftChange={(value) => props.onDraftChange?.(value)} profileOptions={profileOptions} />}
    <div className="chat-controls"><label>Rozmawiaj z<select aria-label="Rozmawiaj z" onChange={(event) => { const value = event.target.value; persistChatProfile(value); setParams({ agent: value === 'all' ? null : value }) }} value={profile}><option value="all">Wszystkie</option>{profileOptions.map((option) => <option disabled={!option.selectable} key={option.profile} value={option.profile}>{option.optionLabel}</option>)}</select></label><label className="chat-search">Szukaj rozmów<input aria-label="Szukaj rozmów" onChange={(event) => setParams({ chatQ: event.target.value || null })} placeholder="Nazwa rozmowy lub projektu" type="search" value={query} /></label></div>
    <TabList className="chat-view-tabs segmented-tabs" idPrefix="chat-view" label="Widok rozmów" onSelect={(value) => setParams({ chatView: value })} selected={mode} tabs={['recent', 'projects']} />
    {mode === 'recent' ? <ChatSessionList allProfiles={profile === 'all'} emptyCopy={emptyCopy} emptyTitle={emptyTitle} items={matchingSessions} onOpen={openSession} /> : <div className="chat-project-list">
      {matchingProjects.map((project) => {
        const key = chatKey(project.source, project.profile, project.id)
        const projectSessions = matchingSessions.filter((item) => item.project?.id === project.id && item.profile === project.profile && item.source === project.source)
        const isExpanded = expanded.has(key)

        return <section className="chat-project" key={key}><button aria-expanded={isExpanded} className="chat-project__toggle" onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(key)) { next.delete(key) } else { next.add(key) }; setParams({ chatExpanded: next.size ? JSON.stringify([...next]) : null }); return next })} type="button"><span><strong>{project.title}</strong><small>{profile === 'all' ? `${project.profile} · ` : ''}{projectSessions.length} rozmów{project.archived ? ' · Archiwum' : ''}</small></span><b aria-hidden="true">{isExpanded ? '−' : '+'}</b></button>{isExpanded && <ChatSessionList allProfiles={profile === 'all'} emptyCopy="Ten projekt nie ma zapisanych rozmów." emptyTitle="Brak rozmów" items={projectSessions} onOpen={openSession} />}</section>
      })}
      {unassigned.length > 0 && <section className="chat-project chat-project--ungrouped"><h3>Bez projektu</h3><ChatSessionList allProfiles={profile === 'all'} emptyCopy="" emptyTitle="" items={unassigned} onOpen={openSession} /></section>}
      {unknownMembership.length > 0 && <section className="chat-project chat-project--ungrouped"><h3>Przypisanie projektu nieznane</h3><ChatSessionList allProfiles={profile === 'all'} emptyCopy="" emptyTitle="" items={unknownMembership} onOpen={openSession} /></section>}
      {unmatched.length > 0 && <section className="chat-project chat-project--ungrouped"><h3>Projekt poza bieżącą listą</h3><ChatSessionList allProfiles={profile === 'all'} emptyCopy="" emptyTitle="" items={unmatched} onOpen={openSession} /></section>}
      {!matchingProjects.length && !unassigned.length && !unknownMembership.length && !unmatched.length && <Unavailable copy={emptyCopy} title={emptyTitle} />}
    </div>}
    <div className="load-older">{pagedProfiles.map((item) => <button className="button" key={item.profile} onClick={() => props.onLoadOlder('sessions', item.profile)} type="button">Wczytaj starsze od {profileLabel(item.profile)}</button>)}</div>
    {mode === 'projects' && <div className="load-older">{pagedProjectProfiles.map((item) => <button className="button" key={item.profile} onClick={() => props.onLoadOlder('projects', item.profile)} type="button">Wczytaj więcej projektów od {profileLabel(item.profile)}</button>)}</div>}
    {!complete && !loading && matchingSessions.length > 0 && <p className="coverage-warning" role="status">Lista może być niepełna. Wyświetlamy wyłącznie rekordy potwierdzone przez dostępne źródła.</p>}
  </section>
}

function ChatSessionRow({ item, allProfiles, onOpen }: { item: CompanionSession; allProfiles: boolean; onOpen(): void }) {
  const preview = item.message_count === null ? 'Podgląd wiadomości niedostępny' : item.message_count === 0 ? 'Pusta zapisana rozmowa' : `${item.message_count} wiadomości · ${item.origin ?? 'źródło niezgłoszone'}`
  const state = deriveConversationState({ sessionStatus: item.status, completedAt: item.last_active })

  return <button className="chat-session-row" onClick={onOpen} type="button"><span><strong>{item.title || conversationCopy.fallbackSessionTitle}</strong><small>{preview}</small></span><span><span className={`conversation-state conversation-state--${state.kind}`}>{state.label}</span><small>{allProfiles ? item.profile : entityStatusLabel(item.status)}</small><time dateTime={item.last_active ?? undefined}>{displayDate(item.last_active)}</time></span><b aria-hidden="true">→</b></button>
}

function ChatSessionList({ items, allProfiles, onOpen, emptyTitle, emptyCopy }: { items: readonly CompanionSession[]; allProfiles: boolean; onOpen(item: CompanionSession): void; emptyTitle: string; emptyCopy: string }) {
  return <PersistedConversationList className="chat-session-list" emptyCopy={emptyCopy} emptyTitle={emptyTitle} itemKey={(item) => chatKey(item.source, item.profile, item.id)} items={items} renderItem={(item) => <ChatSessionRow allProfiles={allProfiles} item={item} onOpen={() => onOpen(item)} />} />
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
    <div className="directory-heading"><div><p className="kicker">{directoryCopy.chrome.kicker}</p><h2 id="work-directory-title">{directoryCopy.chrome.title}</h2><p className="screen-lede">{directoryCopy.chrome.lede}</p></div><button className="button" onClick={props.onRefresh} type="button">{directoryCopy.chrome.refresh}</button></div>
    <TabList className="directory-tabs segmented-tabs" idPrefix="work-directory" label={directoryCopy.chrome.tabsLabel} onSelect={(item) => setParams({ section: item as WorkSection, focus: null, focusProfile: null, focusSource: null, tab: null })} selected={section} tabs={['topics', 'projects', 'sessions']} />
    {section !== 'topics' && <Coverage coverage={props.snapshot.coverage} />}
    {(['topics', 'projects', 'sessions'] as const).map((item) => <div aria-labelledby={tabId('work-directory', 'tab', item)} hidden={section !== item} id={tabId('work-directory', 'panel', item)} key={item} role="tabpanel">
      {section === item && (item === 'topics'
        ? <TopicsDirectory onLoadOlder={(kind, profile) => props.onLoadOlder(kind, profile)} onNavigate={props.onNavigate} onOpen={(profile, source, id) => open('topic', profile, source, id)} params={props.params} snapshot={props.snapshot} />
        : <DirectoryList {...props} kind={item} onOpen={open} />)}
    </div>)}
  </section>
}

function Coverage({ coverage }: { coverage: DirectorySnapshot['coverage'] }) {
  if (!coverage.length) {return <div className="coverage-panel" role="status"><strong>{directoryCopy.coverage.notConfigured}</strong><span>{directoryCopy.coverage.noProfiles}</span></div>}

  return <>{coverage.filter((source) => source.message).map((source) => <p className="coverage-warning" key={source.profile} role="status">{directoryCopy.coverage.genericWarning}</p>)}<TechnicalDetails><div aria-label={directoryCopy.coverage.label} className="coverage-grid">{coverage.map((source) => <article className={`coverage-card coverage-card--${source.status}`} key={source.profile}><strong>{source.profile}</strong><span>{source.complete ? directoryCopy.coverage.complete : statusLabel(source.status)}</span><small>{directoryCopy.coverage.sessions}: {statusLabel(source.sessionStatus)} · {directoryCopy.coverage.projects}: {statusLabel(source.projectStatus)}</small><small>{source.freshness ? `${directoryCopy.coverage.fresh} ${displayDate(source.freshness)}` : directoryCopy.freshnessUnknown}</small>{source.message && <small>{source.message}</small>}</article>)}</div></TechnicalDetails></>
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

  const chips = [query && `Nazwa: ${query}`, ...[...sources].map((value) => `Źródło: ${value}`), ...[...profiles].map((value) => `Profil: ${value}`), ...[...origins].map((value) => `Pochodzenie: ${value}`), ...[...topics].map((value) => `Temat: ${availableTopics.find((item) => item.id === value)?.title ?? value}`), ...[...projects].map((value) => `Projekt: ${availableProjects.find((item) => item.id === value)?.title ?? value}`), ...[...types].map((value) => `Typ: ${value}`), dateFrom && `Od: ${dateFrom}`, dateTo && `Do: ${dateTo}`, archive !== (kind === 'sessions' ? 'all' : 'current') && `Widoczność: ${archive}`].filter(Boolean) as string[]
  const statuses = snapshot.coverage.map((item) => kind === 'sessions' ? item.sessionStatus : item.projectStatus)
  const unavailable = statuses.some((item) => item === 'unsupported')
  const failed = statuses.some((item) => item === 'error' || item === 'offline')
  const loading = statuses.length === 0 || statuses.some((item) => item === 'loading')

  const verifiedComplete = snapshot.coverage.length > 0 && snapshot.coverage.every((item) => kind === 'sessions'
    ? item.sessionStatus === 'ready' && item.sessionComplete && !item.sessionsHasMore
    : item.projectStatus === 'ready' && item.projectComplete && !item.projectsHasMore)

  const groupKey = (item: CompanionSession | CompanionProject) => group === 'profile' ? item.profile : group === 'source' ? item.source : group === 'origin' && 'origin' in item ? item.origin ?? directoryCopy.filters.unknownOrigin : ''
  const groups = [...new Set(items.map(groupKey))]

  return <>
    <div className="directory-filters">
      <label className="directory-search">{directoryCopy.filters.searchTitles}<input aria-label={directoryCopy.filters.searchTitles} onChange={(event) => {const next = new URLSearchParams(params);

 if (event.target.value) {next.set('q', event.target.value)} else {next.delete('q')}; onNavigate(next)}} type="search" value={query} /></label>
      <FilterMenu active={sources} label={directoryCopy.filters.source} onChange={(value, checked) => updateMulti('source', value, checked)} values={availableSources} />
      <FilterMenu active={profiles} label={directoryCopy.filters.profile} onChange={(value, checked) => updateMulti('profile', value, checked)} values={availableProfiles} />
      {kind === 'sessions' && <FilterMenu active={origins} label={directoryCopy.filters.origin} onChange={(value, checked) => updateMulti('origin', value, checked)} values={availableOrigins} />}
      {kind === 'sessions' && <LabeledFilterMenu active={topics} label={directoryCopy.filters.topic} onChange={(value, checked) => updateMulti('topic', value, checked)} values={availableTopics} />}
      {kind === 'sessions' && <LabeledFilterMenu active={projects} label={directoryCopy.filters.project} onChange={(value, checked) => updateMulti('project', value, checked)} values={availableProjects} />}
      {kind === 'sessions' && <FilterMenu active={types} label={directoryCopy.filters.type} onChange={(value, checked) => updateMulti('type', value, checked)} values={availableTypes} />}
      {kind === 'sessions' && <label>{directoryCopy.filters.from}<input aria-label={directoryCopy.filters.fromDate} onChange={(event) => updateParam(params, onNavigate, 'dateFrom', event.target.value)} type="date" value={dateFrom} /></label>}
      {kind === 'sessions' && <label>{directoryCopy.filters.to}<input aria-label={directoryCopy.filters.toDate} onChange={(event) => updateParam(params, onNavigate, 'dateTo', event.target.value)} type="date" value={dateTo} /></label>}
      <label>{directoryCopy.filters.visibility}<select aria-label={directoryCopy.filters.visibility} onChange={(event) => {const next = new URLSearchParams(params); next.delete('archive'); next.set('visibility', event.target.value); onNavigate(next)}} value={archive}><option value="all">{directoryCopy.filters.allEligible}</option><option value="current">{directoryCopy.filters.current}</option>{kind === 'sessions' && <option value="hidden">{directoryCopy.filters.hidden}</option>}<option value="archived">{directoryCopy.filters.archived}</option></select></label>
      <label>{directoryCopy.filters.sort}<select aria-label={directoryCopy.filters.sort} onChange={(event) => {const next = new URLSearchParams(params); next.set('sort', event.target.value); onNavigate(next)}} value={sort}><option value="recent">{directoryCopy.filters.recentActivity}</option><option value="name">{directoryCopy.filters.name}</option></select></label>
      <label>{directoryCopy.filters.groupBy}<select aria-label={directoryCopy.filters.groupBy} onChange={(event) => {const next = new URLSearchParams(params); next.set('group', event.target.value); onNavigate(next)}} value={group}><option value="none">{directoryCopy.filters.noGrouping}</option><option value="profile">{directoryCopy.filters.profile}</option><option value="source">{directoryCopy.filters.sourceBackend}</option>{kind === 'sessions' && <option value="origin">{directoryCopy.filters.origin}</option>}</select></label>
    </div>
    {chips.length > 0 && <div aria-label={directoryCopy.filters.active} className="filter-chips">{chips.map((chip) => <span key={chip}>{chip}</span>)}<button onClick={clear} type="button">{directoryCopy.filters.clear}</button></div>}
    {items.length ? <div className="directory-groups">{groups.map((name) => <section aria-label={name || directoryCopy.filters.results} key={name || 'all'}>{name && <h3>{name}</h3>}<div className="directory-list">{items.filter((item) => groupKey(item) === name).map((item) => kind === 'sessions' ? <SessionRow item={item as CompanionSession} key={`${item.source}:${item.profile}:${item.id}`} onOpen={() => onOpen('session', item.profile, item.source, item.id)} /> : <ProjectRow item={item as CompanionProject} key={`${item.source}:${item.profile}:${item.id}`} onOpen={() => onOpen('project', item.profile, item.source, item.id)} />)}</div></section>)}</div>
      : <Unavailable copy={loading ? directoryCopy.empty.waiting : unavailable || failed || !verifiedComplete ? directoryCopy.empty.incomplete : chips.length ? directoryCopy.empty.filtered : directoryCopy.empty.complete} title={loading ? directoryCopy.empty.loading : unavailable ? directoryCopy.empty.updateRequired : failed || !verifiedComplete ? directoryCopy.empty.unavailable : chips.length ? directoryCopy.empty.noMatches : directoryCopy.empty.none} />}
    <div className="load-older">{snapshot.coverage.filter((item) => kind === 'sessions' ? item.sessionsHasMore : item.projectsHasMore).map((item) => <button className="button" key={item.profile} onClick={() => onLoadOlder(kind, item.profile)} type="button">{directoryCopy.loadOlder(item.profile)}</button>)}</div>
  </>
}

function FilterMenu({ label, values, active, onChange }: { label: string; values: readonly string[]; active: Set<string>; onChange(value: string, checked: boolean): void }) {
  return <details className="filter-menu"><summary>{label}{active.size ? ` (${active.size})` : ''}</summary><div>{values.length ? values.map((value) => <label key={value}><input checked={active.has(value)} onChange={(event) => onChange(value, event.target.checked)} type="checkbox" />{value === 'unknown' ? directoryCopy.filters.unknownOrigin : value}</label>) : <span>{directoryCopy.filters.noValues}</span>}</div></details>
}

function LabeledFilterMenu({ label, values, active, onChange }: { label: string; values: readonly { id: string; title: string }[]; active: Set<string>; onChange(value: string, checked: boolean): void }) {
  return <details className="filter-menu"><summary>{label}{active.size ? ` (${active.size})` : ''}</summary><div>{values.length ? values.map((value) => <label key={value.id}><input checked={active.has(value.id)} onChange={(event) => onChange(value.id, event.target.checked)} type="checkbox" />{value.title}</label>) : <span>{directoryCopy.filters.noValues}</span>}</div></details>
}

function updateParam(params: URLSearchParams, onNavigate: (params: URLSearchParams) => void, key: string, value: string) {
  const next = new URLSearchParams(params)

  if (value) {next.set(key, value)} else {next.delete(key)}
  onNavigate(next)
}

function ProjectRow({ item, onOpen }: { item: CompanionProject; onOpen(): void }) {return <article className="directory-row-shell"><button className="directory-row" onClick={onOpen} type="button"><span><strong>{item.title}</strong><small>{projectType[item.type]} · {item.profile}{item.archived ? ` · ${directoryCopy.badges.archived}` : ''}</small></span><span><small>{count(item.session_count, directoryCopy.row.sessions)} · {count(item.linked_work_count, directoryCopy.row.linkedWork)}</small><small>{displayDate(item.last_active)}</small></span><b aria-hidden="true">→</b></button><TechnicalDetails><dl><div><dt>Backend</dt><dd>{item.source}</dd></div><div><dt>ID źródła</dt><dd>{item.id}</dd></div></dl></TechnicalDetails></article>}

function SessionRow({ item, onOpen }: { item: CompanionSession; onOpen(): void }) {return <article className="directory-row-shell"><button className="directory-row" onClick={onOpen} type="button"><span><strong>{item.title || directoryCopy.row.untitled}</strong><small>{item.profile}{item.archived ? ` · ${directoryCopy.badges.archived}` : ''}{item.hidden ? ` · ${directoryCopy.badges.hidden}` : ''}</small></span><span><small>{item.project?.title ?? directoryCopy.row.projectUnknown} · {count(item.message_count, directoryCopy.row.messages)} · {count(item.linked_work_count, directoryCopy.row.linkedWork)}</small><small>{displayDate(item.last_active)}</small></span><b aria-hidden="true">→</b></button><TechnicalDetails><dl><div><dt>Backend</dt><dd>{item.source}</dd></div><div><dt>ID źródła</dt><dd>{item.id}</dd></div><div><dt>Tożsamość źródła</dt><dd>{item.origin ?? directoryCopy.row.unknown}</dd></div></dl></TechnicalDetails></article>}

function ProjectDetail({ snapshot, tab, onTab, onBack, onOpenSession, onNavigate, onLoadOlderProjectSessions, params }: DirectoryProps & { tab: string; onTab(tab: string): void; onOpenSession(item: CompanionSession): void }) {
  const detail = snapshot.selectedProject

  return <section className="directory-detail"><BackButton label="projects" onBack={onBack} onNavigate={onNavigate} params={params} />{detail ? <><p className="kicker">{projectType[detail.project.type]} · {detail.project.profile}</p><h2 title={detail.project.title}>{detail.project.title}</h2><TechnicalDetails><dl><div><dt>Źródło</dt><dd>{detail.project.source}</dd></div><div><dt>ID</dt><dd>{detail.project.id}</dd></div></dl></TechnicalDetails><p className="read-only-note">Szczegóły źródła tylko do odczytu</p><DetailCoverage coverage={detail.coverage} label="Zakres przypisania" /><DetailTabs idPrefix="project-detail" onTab={onTab} tab={tab} tabs={['Overview', 'Sessions', 'Topics', 'Needs Me', 'Work', 'Files']} /><div aria-labelledby={tabId('project-detail', 'tab', tab)} id={tabId('project-detail', 'panel', tab)} role="tabpanel">{tab === 'overview' && <dl className="detail-facts"><div><dt>Ostatnia aktywność</dt><dd>{displayDate(detail.project.last_active)}</dd></div><div><dt>Rozmowy</dt><dd>{count(detail.project.session_count, directoryCopy.row.sessions)}</dd></div><div><dt>Powiązana praca</dt><dd>{count(detail.project.linked_work_count, directoryCopy.row.items)}</dd></div></dl>}{tab === 'sessions' && <>{detail.sessions.length ? <div className="directory-list">{detail.sessions.map((item) => <SessionRow item={item} key={`${item.source}:${item.profile}:${item.id}`} onOpen={() => onOpenSession(item)} />)}</div> : <Unavailable copy={detail.coverage.complete ? 'Ten dostępny projekt nie ma autorytatywnie przypisanych rozmów.' : 'Źródło nie zgłosiło pełnego przypisania rozmów do projektu.'} title={detail.coverage.complete ? 'Brak rozmów' : 'Przypisanie rozmów niedostępne'} />}{detail.membership_has_more && <button className="button" onClick={onLoadOlderProjectSessions} type="button">Wczytaj pełne przypisanie projektu</button>}</>}{tab === 'topics' && (detail.organization_available ? <ProjectTopics detail={detail} onNavigate={onNavigate} params={params} /> : <Unavailable copy="Ten gateway nie udostępnia zweryfikowanych powiązań tematów ani pracy; brak relacji nie został potwierdzony." title="Dane organizacji niedostępne" />)}{tab === 'needs me' && <EntityWork projection={snapshot.entityProjection} type="needsMe" />}{tab === 'work' && <EntityWork projection={snapshot.entityProjection} type="work" />}{tab === 'files' && <FilesLibraryLink onNavigate={onNavigate} params={params} />}</div></> : <DetailLoading snapshot={snapshot} />}</section>
}

function ProjectTopics({ detail, params, onNavigate }: { detail: NonNullable<DirectorySnapshot['selectedProject']>; params: URLSearchParams; onNavigate(params: URLSearchParams): void }) {
  if (!detail.topics.length) {
    return <Unavailable copy={detail.organization_complete ? 'Pełna autoryzowana lista organizacji nie zawiera powiązanych tematów.' : 'Nie potwierdzono braku relacji, ponieważ zakres danych organizacji jest niepełny.'} title={detail.organization_complete ? 'Brak powiązanych tematów' : 'Zakres tematów jest niepełny'} />
  }

  return <><ul className="reference-list">{detail.topics.map((topic) => <li key={`${topic.source}:${topic.profile}:${topic.id}`}><strong>{topic.title}</strong><span>{topic.source} · {topic.profile}{topic.status ? ` · ${entityStatusLabel(topic.status)}` : ''}</span><button onClick={() => {const next = new URLSearchParams(params); next.set('section', 'topics'); next.set('focus', topic.id); next.set('focusProfile', topic.profile); next.set('focusSource', topic.source); next.set('tab', 'overview'); onNavigate(next)}} type="button">Otwórz temat</button></li>)}</ul>{!detail.organization_complete && <p className="coverage-warning" role="status">Nie udało się zweryfikować części autoryzowanych powiązań tematów.</p>}</>
}

function SessionDetail({ snapshot, tab, onTab, onBack, onNavigate, onLoadOlderHistory, onOpenOriginal, params }: DirectoryProps & { tab: string; onTab(tab: string): void }) {
  const session = snapshot.selectedSession
  const history = snapshot.history

  const source = history?.source ?? session?.source
  const profile = history?.profile ?? session?.profile
  const id = history?.session_id ?? session?.id
  const originalRoute = history?.original_route
  const identity = `${source ?? ''}\u0000${profile ?? ''}\u0000${id ?? ''}`
  const [openState, setOpenState] = useState<{ identity: string; status: 'opening' | 'error' } | null>(null)
  const opening = openState?.identity === identity && openState.status === 'opening'
  const openFailed = openState?.identity === identity && openState.status === 'error'

  const openOriginal = async () => {
    if (!originalRoute || !history || !onOpenOriginal) { return }
    setOpenState({ identity, status: 'opening' })

    try {
      await onOpenOriginal(originalRoute, history.profile, history.session_id)
      setOpenState((current) => current?.identity === identity ? null : current)
    } catch {
      setOpenState((current) => current?.identity === identity ? { identity, status: 'error' } : current)
    }
  }

  return <section className="directory-detail"><BackButton label="sessions" onBack={onBack} onNavigate={onNavigate} params={params} />{session || history ? <><p className="kicker">Rozmowa tylko do odczytu · {profile}</p><h2 title={session?.title || conversationCopy.fallbackSessionTitle}>{session?.title || conversationCopy.fallbackSessionTitle}</h2><TechnicalDetails><dl><div><dt>Źródło</dt><dd>{source}</dd></div><div><dt>ID</dt><dd>{id}</dd></div></dl></TechnicalDetails>{!session && <p className="coverage-warning" role="status">Dla tego bezpośredniego odnośnika nie zgłoszono metadanych listy. Wyświetlana jest tylko autorytatywna zapisana historia.</p>}<p className="read-only-note">Wyświetlenie historii nie wznawia ani nie aktywuje tej rozmowy.</p><aside aria-label="Rozmowa źródłowa" className="coverage-panel"><strong>Rozmowa źródłowa</strong><span>Kontynuuj tę rozmowę w dotychczasowym kliencie, używając pełnej tożsamości źródła.</span>{originalRoute && onOpenOriginal && <button disabled={opening} onClick={() => void openOriginal()} type="button">{opening ? 'Otwieranie źródła…' : 'Otwórz źródło'}</button>}{openFailed && <p role="alert">Hermes Desktop nie mógł otworzyć tej rozmowy. Użyj powyższej tożsamości źródła, aby kontynuować ręcznie.</p>}</aside>{history && <DetailCoverage coverage={history.coverage} label="Zakres historii" />}<DetailTabs idPrefix="session-detail" onTab={onTab} tab={tab} tabs={['Overview', 'History', 'Linked work', 'Files']} /><div aria-labelledby={tabId('session-detail', 'tab', tab)} id={tabId('session-detail', 'panel', tab)} role="tabpanel">{tab === 'overview' && (session ? <dl className="detail-facts"><div><dt>Pochodzenie</dt><dd>{session.origin ?? 'Pochodzenie nieznane'}</dd></div><div><dt>Projekt</dt><dd>{session.project?.title ?? 'Przypisanie projektu niezgłoszone'}</dd></div><div><dt>Wiadomości</dt><dd>{count(session.message_count, directoryCopy.row.messages)}</dd></div><div><dt>Status</dt><dd>{entityStatusLabel(session.status)}</dd></div></dl> : <Unavailable copy="Odpowiedź historii potwierdza tożsamość i wiadomości, ale nie zawiera nazwy, pochodzenia, przypisania projektu, statusu ani liczników." title="Metadane listy niedostępne" />)}{tab === 'history' && <History onLoadOlder={onLoadOlderHistory} snapshot={snapshot} />}{tab === 'linked work' && <EntityWork projection={snapshot.entityProjection} type="work" />}{tab === 'files' && <FilesLibraryLink onNavigate={onNavigate} params={params} />}</div></> : <DetailLoading snapshot={snapshot} />}</section>
}

function BackButton({ label, onBack, onNavigate, params }: { label: string; onBack(): void; onNavigate(params: URLSearchParams): void; params: URLSearchParams }) {
  const back = () => {
    onBack()
    const next = new URLSearchParams(params)

    for (const key of ['focus', 'focusProfile', 'focusSource', 'tab']) {next.delete(key)}
    onNavigate(next)
  }

  return <button className="back-button" onClick={back} type="button">{label === 'projects' ? directoryCopy.details.backProjects : directoryCopy.details.backSessions}</button>
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

  return <div className="directory-empty" role="status"><strong>Powiązane pliki</strong><p>Otwórz filtr autoryzowanych powiązań plików dla tej pozycji.</p><button onClick={openLibrary} type="button">Zobacz pliki</button></div>
}

function DetailTabs({ tabs, tab, onTab, idPrefix }: { tabs: readonly string[]; tab: string; onTab(tab: string): void; idPrefix: string }) {
  return <TabList className="detail-tabs segmented-tabs" idPrefix={idPrefix} onSelect={onTab} selected={tab} tabs={tabs.map((label) => label.toLocaleLowerCase())} />
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

  return <div aria-label={label} className={className} role="tablist">{tabs.map((value, index) => <button aria-controls={tabId(idPrefix, 'panel', value)} aria-selected={selected === value} id={tabId(idPrefix, 'tab', value)} key={value} onClick={() => onSelect(value)} onKeyDown={(event) => onKeyDown(event, index)} role="tab" tabIndex={selected === value ? 0 : -1} type="button">{tabLabel[value] ?? value}</button>)}</div>
}

function DetailCoverage({ coverage, label }: { coverage: { complete: boolean; freshness: string | null; message: string | null }; label: string }) {return <><div className="coverage-panel" role="status"><strong>{label}: {coverage.complete ? directoryCopy.coverage.completeLabel : directoryCopy.coverage.incompleteLabel}</strong><span>{coverage.freshness ? `${directoryCopy.coverage.fresh} ${displayDate(coverage.freshness)}` : directoryCopy.freshnessUnknown}</span><span>{coverage.message ? directoryCopy.coverage.genericWarning : directoryCopy.coverage.noWarnings}</span></div>{coverage.message && <TechnicalDetails><p>{coverage.message}</p></TechnicalDetails>}</>}

function History({ snapshot, onLoadOlder }: { snapshot: DirectorySnapshot; onLoadOlder(): void }) {
  const history = snapshot.history
  const itemIds = useMemo(() => history?.entries.map((entry) => entry.id) ?? [], [history?.entries])
  const contentVersion = useMemo(() => history?.entries.map((entry) => `${entry.id}:${entry.kind}:${entry.role ?? ''}:${entry.label ?? ''}:${entry.content}`).join('\u0000') ?? '', [history?.entries])
  const identity = history ? transcriptSessionKey(history.source, history.profile, history.session_id) : 'history-unavailable'
  const transcriptScroll = useTranscriptScroll(identity, itemIds, contentVersion)

  if (!history) {return <DetailLoading snapshot={snapshot} />}
  const technicalEntries = history.entries.filter((entry) => entry.kind !== 'message')
  const messageEntries = history.entries.filter((entry) => entry.kind === 'message')

  return <div className="history-shell">
    <div className="history-transcript" onScroll={transcriptScroll.onScroll} ref={transcriptScroll.viewportRef}>
      {history.has_more && <button className="button history-load-older" onClick={onLoadOlder} type="button">Wczytaj starszą historię</button>}
      <div className="history-flow">{messageEntries.map((entry) => <div data-transcript-id={entry.id} key={entry.id}><article className={`history-message history-message--${entry.role ?? 'system'}`}><small>{directoryCopy.history.roles[entry.role ?? 'system']}</small><MessageContent role={entry.role ?? 'system'} text={entry.content} /></article></div>)}</div>
      {technicalEntries.length > 0 && <TechnicalDetails>{technicalEntries.map((entry) => <div data-transcript-id={entry.id} key={entry.id}><StatusRow kind={entry.kind === 'tool' ? 'tool' : entry.kind === 'compression' ? 'compression' : 'internal'} label={entry.label} payload={entry.content} state={entry.kind === 'tool' ? conversationCopy.statusRow.toolState.complete : null} /></div>)}</TechnicalDetails>}
      <div aria-hidden="true" ref={transcriptScroll.endRef} />
    </div>
    {transcriptScroll.showJumpToLatest && <button className="jump-to-latest jump-to-latest--history" onClick={transcriptScroll.jumpToLatest} type="button">{conversationCopy.transcript.newMessages}</button>}
  </div>
}

function DetailLoading({ snapshot }: { snapshot: DirectorySnapshot }) {return <Unavailable copy={snapshot.detailMessage ?? directoryCopy.detailLoading.waiting} title={snapshot.detailStatus === 'loading' ? directoryCopy.detailLoading.loading : snapshot.detailStatus === 'unsupported' ? directoryCopy.detailLoading.updateRequired : directoryCopy.detailLoading.unavailable} />}

function Unavailable({ title, copy }: { title: string; copy: string }) {return <div className="directory-empty" role="status"><strong>{title}</strong><p>{copy}</p></div>}
