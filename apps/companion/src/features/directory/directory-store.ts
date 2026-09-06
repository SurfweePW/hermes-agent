import type { TopicCoverage, TopicDetail, TopicItem, TopicLifecycle, TopicListOptions, TopicListResult } from '../../gateway/topic-types'
import type {
  CompanionProject,
  CompanionProjectDetail,
  CompanionProjectListOptions,
  CompanionProjectListResult,
  CompanionSession,
  CompanionSessionHistoryResult,
  CompanionSessionListOptions,
  CompanionSessionListResult
} from '../../gateway/types'

export type DirectoryStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error' | 'offline'
export interface SourceCoverage {
  profile: string
  status: DirectoryStatus
  complete: boolean
  freshness: string | null
  message: string | null
  sessionCursor: string | null
  projectCursor: string | null
  sessionsHasMore: boolean
  projectsHasMore: boolean
  sessionComplete: boolean
  projectComplete: boolean
  sessionStatus: DirectoryStatus
  projectStatus: DirectoryStatus
}
export interface TopicSourceCoverage {
  profile: string
  status: DirectoryStatus
  coverage: TopicCoverage | null
  message: string | null
  cursor: string | null
  hasMore: boolean
  loaded: number
  total: number | null
  backendNamespace: string | null
}
export interface DirectoryTopic extends TopicItem { profile: string; source: string }
export interface DirectoryGateway {
  listCompanionSessions(options: CompanionSessionListOptions): Promise<CompanionSessionListResult>
  getCompanionSessionHistory(profile: string, id: string, cursor?: string, expectedSource?: string): Promise<CompanionSessionHistoryResult>
  listCompanionProjects(options: CompanionProjectListOptions): Promise<CompanionProjectListResult>
  getCompanionProject(profile: string, id: string, cursor?: string): Promise<CompanionProjectDetail>
  listCompanionTopics(options: TopicListOptions): Promise<TopicListResult>
  getCompanionTopic(profile: string, id: string): Promise<TopicDetail>
}
export interface DirectorySnapshot {
  sessions: readonly CompanionSession[]
  projects: readonly CompanionProject[]
  selectedProject: CompanionProjectDetail | null
  selectedSession: CompanionSession | null
  history: CompanionSessionHistoryResult | null
  topics: readonly DirectoryTopic[]
  selectedTopic: TopicDetail | null
  topicCoverage: readonly TopicSourceCoverage[]
  detailStatus: DirectoryStatus
  detailMessage: string | null
  coverage: readonly SourceCoverage[]
}
export interface DirectoryStore {
  getSnapshot(): DirectorySnapshot
  subscribe(listener: () => void): () => void
  attach(gateway: Partial<DirectoryGateway>, profiles: string[]): Promise<void>
  disconnect(): void
  reset(): void
  refresh(): Promise<void>
  setBrowseQuery(query: { search: string; archive: 'current' | 'all' | 'hidden' | 'archived'; sources?: string[]; origins?: string[]; collections?: string[]; lifecycles?: TopicLifecycle[]; verified?: boolean; topicSort?: 'updated' | 'name' }): Promise<void>
  loadOlder(kind: 'sessions' | 'projects' | 'topics', profile: string): Promise<void>
  loadOlderHistory(): Promise<void>
  loadOlderProjectSessions(): Promise<void>
  openProject(profile: string, id: string, source?: string): Promise<void>
  openSession(profile: string, id: string, source?: string): Promise<void>
  openTopic(profile: string, id: string, source?: string): Promise<void>
  clearDetail(): void
}

const sourceKey = (source: string, profile: string, id: string) => JSON.stringify([source, profile, id])
const errorCode = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : undefined
const unsupported = (error: unknown) => errorCode(error) === -32601 || (error instanceof Error && /method not found|unknown method|-32601/i.test(error.message))
const initialSnapshot = (): DirectorySnapshot => ({ sessions: [], projects: [], topics: [], selectedProject: null, selectedSession: null, selectedTopic: null, history: null, detailStatus: 'idle', detailMessage: null, coverage: [], topicCoverage: [] })

const pendingCoverage = (profile: string): SourceCoverage => ({
  profile,
  status: 'loading',
  complete: false,
  freshness: null,
  message: null,
  sessionCursor: null,
  projectCursor: null,
  sessionsHasMore: false,
  projectsHasMore: false,
  sessionComplete: false,
  projectComplete: false,
  sessionStatus: 'loading',
  projectStatus: 'loading'
})

