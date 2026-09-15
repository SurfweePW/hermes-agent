import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { PullToRefresh } from './components/pull-to-refresh'
import { appCopy } from './copy/app'
import { conversationCopy } from './copy/conversation'
import { workCopy } from './copy/work'
import { NeedsMe } from './features/attention/needs-me'
import { Conversation } from './features/conversation/conversation'
import { deriveConversationState, formatConversationTime } from './features/conversation/conversation-state'
import { transcriptSessionKey } from './features/conversation/transcript-scroll'
import { installDirectoryRefreshLifecycle } from './features/directory/directory-refresh'
import { ChatsDirectory, WorkDirectory } from './features/directory/work-directory'
import { Library } from './features/library/library'
import type { LibraryRelationshipContext } from './features/library/library-types'
import { Recovery } from './features/recovery/recovery'
import { Roster, type Teammate } from './features/roster/roster'
import { TeammateDetails } from './features/roster/teammate-details'
import { OwnerSignIn } from './features/work/owner-sign-in'
import { WorkInbox } from './features/work/work-inbox'
import { canonicalDecisionCount, distinctRuntimeAttention, verifiedWorkProfiles } from './features/work/work-store'
import { createFakeWorkGateway } from './fixtures/fake-work-gateway'
import { hasOriginalRouteCapability, openOriginalRoute } from './gateway/original-route'
import { type CompanionStore, createCompanionStore } from './state/companion-store'
import { buildProfileSelectorModel } from './state/profile-selector'
import { useCompanion } from './state/use-companion'

type Screen = 'needs' | 'work' | 'library' | 'settings' | 'conversation' | 'details' | 'recovery'
const primaryScreens = new Set<Screen>(['needs', 'work', 'library', 'settings'])

const fixtureMode = import.meta.env.VITE_COMPANION_FIXTURE === 'true'
const defaultStore = createCompanionStore(fixtureMode ? { gatewayFactory: createFakeWorkGateway } : {})

const screenTitles: Record<Screen, string> = appCopy.screenTitles

function initialScreen(): Screen {
  const view = new URLSearchParams(window.location.search).get('view') as Screen | null

  return view && primaryScreens.has(view) ? view : 'work'
}

export function libraryAssetParams(profile: string, reference: string): URLSearchParams {
  const params = new URLSearchParams()
  params.set('view', 'library')
  params.set('libraryProfile', profile)
  params.set('libraryOpen', reference)

  return params
}