const failureStatus = (error: unknown): DirectoryStatus => unsupported(error) ? 'unsupported' : 'error'
const failureCopy = (kind: 'Sessions' | 'Projects', error: unknown) => `${kind} ${unsupported(error) ? 'require a backend update.' : 'could not be verified.'}`

/** Feature-owned, read-only projection. Gateway responses remain authoritative. */
export function createDirectoryStore(): DirectoryStore {
  let snapshot = initialSnapshot()
  let gateway: DirectoryGateway | null = null
  let profiles: string[] = []
  let epoch = 0
  let selection: { kind: 'project' | 'session' | 'topic'; profile: string; id: string; source?: string } | null = null
  let browseQuery: { search: string; archive: 'current' | 'all' | 'hidden' | 'archived'; sources: string[]; origins: string[] } = { search: '', archive: 'all', sources: [], origins: [] }
  let topicQuery: { collections: string[]; lifecycles: TopicLifecycle[]; verified?: boolean; sort: 'updated' | 'name' } = { collections: [], lifecycles: [], sort: 'updated' }
  const listeners = new Set<() => void>()
  const sessions = new Map<string, CompanionSession>()
  const projects = new Map<string, CompanionProject>()
  const topics = new Map<string, DirectoryTopic>()
  const coverage = new Map<string, SourceCoverage>()
  const topicCoverage = new Map<string, TopicSourceCoverage>()
  let refreshInFlight: Promise<void> | null = null

  const publish = (change: Partial<DirectorySnapshot>) => {
    snapshot = { ...snapshot, ...change }

    for (const listener of listeners) {listener()}
  }

  const projection = () => ({ sessions: [...sessions.values()], projects: [...projects.values()], topics: [...topics.values()], coverage: [...coverage.values()], topicCoverage: [...topicCoverage.values()] })

  const purgeUnauthorized = () => {
    ++epoch; gateway = null; profiles = []; selection = null; refreshInFlight = null
    sessions.clear(); projects.clear(); topics.clear(); coverage.clear(); topicCoverage.clear()
    snapshot = { ...initialSnapshot(), detailStatus: 'error', detailMessage: 'Owner authorization expired. Sign in again to view persisted work.' }

    for (const listener of listeners) {listener()}
  }

  const loadTopics = async (client: DirectoryGateway, profile: string, generation: number, append = false) => {
    const previous = topicCoverage.get(profile)

    if (!client.listCompanionTopics) {
      topicCoverage.set(profile, { profile, status: 'unsupported', coverage: null, message: 'Backend update required for Topics.', cursor: null, hasMore: false, loaded: 0, total: null, backendNamespace: null })
      publish(projection())

      return
    }

    if (!append) {
      for (const key of topics.keys()) { if (key.startsWith(`${profile}\0`)) { topics.delete(key) } }
    }

    topicCoverage.set(profile, append
      ? { profile, status: 'loading', coverage: previous?.coverage ?? null, message: previous?.message ?? null, cursor: previous?.cursor ?? null, hasMore: previous?.hasMore ?? false, loaded: previous?.loaded ?? 0, total: previous?.total ?? null, backendNamespace: previous?.backendNamespace ?? null }
      : { profile, status: 'loading', coverage: null, message: null, cursor: null, hasMore: false, loaded: 0, total: null, backendNamespace: null })
    publish(projection())

    try {
      const result = await client.listCompanionTopics({ profile, limit: 50, query: browseQuery.search || undefined, collection: topicQuery.collections.length ? topicQuery.collections : undefined, lifecycle: topicQuery.lifecycles.length ? topicQuery.lifecycles : undefined, verified: topicQuery.verified, sort: topicQuery.sort, ...(append && previous?.cursor ? { cursor: previous.cursor } : {}) })

      if (generation !== epoch || gateway !== client) { return }

      for (const item of result.items) { topics.set(`${profile}\0${result.backend_namespace}\0${item.id}`, { ...item, profile, source: result.backend_namespace }) }
      const loaded = [...topics.keys()].filter((key) => key.startsWith(`${profile}\0`)).length

      if (loaded > result.total) { throw new Error('Topic pagination total changed within a snapshot.') }
      topicCoverage.set(profile, { profile, status: 'ready', coverage: result.coverage, message: result.warnings.join(' ') || null, cursor: result.next_cursor, hasMore: result.has_more, loaded, total: result.total, backendNamespace: result.backend_namespace })
      publish(projection())
    } catch (error) {
      if (generation !== epoch || gateway !== client) { return }
      if (errorCode(error) === 4403) {purgeUnauthorized(); return}
      topicCoverage.set(profile, append
        ? { profile, status: failureStatus(error), coverage: previous?.coverage ?? null, message: unsupported(error) ? 'Backend update required for Topics.' : 'Topics could not be verified.', cursor: previous?.cursor ?? null, hasMore: previous?.hasMore ?? false, loaded: previous?.loaded ?? 0, total: previous?.total ?? null, backendNamespace: previous?.backendNamespace ?? null }
        : { profile, status: failureStatus(error), coverage: null, message: unsupported(error) ? 'Backend update required for Topics.' : 'Topics could not be verified.', cursor: null, hasMore: false, loaded: 0, total: null, backendNamespace: null })
      publish(projection())
    }
  }

  const loadSource = async (client: DirectoryGateway, profile: string, generation: number, append: 'sessions' | 'projects' | null = null) => {
    const previous = coverage.get(profile) ?? pendingCoverage(profile)
    coverage.set(profile, {
      ...previous,
      status: 'loading',
      ...(append !== 'projects' ? { sessionStatus: 'loading' as const } : {}),
      ...(append !== 'sessions' ? { projectStatus: 'loading' as const } : {})
    })
    publish(projection())

    const [sessionSettled, projectSettled] = await Promise.allSettled([
      append === 'projects' ? null : client.listCompanionSessions({ profile, limit: 50, view: browseQuery.archive === 'current' ? 'active' : browseQuery.archive, ...(browseQuery.search ? { search: browseQuery.search } : {}), ...(browseQuery.sources.length ? { sources: browseQuery.sources } : {}), ...(browseQuery.origins.length ? { origins: browseQuery.origins } : {}), ...(append === 'sessions' && previous.sessionCursor ? { cursor: previous.sessionCursor } : {}) }),
      append === 'sessions' ? null : client.listCompanionProjects({ profile, limit: 50, ...(browseQuery.archive !== 'all' ? { archived: browseQuery.archive === 'archived' } : {}), ...(append === 'projects' && previous.projectCursor ? { cursor: previous.projectCursor } : {}) })
    ])

    if (generation !== epoch || gateway !== client) {return}

    const sessionResult = sessionSettled.status === 'fulfilled' ? sessionSettled.value : null
    const projectResult = projectSettled.status === 'fulfilled' ? projectSettled.value : null
    const sessionError = sessionSettled.status === 'rejected' ? sessionSettled.reason : null
    const projectError = projectSettled.status === 'rejected' ? projectSettled.reason : null

    if (errorCode(sessionError) === 4403 || errorCode(projectError) === 4403) {purgeUnauthorized(); return}

    if (sessionResult) {
      if (append !== 'sessions') {for (const [key, item] of sessions) {if (item.profile === profile) {sessions.delete(key)}}}

      for (const item of sessionResult.sessions) {sessions.set(sourceKey(item.source, item.profile, item.id), item)}
    }

    if (projectResult) {
      if (append !== 'projects') {for (const [key, item] of projects) {if (item.profile === profile) {projects.delete(key)}}}

      for (const item of projectResult.projects) {projects.set(sourceKey(item.source, item.profile, item.id), item)}
    }

    const sessionsHasMore = sessionResult?.has_more ?? previous.sessionsHasMore
    const projectsHasMore = projectResult?.has_more ?? previous.projectsHasMore
    const sessionComplete = sessionResult ? sessionResult.coverage.complete : previous.sessionComplete
    const projectComplete = projectResult ? projectResult.coverage.complete : previous.projectComplete
    const sessionStatus = sessionError ? failureStatus(sessionError) : (sessionResult ? 'ready' : previous.sessionStatus)
    const projectStatus = projectError ? failureStatus(projectError) : (projectResult ? 'ready' : previous.projectStatus)

    const status: DirectoryStatus = sessionStatus === 'ready' && projectStatus === 'ready'
      ? 'ready'
      : sessionStatus === 'unsupported' || projectStatus === 'unsupported' ? 'unsupported' : 'error'

    const messages = [
      ...(append ? [previous.message] : []),
      sessionResult?.coverage.message,
      projectResult?.coverage.message,
      sessionError ? failureCopy('Sessions', sessionError) : null,
      projectError ? failureCopy('Projects', projectError) : null
    ].filter((item): item is string => Boolean(item))

    coverage.set(profile, {
      profile,
      status,
      complete: sessionStatus === 'ready' && projectStatus === 'ready' && sessionComplete && projectComplete && !sessionsHasMore && !projectsHasMore,
      freshness: sessionResult?.coverage.freshness ?? projectResult?.coverage.freshness ?? previous.freshness,
      message: [...new Set(messages)].join(' ') || null,
      sessionCursor: sessionResult?.next_cursor ?? previous.sessionCursor,
      projectCursor: projectResult?.next_cursor ?? previous.projectCursor,
      sessionsHasMore,
      projectsHasMore,
      sessionComplete,
      projectComplete,
      sessionStatus,
      projectStatus
    })
    publish(projection())
  }

  const openProject = async (profile: string, id: string, source?: string, preserve = false) => {
    const client = gateway

    if (!client || !profiles.includes(profile)) {return}
    selection = { kind: 'project', profile, id, source }
    const generation = ++epoch
    publish({ ...(preserve ? {} : { selectedProject: null }), selectedSession: null, selectedTopic: null, history: null, detailStatus: 'loading', detailMessage: null })

    try {
      const detail = await client.getCompanionProject(profile, id)

      if (generation !== epoch || gateway !== client) {return}

      if (source && detail.project.source !== source) {throw new Error('Source identity changed while loading project details.')}
      projects.set(sourceKey(detail.project.source, detail.project.profile, detail.project.id), detail.project)
      publish({ ...projection(), selectedProject: detail, selectedSession: null, selectedTopic: null, history: null, detailStatus: 'ready' })
    } catch (error) {
      if (generation === epoch && gateway === client) {
        if (errorCode(error) === 4403) {purgeUnauthorized(); return}
        const isUnsupported = unsupported(error)
        publish({ detailStatus: isUnsupported ? 'unsupported' : 'error', detailMessage: isUnsupported ? 'Backend update required for project details.' : 'Project details could not be verified.' })
      }
    }
  }

  const openSession = async (profile: string, id: string, source?: string, preserve = false) => {
    const client = gateway

    if (!client || !profiles.includes(profile)) {return}

    const known = source
      ? sessions.get(sourceKey(source, profile, id))
      : [...sessions.values()].find((item) => item.profile === profile && item.id === id)

    selection = { kind: 'session', profile, id, source: source ?? known?.source }
    const generation = ++epoch
    publish({ selectedSession: preserve ? snapshot.selectedSession ?? known ?? null : known ?? null, selectedProject: null, selectedTopic: null, ...(preserve ? {} : { history: null }), detailStatus: 'loading', detailMessage: null })

    try {
      const result = await client.getCompanionSessionHistory(profile, id, undefined, source)

      if (generation !== epoch || gateway !== client) {return}

      if (source && result.source !== source) {throw new Error('Source identity changed while loading session history.')}
      const authoritative = known?.source === result.source ? known : null
      publish({ ...projection(), selectedSession: authoritative, history: result, detailStatus: 'ready' })
    } catch (error) {
      if (generation === epoch && gateway === client) {
        if (errorCode(error) === 4403) {purgeUnauthorized(); return}
        const isUnsupported = unsupported(error)
        publish({ detailStatus: isUnsupported ? 'unsupported' : 'error', detailMessage: isUnsupported ? 'Backend update required for persisted session history.' : 'Session history could not be verified.' })
      }
    }
  }

  const openTopic = async (profile: string, id: string, source?: string, preserve = false) => {
    const client = gateway

    if (!client?.getCompanionTopic || !profiles.includes(profile)) {return}
    selection = { kind: 'topic', profile, id, source }
    const generation = ++epoch
    publish({ selectedProject: null, selectedSession: null, history: null, ...(preserve ? {} : { selectedTopic: null }), detailStatus: 'loading', detailMessage: null })

    try {
      const detail = await client.getCompanionTopic(profile, id)

      if (generation !== epoch || gateway !== client) {return}

      if (source && detail.backend_namespace !== source) {throw new Error('Source identity changed while loading topic details.')}
      topics.set(`${profile}\0${detail.backend_namespace}\0${detail.topic.id}`, { ...detail.topic, profile, source: detail.backend_namespace })
      publish({ ...projection(), selectedTopic: detail, detailStatus: 'ready' })
    } catch (error) {
      if (generation === epoch && gateway === client) {
        if (errorCode(error) === 4403) {purgeUnauthorized(); return}
        publish({ detailStatus: failureStatus(error), detailMessage: unsupported(error) ? 'Backend update required for topic details.' : 'Topic details could not be verified.' })
      }
    }
  }

  const runRefresh = async () => {
    if (!gateway) {return}
    const client = gateway
    const generation = ++epoch
    await Promise.all(profiles.flatMap((profile) => [loadSource(client, profile, generation), loadTopics(client, profile, generation)]))

    if (generation !== epoch || gateway !== client || !selection) {return}

    if (selection.kind === 'project') {await openProject(selection.profile, selection.id, selection.source, true)}
    else if (selection.kind === 'session') {await openSession(selection.profile, selection.id, selection.source, true)}
    else {await openTopic(selection.profile, selection.id, selection.source, true)}
  }

  const refresh = (): Promise<void> => {
    if (refreshInFlight) {return refreshInFlight}
    const operation = runRefresh()
    refreshInFlight = operation
    void operation.finally(() => {if (refreshInFlight === operation) {refreshInFlight = null}})

    return operation
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {listeners.add(listener);

 return () => listeners.delete(listener)},
    async attach(candidate, nextProfiles) {
      ++epoch
      refreshInFlight = null
      profiles = [...new Set(nextProfiles)]
      selection = null
      sessions.clear(); projects.clear(); topics.clear(); coverage.clear(); topicCoverage.clear()

      for (const profile of profiles) {coverage.set(profile, pendingCoverage(profile))}

      for (const profile of profiles) {topicCoverage.set(profile, { profile, status: 'loading', coverage: null, message: null, cursor: null, hasMore: false, loaded: 0, total: null, backendNamespace: null })}

      if (!candidate.listCompanionSessions || !candidate.getCompanionSessionHistory || !candidate.listCompanionProjects || !candidate.getCompanionProject) {
        gateway = null

        for (const profile of profiles) {coverage.set(profile, { ...pendingCoverage(profile), status: 'unsupported', sessionStatus: 'unsupported', projectStatus: 'unsupported', message: 'Backend update required for complete browsing.' })}

        for (const profile of profiles) {topicCoverage.set(profile, { profile, status: 'unsupported', coverage: null, message: 'Backend update required for Topics.', cursor: null, hasMore: false, loaded: 0, total: null, backendNamespace: null })}
        publish({ ...projection(), selectedProject: null, selectedSession: null, selectedTopic: null, history: null, detailStatus: 'idle', detailMessage: null })

        return
      }

      gateway = candidate as DirectoryGateway
      publish({ ...projection(), selectedProject: null, selectedSession: null, selectedTopic: null, history: null, detailStatus: 'idle', detailMessage: null })
      await refresh()
    },
    disconnect() {
      ++epoch
      refreshInFlight = null
      gateway = null

      for (const [profile, item] of coverage) {coverage.set(profile, { ...item, status: 'offline', sessionStatus: 'offline', projectStatus: 'offline', complete: false, message: 'Reconnect to verify this source.' })}

      for (const [profile, item] of topicCoverage) {topicCoverage.set(profile, { ...item, status: 'offline', message: 'Reconnect to verify Topics.' })}
      publish({ ...projection(), selectedProject: null, selectedSession: null, selectedTopic: null, history: null, detailStatus: 'offline', detailMessage: 'Reconnect to verify details.' })
    },
    reset() {
      ++epoch; gateway = null; profiles = []; selection = null; refreshInFlight = null; sessions.clear(); projects.clear(); topics.clear(); coverage.clear(); topicCoverage.clear()
      snapshot = initialSnapshot()

      for (const listener of listeners) {listener()}
    },
    refresh,
    async setBrowseQuery(query) {
      const normalized = { search: query.search.trim(), archive: query.archive, sources: [...new Set(query.sources ?? [])].sort(), origins: [...new Set(query.origins ?? [])].sort() }
      const normalizedTopics = { collections: [...new Set(query.collections ?? [])].sort(), lifecycles: [...new Set(query.lifecycles ?? [])].sort(), verified: query.verified, sort: query.topicSort ?? 'updated' as const }

      if (JSON.stringify(normalized) === JSON.stringify(browseQuery) && JSON.stringify(normalizedTopics) === JSON.stringify(topicQuery)) {return}
      browseQuery = normalized
      topicQuery = normalizedTopics
      await refresh()

      // Projects have no title-search RPC. Complete their current query snapshot
      // before the view applies a local title match, so older matches are visible.
      if (browseQuery.search) {
        for (const profile of profiles) {
          while (gateway && coverage.get(profile)?.projectsHasMore) {await this.loadOlder('projects', profile)}
        }
      }
    },
    async loadOlder(kind, profile) {
      const client = gateway

      if (kind === 'topics') {
        const topic = topicCoverage.get(profile)

        if (!client || !topic?.hasMore || !topic.cursor) {return}
        await loadTopics(client, profile, ++epoch, true)

        return
      }

      const item = coverage.get(profile)

      if (!client || !item || (kind === 'sessions' ? !item.sessionsHasMore : !item.projectsHasMore)) {return}
      const generation = ++epoch
      await loadSource(client, profile, generation, kind)
    },
    async loadOlderHistory() {
      const client = gateway
      const current = snapshot.history

      if (!client || !selection || selection.kind !== 'session' || !current?.has_more || !current.next_cursor) {return}
      const generation = ++epoch
      publish({ detailStatus: 'loading', detailMessage: null })

      try {
        const next = await client.getCompanionSessionHistory(selection.profile, selection.id, current.next_cursor, selection.source)

        if (generation !== epoch || gateway !== client) {return}
        const seen = new Set(current.entries.map((entry) => entry.id))
        const coverageMessage = [current.coverage.message, next.coverage.message].filter((item): item is string => Boolean(item))
        publish({ history: { ...next, entries: [...current.entries, ...next.entries.filter((entry) => !seen.has(entry.id))], coverage: { ...next.coverage, complete: current.coverage.complete && next.coverage.complete, message: [...new Set(coverageMessage)].join(' ') || null } }, detailStatus: 'ready' })
      } catch (error) {
        if (generation === epoch && gateway === client) {
          if (errorCode(error) === 4403) {purgeUnauthorized(); return}
          publish({ detailStatus: 'error', detailMessage: 'Older history could not be verified.' })
        }
      }
    },
    async loadOlderProjectSessions() {
      const client = gateway
      const current = snapshot.selectedProject

      if (!client || !selection || selection.kind !== 'project' || !current?.membership_has_more || !current.membership_next_cursor) {return}
      const generation = ++epoch
      publish({ detailStatus: 'loading', detailMessage: null })

      try {
        const next = await client.getCompanionProject(selection.profile, selection.id, current.membership_next_cursor)

        if (generation !== epoch || gateway !== client) {return}

        if (selection.source && next.project.source !== selection.source) {throw new Error('Source identity changed while loading project membership.')}
        const seen = new Set(current.sessions.map((session) => sourceKey(session.source, session.profile, session.id)))
        publish({
          selectedProject: {
            ...next,
            sessions: [...current.sessions, ...next.sessions.filter((session) => !seen.has(sourceKey(session.source, session.profile, session.id)))],
            coverage: {
              ...next.coverage,
              complete: current.coverage.complete && next.coverage.complete,
              message: [...new Set([current.coverage.message, next.coverage.message].filter((item): item is string => Boolean(item)))].join(' ') || null
            }
          },
          detailStatus: 'ready'
        })
      } catch (error) {
        if (generation === epoch && gateway === client) {
          if (errorCode(error) === 4403) {purgeUnauthorized(); return}
          publish({ detailStatus: 'error', detailMessage: 'Complete project membership could not be verified.' })
        }
      }
    },
    openProject,
    openSession,
    openTopic,
    clearDetail() {selection = null; ++epoch; publish({ selectedProject: null, selectedSession: null, selectedTopic: null, history: null, detailStatus: 'idle', detailMessage: null })}
  }
}