export function App({ store = defaultStore }: { store?: CompanionStore }) {
  const companion = useCompanion(store)
  const work = useSyncExternalStore(store.work.subscribe, store.work.getSnapshot, store.work.getSnapshot)
  const directory = useSyncExternalStore(store.directory.subscribe, store.directory.getSnapshot, store.directory.getSnapshot)
  const [screen, setScreen] = useState<Screen>(initialScreen)
  const [locationSearch, setLocationSearch] = useState(window.location.search)
  const [libraryRefreshToken, setLibraryRefreshToken] = useState(0)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [mobileLayout, setMobileLayout] = useState(() => window.innerWidth <= 780)
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)
  const mainRef = useRef<HTMLElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLElement>(null)
  const drawerWasOpen = useRef(false)
  const refreshLifecycleRef = useRef<ReturnType<typeof installDirectoryRefreshLifecycle> | null>(null)
  const screenRef = useRef(screen)
  const locationSearchRef = useRef(locationSearch)
  const initialFocus = useRef(true)
  const fixtureStarted = useRef(false)
  const restoredDirectoryFocus = useRef('')
  const restoredLibraryRelationship = useRef('')
  const selected = companion.teammates.find((teammate) => teammate.id === companion.selectedTeammateId)
  const authoritativeWorkProfiles = verifiedWorkProfiles(work)
  const runtimeAttention = companion.phase === 'ready' ? companion.attentionItems : []
  const canonicalRuntimeAttention = distinctRuntimeAttention(work.items, runtimeAttention, authoritativeWorkProfiles)
  const attentionCount = canonicalDecisionCount(work.items, canonicalRuntimeAttention, authoritativeWorkProfiles)
  const profileOptions = useMemo(() => buildProfileSelectorModel(companion.teammates, companion.profileServiceability, directory.coverage),
    [companion.profileServiceability, companion.teammates, directory.coverage])
  const routeParams = new URLSearchParams(locationSearch)
  const savedConversationOpen = screen === 'work' && routeParams.has('chat')
  const conversationOpen = screen === 'conversation' || savedConversationOpen
  const foregroundTurn = ['sending', 'submitting', 'streaming', 'stopping'].includes(companion.turnStatus)
  screenRef.current = screen
  locationSearchRef.current = locationSearch

  useEffect(() => {
    const lifecycle = installDirectoryRefreshLifecycle({
      isReady: () => store.getSnapshot().phase === 'ready',
      refreshWork: store.work.refresh,
      refreshDirectory: store.directory.refresh,
      refreshAttention: store.refreshAttention,
      refreshLibrary: () => setLibraryRefreshToken((value) => value + 1),
      refreshVisible: async () => {
        const visible = screenRef.current

        if (visible === 'needs') {await Promise.all([store.work.refresh(), store.refreshAttention()]); return}
        if (visible === 'work') {
          await store.directory.refresh()
          const params = new URLSearchParams(locationSearchRef.current)
          const id = params.get('chat')
          const profile = params.get('chatProfile')
          const source = params.get('chatSource')
          if (id && profile && source) {await store.directory.openSession(profile, id, source)}
          return
        }
        if (visible === 'library') {setLibraryRefreshToken((value) => value + 1); return}
        if (visible === 'conversation' || visible === 'details') {await Promise.all([store.refreshSessions(), store.refreshAttention()])}
      },
      shouldRefresh: () => !(document.activeElement instanceof HTMLTextAreaElement && Boolean(document.activeElement.closest('.composer'))),
      intervalMs: () => ['sending', 'submitting', 'streaming', 'stopping'].includes(store.getSnapshot().turnStatus) ? 5_000 : 20_000,
      onRefreshed: setRefreshedAt
    })
    refreshLifecycleRef.current = lifecycle

    return () => {refreshLifecycleRef.current = null; lifecycle.destroy()}
  }, [store])

  useEffect(() => {void refreshLifecycleRef.current?.refresh()}, [screen])
  useEffect(() => {refreshLifecycleRef.current?.reschedule()}, [companion.turnStatus])

  useEffect(() => {
    const updateMobileLayout = () => setMobileLayout(window.innerWidth <= 780)

    window.addEventListener('resize', updateMobileLayout)

    return () => window.removeEventListener('resize', updateMobileLayout)
  }, [])

  useEffect(() => {
    if (drawerOpen) {
      drawerWasOpen.current = true
      requestAnimationFrame(() => drawerRef.current?.querySelector<HTMLButtonElement>('button')?.focus())
      const closeOnEscape = (event: KeyboardEvent) => {if (event.key === 'Escape') {setDrawerOpen(false)}}
      window.addEventListener('keydown', closeOnEscape)
      return () => window.removeEventListener('keydown', closeOnEscape)
    }

    if (drawerWasOpen.current) {drawerWasOpen.current = false; menuButtonRef.current?.focus()}
  }, [drawerOpen])

  useEffect(() => {
    if (!fixtureMode || store !== defaultStore || fixtureStarted.current) {return}
    fixtureStarted.current = true
    void store.configure({ baseUrl: 'http://fixture.invalid', token: 'fixture-qa-token' })
  }, [store])

  useEffect(() => {
    if (initialFocus.current) {
      initialFocus.current = false

      return
    }

    mainRef.current?.scrollTo?.({ top: 0 })

    if (window.innerWidth <= 780) {
      window.scrollTo?.({ top: 0 })
    }

    mainRef.current?.focus({ preventScroll: true })
  }, [screen])

  useEffect(() => {
    const restore = () => {
      const params = new URLSearchParams(window.location.search)
      const view = params.get('view') as Screen | null
      setLocationSearch(window.location.search)
      setScreen(view && primaryScreens.has(view) ? view : 'work')
    }

    window.addEventListener('popstate', restore)

    return () => window.removeEventListener('popstate', restore)
  }, [])

  const navigate = (nextScreen: Screen, params = new URLSearchParams(locationSearch)) => {
    if (primaryScreens.has(nextScreen)) {params.set('view', nextScreen)}
    window.history.pushState({}, '', `${window.location.pathname}?${params.toString()}`)
    setLocationSearch(window.location.search)
    setScreen(nextScreen)
  }

  const navigateParams = (params: URLSearchParams) => {
    const requested = params.get('view') as Screen | null
    navigate(requested && primaryScreens.has(requested) ? requested : screen, params)
  }

  const libraryRelationshipContext = useMemo<LibraryRelationshipContext | undefined>(() => {
    const params = new URLSearchParams(locationSearch)
    const profile = params.get('libraryProfile')
    const projectId = params.get('libraryProject')
    const topicId = params.get('libraryTopic')
    const sessionId = params.get('librarySession')

    const projectMatches = projectId ? directory.projects.filter((item) => item.id === projectId && item.profile === profile) : []

    const project = directory.selectedProject?.project.id === projectId && directory.selectedProject.project.profile === profile
      ? directory.selectedProject.project
      : projectMatches.length === 1 ? projectMatches[0] : undefined

    if (projectId && project) {
      return { projects: [{ id: project.id, title: project.title, backend_namespace: project.source, profile: project.profile }], topics: [], sessions: [] }
    }

    const topicMatches = topicId ? directory.topics.filter((item) => item.id === topicId && item.profile === profile) : []

    const topicDetail = directory.selectedTopic?.topic.id === topicId && directory.selectedTopic.profile === profile
      ? directory.selectedTopic
      : undefined

    const topic = topicDetail
      ? { id: topicDetail.topic.id, title: topicDetail.topic.name, backend_namespace: topicDetail.backend_namespace, profile: topicDetail.profile }
      : topicMatches.length === 1
        ? { id: topicMatches[0].id, title: topicMatches[0].name, backend_namespace: topicMatches[0].source, profile: topicMatches[0].profile }
        : undefined

    if (topicId && topic) {
      return { projects: [], topics: [topic], sessions: [] }
    }

    const sessionMatches = sessionId ? directory.sessions.filter((item) => item.id === sessionId && item.profile === profile) : []

    const selectedSession = directory.selectedSession?.id === sessionId && directory.selectedSession.profile === profile
      ? directory.selectedSession
      : sessionMatches.length === 1 ? sessionMatches[0] : undefined

    if (sessionId && selectedSession) {
      return { projects: [], topics: [], sessions: [{ id: selectedSession.id, title: selectedSession.title, backend_namespace: selectedSession.source, profile: selectedSession.profile, relationship: 'primary' }] }
    }

    if (sessionId && directory.history?.session_id === sessionId && directory.history.profile === profile) {
      return { projects: [], topics: [], sessions: [{ id: directory.history.session_id, backend_namespace: directory.history.source, profile: directory.history.profile, relationship: 'primary' }] }
    }

    return undefined
  }, [directory.history, directory.projects, directory.selectedProject, directory.selectedSession, directory.selectedTopic, directory.sessions, directory.topics, locationSearch])

  useEffect(() => {
    if (screen !== 'library' || companion.phase !== 'ready') {
      restoredLibraryRelationship.current = ''

      return
    }

    const params = new URLSearchParams(locationSearch)
    const profile = params.get('libraryProfile')

    const relations = [
      ['project', params.get('libraryProject')],
      ['topic', params.get('libraryTopic')],
      ['session', params.get('librarySession')]
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))

    if (!profile || relations.length !== 1 || libraryRelationshipContext) {return}
    const [kind, id] = relations[0]
    const key = JSON.stringify([profile, kind, id])

    if (restoredLibraryRelationship.current === key) {return}
    restoredLibraryRelationship.current = key

    if (kind === 'project') {void store.directory.openProject(profile, id)}
    else if (kind === 'topic') {void store.directory.openTopic(profile, id)}
    else {void store.directory.openSession(profile, id)}
  }, [companion.phase, libraryRelationshipContext, locationSearch, screen, store])

  useEffect(() => {
    if (screen !== 'work' || companion.phase !== 'ready') {
      restoredDirectoryFocus.current = ''

      return
    }

    const params = new URLSearchParams(locationSearch)
    const focus = params.get('focus')
    const profile = params.get('focusProfile')
    const source = params.get('focusSource') ?? undefined
    const section = params.get('section')
    const chat = params.get('chat') ?? (section === 'sessions' ? focus : null)
    const chatProfile = params.get('chatProfile') ?? (section === 'sessions' ? profile : null)
    const chatSource = params.get('chatSource') ?? (section === 'sessions' ? source : null)
    const requestedVisibility = params.get('visibility') ?? params.get('archive')

    const archive = (['current', 'all', 'hidden', 'archived'].includes(requestedVisibility ?? '')
      ? requestedVisibility
      : section === 'sessions' || params.has('chatQ') ? 'all' : 'current') as 'current' | 'all' | 'hidden' | 'archived'

    const collections = params.getAll('collection').filter(Boolean)
    const lifecycles = params.getAll('lifecycle').filter((value): value is 'active' | 'completed' | 'archived' => ['active', 'completed', 'archived'].includes(value))
    const verified = params.get('verified') === 'true' ? true : undefined
    const topicSort = params.get('sort') === 'name' ? 'name' : 'updated'
    const sources = params.getAll('source').filter(Boolean).sort()
    const origins = params.getAll('origin').filter(Boolean).sort()
    const search = params.get('chatQ') ?? params.get('q') ?? ''
    const key = JSON.stringify([search, archive, section, source, profile, focus, chat, chatProfile, chatSource, sources, origins, collections, lifecycles, verified, topicSort])

    if (restoredDirectoryFocus.current === key) {return}
    restoredDirectoryFocus.current = key
    let active = true

    void (async () => {
      await store.directory.setBrowseQuery({ search, archive, sources, origins, collections, lifecycles, verified, topicSort })

      if (!active || restoredDirectoryFocus.current !== key) {return}

      if (chat && chatProfile && chatSource) {
        mainRef.current?.scrollTo?.({ top: 0 })
        await store.directory.openSession(chatProfile, chat, chatSource)

        return
      }

      if (!focus || !profile) {
        store.directory.clearDetail()

        return
      }

      mainRef.current?.scrollTo?.({ top: 0 })

      if (section === 'projects') {await store.directory.openProject(profile, focus, source)}

      if (section === 'sessions') {await store.directory.openSession(profile, focus, source)}

      if (section === 'topics') {await store.directory.openTopic(profile, focus, source)}
    })()

    return () => {active = false}
  }, [companion.phase, locationSearch, screen, store])

  if (companion.phase === 'setup' || companion.phase === 'connecting') {
    return <SetupScreen canForgetSavedToken={companion.canForgetSavedToken} connecting={companion.phase === 'connecting'} error={companion.error} hasSavedToken={companion.hasSavedToken} initialBaseUrl={companion.baseUrl} onConnect={(baseUrl, token) => store.configure({ baseUrl, token })} onForgetSavedToken={store.forgetSavedToken} onOwnerConnect={(baseUrl) => store.configureOwner({ baseUrl })} ownerAuthAvailable={companion.ownerAuthAvailable} storesTokenEncrypted={companion.storesTokenEncrypted} warnings={companion.warnings} />
  }

  const openTeammate = (teammate: Teammate) => {
    if (!profileOptions.some((option) => option.teammateId === teammate.id && option.selectable)) {return}
    void store.selectTeammate(teammate.id)
    setScreen('details')
  }

  const backToConversations = () => {
    const params = new URLSearchParams(locationSearch)

    if (params.get('view') === 'work' && params.has('chat')) {
      params.delete('chat'); params.delete('chatProfile'); params.delete('chatSource')
      window.history.pushState({}, '', `${window.location.pathname}?${params.toString()}`)
      setLocationSearch(window.location.search)
      setScreen('work')
    } else {navigate('work')}
  }

  const content = (() => {
    if (((companion.phase === 'disconnected' || companion.phase === 'recovering') && screen !== 'needs') || screen === 'recovery') {
      return <><Recovery error={companion.error} hasDraft={Boolean(companion.draft)} onBack={companion.phase === 'disconnected' ? undefined : () => navigate('needs')} onRetry={() => void store.recover()} recovering={companion.phase === 'recovering'} teammateName={selected?.name} turnUncertain={companion.turnStatus === 'uncertain'} />
        <OwnerSignIn baseUrl={companion.baseUrl} onOwnerConnect={store.connectOwner} onOwnerSignOut={store.signOutOwner} ownerConnected={false} /></>
    }

    if (screen === 'conversation') {
      const activeTarget = companion.activeSession?.target
      const directorySession = activeTarget
        ? [directory.selectedSession, ...directory.sessions].find((session) => session?.id === activeTarget.stored_session_id
            && session.profile === activeTarget.profile && session.source === activeTarget.backend_namespace)
        : directory.selectedSession?.id === companion.storedSessionId
          ? directory.selectedSession
          : directory.sessions.find((session) => session.id === companion.storedSessionId)
      const projectLabel = directorySession?.project === null
        ? appCopy.project.none
        : directorySession?.project?.title ?? appCopy.project.unknown

      return selected
        ? <Conversation approval={companion.pendingApproval} completedAt={directorySession?.last_active} connected={companion.phase === 'ready'} draft={companion.draft} error={Boolean(companion.error)} messages={companion.messages} onApproval={(choice) => void store.respondToApproval(choice)} onBackToSessions={backToConversations} onDraftChange={store.setDraft} onInterrupt={() => void store.interrupt()} onSubmit={() => void store.submitDraft().catch(() => undefined)} projectLabel={projectLabel} refreshedAt={refreshedAt} sessionKey={transcriptSessionKey(companion.activeSession?.target?.backend_namespace ?? '', companion.activeSession?.target?.profile ?? selected.id, companion.activeSession?.target?.stored_session_id ?? companion.storedSessionId ?? 'canonical')} sessionStatus={directorySession?.status} sessionTitle={companion.activeSession?.title} streamingText={companion.streamingText} teammate={selected} turnStatus={companion.turnStatus} />
        : <ChooseTeammate onBack={() => navigate('work')} />
    }

    if (screen === 'needs') {return <>
      {companion.phase !== 'ready' && <button className="button reconnect-button" disabled={companion.phase === 'recovering'} onClick={() => void store.recover()} type="button">{appCopy.reconnectToVerify}</button>}
      <OwnerSignIn baseUrl={companion.baseUrl} onOwnerConnect={store.connectOwner} onOwnerSignOut={store.signOutOwner} ownerConnected={companion.connectionMode === 'owner' && companion.phase === 'ready'} />
      <WorkInbox {...work} onClose={store.work.close} onComment={store.work.comment} onDecision={store.work.decide} onGroupBy={(groupBy) => void store.work.setGroupBy(groupBy)} onOpen={(profile, id) => void store.work.open(profile, id)} onOpenArtifact={(profile, reference) => navigate('library', libraryAssetParams(profile, reference))} onOpenProject={(project) => navigate('work', new URLSearchParams({ view: 'work', section: 'projects', focus: project.source_id, focusProfile: project.profile, focusSource: project.backend_namespace }))} onOpenSourceSession={(source) => navigate('work', new URLSearchParams({ view: 'work', section: 'sessions', focus: source.id, focusProfile: source.profile, focusSource: source.backend }))} onPriority={store.work.setPriority} onRefresh={() => void store.work.refresh()} onRestorePriority={store.work.restoreRecommended} />
      <NeedsMe items={canonicalRuntimeAttention} onOpen={(item) => { if (companion.phase === 'ready') { const params = new URLSearchParams(locationSearch); params.set('view', 'needs'); params.set('request', item.id); params.set('runtimeSession', item.runtime_session_id); window.history.pushState({}, '', `${window.location.pathname}?${params.toString()}`); setLocationSearch(window.location.search); void store.openAttention(item).then(() => setScreen('conversation')) } }} onRefresh={() => void store.refreshAttention()} scope={companion.attentionScope} />
    </>}

    if (screen === 'work') {
      const params = new URLSearchParams(locationSearch)

      const directoryProps = {
        ...(hasOriginalRouteCapability() ? { onOpenOriginal: openOriginalRoute } : {}),
        onBack: store.directory.clearDetail,
        onLoadOlder: (kind: 'sessions' | 'projects' | 'topics', profile: string) => void store.directory.loadOlder(kind, profile),
        onLoadOlderHistory: () => void store.directory.loadOlderHistory(),
        onLoadOlderProjectSessions: () => void store.directory.loadOlderProjectSessions(),
        onNavigate: navigateParams,
        onRefresh: () => void store.directory.refresh(),
        params,
        snapshot: directory
      }

      if (params.get('section') === 'projects' || params.get('section') === 'topics') {
        return <WorkDirectory {...directoryProps} />
      }

      return <ChatsDirectory {...directoryProps} draft={companion.draft} onActivateSessionDraft={store.activateSessionDraft} onDraftChange={store.setDraft} onOpenSession={(item) => { store.activateSessionDraft({ backend_namespace: item.source, profile: item.profile, stored_session_id: item.id }); params.set('view', 'work'); params.set('chat', item.id); params.set('chatProfile', item.profile); params.set('chatSource', item.source); params.set('chatScroll', String(window.innerWidth <= 780 ? window.scrollY : mainRef.current?.scrollTop ?? 0)); navigateParams(params) }} profileOptions={profileOptions} {...(companion.connectionMode === 'owner' ? { onCreateConversation: async (teammateId: string, text: string) => { const result = await store.submitQuickTask(teammateId, text); if (result.status === 'admitted') {setScreen('conversation')} return result }, onSubmitSession: async (item, text) => { await store.openPersistedSession({ backend_namespace: item.source, profile: item.profile, stored_session_id: item.id }, text, item.title); setScreen('conversation') } } : {})} />
    }

    if (screen === 'library') {return <Library gateway={store.library} onNavigate={navigateParams} params={new URLSearchParams(locationSearch)} refreshToken={libraryRefreshToken} relationshipContext={libraryRelationshipContext} />}

    if (screen === 'settings') {return <section className="settings-screen"><p className="kicker">{appCopy.settings.kicker}</p><h2>{appCopy.settings.title}</h2><p className="screen-lede">{appCopy.settings.detail}</p><div className="settings-brand"><Wordmark /><span>{appCopy.branding.version}</span><BuildStamp /></div><OwnerSignIn baseUrl={companion.baseUrl} onOwnerConnect={store.connectOwner} onOwnerSignOut={store.signOutOwner} ownerConnected={companion.connectionMode === 'owner' && companion.phase === 'ready'} /></section>}

    if (screen === 'details' && selected) {return <TeammateDetails onBack={() => navigate('work')} onMessage={() => setScreen('conversation')} onOpenSession={(id) => { void store.selectTeammate(selected.id, id).then(() => setScreen('conversation')) }} onPin={(id, pinned) => void store.setSessionPinned(id, pinned)} sessions={companion.recentSessions} sessionsLoading={companion.sessionsLoading} teammate={selected} />}

    return <ChooseTeammate onBack={() => navigate('work')} />
  })()

  const savedHeaderSession = savedConversationOpen
    ? [directory.selectedSession, ...directory.sessions].find((item) => item?.id === routeParams.get('chat') && item.profile === routeParams.get('chatProfile') && item.source === routeParams.get('chatSource'))
    : undefined
  const activeHeaderTarget = screen === 'conversation' ? companion.activeSession?.target : null
  const activeHeaderSession = activeHeaderTarget
    ? [directory.selectedSession, ...directory.sessions].find((item) => item?.id === activeHeaderTarget.stored_session_id && item?.profile === activeHeaderTarget.profile && item?.source === activeHeaderTarget.backend_namespace)
    : undefined
  const headerTitle = screen === 'conversation'
    ? companion.activeSession?.title || conversationCopy.fallbackSessionTitle
    : savedConversationOpen
      ? savedHeaderSession?.title || conversationCopy.fallbackSessionTitle
      : screen === 'details' && selected
        ? selected.name
        : screen === 'needs' && work.selected
          ? work.selected.title
          : screen === 'needs'
            ? workCopy.chrome.title
          : screenTitles[screen]
  const headerState = screen === 'conversation'
    ? deriveConversationState({ turnStatus: companion.turnStatus, approvalPending: Boolean(companion.pendingApproval), error: Boolean(companion.error), sessionStatus: activeHeaderSession?.status })
    : savedConversationOpen
      ? deriveConversationState({ sessionStatus: savedHeaderSession?.status })
      : null
  const headerTime = conversationOpen ? formatConversationTime(screen === 'conversation' ? refreshedAt : directory.history?.coverage.freshness) : null
  const refreshable = (screen === 'needs' || screen === 'work' || screen === 'library') && !conversationOpen

  return (
    <div className="app-shell app-shell--two-column">
      <header aria-label={headerTitle} className={`mobile-header${conversationOpen ? ' mobile-header--conversation' : ''}`}>
        <button aria-expanded={drawerOpen} aria-label={appCopy.navigation.openDrawer} className="menu-button" onClick={() => setDrawerOpen(true)} ref={menuButtonRef} type="button"><span aria-hidden="true">☰</span></button>
        {conversationOpen && mobileLayout && <button aria-label={conversationCopy.backToSessions(savedHeaderSession?.profile ?? selected?.name ?? '')} className="mobile-header__back" onClick={backToConversations} type="button">←</button>}
        <div className="mobile-header__title" title={headerTitle}>{headerTitle}</div>
        {headerState && <span className={`conversation-state conversation-state--${headerState.kind}`}>{headerState.label}</span>}
        {headerTime && <time className="conversation-updated" title={conversationCopy.state.updated(headerTime)}><span className="conversation-updated__prefix">{conversationCopy.state.updatedPrefix}</span>{headerTime}</time>}
      </header>
      {drawerOpen && <div className="drawer-layer"><button aria-label={appCopy.navigation.closeDrawer} className="drawer-backdrop" onClick={() => setDrawerOpen(false)} type="button" /><aside aria-label={appCopy.navigation.drawer} aria-modal="true" className="mobile-drawer" ref={drawerRef} role="dialog"><Wordmark /><nav aria-label={appCopy.navigation.mobile} className="drawer-nav"><NavButton active={screen === 'work'} icon="◇" label={appCopy.navigation.conversations} onClick={() => {setDrawerOpen(false); navigate('work')}} /><NavButton active={screen === 'needs' || screen === 'recovery'} badge={attentionCount ? String(attentionCount) : undefined} icon="!" label={appCopy.navigation.decisions} onClick={() => {setDrawerOpen(false); navigate('needs')}} /><NavButton active={screen === 'library'} icon="▤" label={appCopy.navigation.files} onClick={() => {setDrawerOpen(false); navigate('library')}} /><NavButton active={screen === 'settings'} icon="⚙" label={appCopy.navigation.settings} onClick={() => {setDrawerOpen(false); navigate('settings')}} />{refreshable && <button className="nav-button" disabled={foregroundTurn} onClick={() => {setDrawerOpen(false); void refreshLifecycleRef.current?.refresh()}} type="button"><span aria-hidden="true" className="nav-button__icon">↻</span><span>{appCopy.refresh.action}</span></button>}</nav><footer className="drawer-brand"><span>{appCopy.branding.product}</span><BuildStamp /></footer></aside></div>}
      <aside className="left-rail">
        <Wordmark />
        <nav aria-label={appCopy.navigation.main} className="primary-nav">
          <NavButton active={screen === 'work'} icon="◇" label={appCopy.navigation.conversations} onClick={() => navigate('work')} />
          <NavButton active={screen === 'needs' || screen === 'recovery'} badge={attentionCount ? String(attentionCount) : undefined} icon="!" label={appCopy.navigation.decisions} onClick={() => navigate('needs')} />
          <NavButton active={screen === 'library'} icon="▤" label={appCopy.navigation.files} onClick={() => navigate('library')} />
        </nav>
        <div className="rail-roster"><div className="rail-section-title"><span>{appCopy.profile.section}</span><span>{profileOptions.filter((option) => option.selectable).length}</span></div><Roster availability={profileOptions} compact onSelect={openTeammate} teammates={companion.teammates} /></div>
        <div className="connection"><span aria-hidden="true" /><div><strong>{appCopy.profile.ready}</strong><small>{appCopy.profile.count(companion.teammates.length)} · v{__COMPANION_VERSION__}</small></div></div>
      </aside>
      <main aria-label={screenTitles[screen]} className={`main-content${conversationOpen ? ' main-content--conversation' : ''}`} ref={mainRef} tabIndex={-1}>
        {!conversationOpen && <header className="desktop-topbar"><strong>{headerTitle}</strong><span aria-label={appCopy.profile.companionUser} className="avatar avatar--user" role="img">CU</span></header>}
        {companion.error && <div className="decision-toast" role="alert">{companion.error}</div>}
        <PullToRefresh enabled={refreshable && !foregroundTurn} onRefresh={async () => {await refreshLifecycleRef.current?.refresh()}}>{content}</PullToRefresh>
      </main>
    </div>
  )
}

function SetupScreen({ initialBaseUrl, warnings, connecting, error, hasSavedToken, canForgetSavedToken, storesTokenEncrypted, ownerAuthAvailable, onConnect, onOwnerConnect, onForgetSavedToken }: { initialBaseUrl: string; warnings: readonly string[]; connecting: boolean; error: string | null; hasSavedToken: boolean; canForgetSavedToken: boolean; storesTokenEncrypted: boolean; ownerAuthAvailable: boolean; onConnect: (baseUrl: string, token: string) => void; onOwnerConnect: (baseUrl: string) => void; onForgetSavedToken: () => void | Promise<void> }) {
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl)
  const [token, setToken] = useState('')

  const storageCopy = storesTokenEncrypted
    ? appCopy.setup.encryptedStorage
    : appCopy.setup.sessionStorage

  return <main aria-labelledby="setup-title" className="recovery-screen"><section className="recovery-card"><Wordmark /><BuildStamp /><p className="kicker">{appCopy.setup.kicker}</p><h1 id="setup-title">{appCopy.setup.title}</h1><p>{appCopy.setup.lede} {storageCopy}</p><form onSubmit={(event) => { event.preventDefault(); onConnect(baseUrl, token) }}><label>{appCopy.setup.baseUrl}<input autoComplete="url" onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://localhost:8642" required type="url" value={baseUrl} /></label>{ownerAuthAvailable ? <><button className="primary-button" disabled={connecting || !baseUrl.trim()} onClick={() => onOwnerConnect(baseUrl)} type="button">{connecting ? appCopy.setup.connecting : appCopy.setup.ownerConnect}</button><p role="status">{appCopy.setup.ownerExplanation}</p></> : <p role="status">{appCopy.setup.nativeBridgeRequired}</p>}<label>{appCopy.setup.sessionToken}<input autoComplete="off" onChange={(event) => setToken(event.target.value)} placeholder={hasSavedToken ? appCopy.setup.savedTokenPlaceholder : undefined} required={!hasSavedToken} type="password" value={token} /></label>{hasSavedToken && <p role="status">{appCopy.setup.savedTokenAvailable}</p>}{warnings.map((warning) => <p key={warning} role="status">{warning}</p>)}{error && <p role="alert">{error}</p>}<button className={ownerAuthAvailable ? undefined : 'primary-button'} disabled={connecting} type="submit">{connecting ? appCopy.setup.connecting : hasSavedToken && !token ? appCopy.setup.useSavedToken : appCopy.setup.connectPrivately}</button>{canForgetSavedToken && <button disabled={connecting} onClick={onForgetSavedToken} type="button">{appCopy.setup.forgetSavedToken}</button>}</form></section></main>
}

function Wordmark() { return <div className="wordmark"><span aria-hidden="true" className="wordmark__sigil">H+</span><span>Hermes<strong>Companion</strong></span></div> }

function BuildStamp() { return <small className="build-stamp">v{__COMPANION_VERSION__} · {__COMPANION_GIT_COMMIT__.slice(0, 8)}</small> }
interface NavButtonProps { active: boolean; icon: string; label: string; onClick: () => void; badge?: string }

function NavButton({ active, icon, label, onClick, badge }: NavButtonProps) { return <button aria-current={active ? 'page' : undefined} aria-label={badge ? appCopy.navigation.badgeLabel(label, badge) : undefined} className={`nav-button${active ? ' nav-button--active' : ''}`} onClick={onClick} type="button"><span aria-hidden="true" className="nav-button__icon">{icon}</span><span>{label}</span>{badge && <span aria-hidden="true" className="nav-badge">{badge}</span>}</button> }

function ChooseTeammate({ onBack }: { onBack: () => void }) { return <section className="search-empty"><h2>{appCopy.chooseProfile.title}</h2><p>{appCopy.chooseProfile.detail}</p><button className="primary-button" onClick={onBack} type="button">{appCopy.chooseProfile.back}</button></section> }
