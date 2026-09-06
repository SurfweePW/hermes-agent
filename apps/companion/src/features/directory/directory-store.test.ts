import { describe, expect, it, vi } from 'vitest'

import type { NeedsMePriorityResult } from '../../gateway/organization-types'
import type { TopicDetail, TopicItem, TopicListResult } from '../../gateway/topic-types'
import type {
  CompanionProject,
  CompanionProjectDetail,
  CompanionSession,
  CompanionSessionHistoryResult
} from '../../gateway/types'
import type { WorkCard } from '../../gateway/work-types'

import { createDirectoryStore, type DirectoryGateway } from './directory-store'

const source = 'desktop-db'
const profile = 'atlas'

const topic: TopicItem = {
  id: 'topic-1', canonical_id: 'topic:atlas:topic-1', collection: 'operations', name: 'Companion launch',
  objective: 'Ship the read-only directory.', lifecycle: 'active', version: 1,
  created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-03T00:00:00.000Z',
  verified_status: { value: 'active', verified: true, authority: 'organization.topic.lifecycle', observed_at: '2026-09-03T00:00:00.000Z' },
  next_useful_action: { availability: 'unknown', coverage: 'unavailable', reason: 'No assessment is available.' },
  linked_work: { coverage: 'partial', organization_bindings: 'complete', source_records: 'unavailable', authorization_filtered: false }
}

const topicPage = (items: TopicItem[], hasMore = false, total = items.length): TopicListResult => ({
  items,
  total,
  has_more: hasMore,
  next_cursor: hasMore ? 'topics-2' : null,
  as_of: '2026-09-03T00:00:00.000Z',
  profile,
  backend_namespace: 'organization-db',
  coverage: {
    configured: true,
    status: 'complete',
    population: 'authorized topics',
    source: 'organization.db',
    freshness: { as_of: '2026-09-03T00:00:00.000Z', organization_updated_at: null },
    linked_collections: { needs_me: 'unavailable', work_source_records: 'unavailable', files: 'unavailable', source_details: 'unavailable' }
  },
  warnings: []
})

const topicDetail = (item = topic): TopicDetail => ({
  topic: item,
  overview: { objective: item.objective, next_useful_action: item.next_useful_action, verified_status: item.verified_status, coverage: { status: 'complete', authority: 'organization.db' } },
  needs_me: { items: null, coverage: { status: 'unavailable' } },
  work: { items: [], coverage: { status: 'complete' } },
  files: { items: null, coverage: { status: 'unavailable' } },
  sources: { items: [], coverage: { status: 'complete' } },
  tabs: ['overview', 'needs_me', 'work', 'files', 'sources'],
  as_of: '2026-09-03T00:00:00.000Z', profile, backend_namespace: 'organization-db',
  coverage: topicPage([]).coverage,
  warnings: []
})

const session = (id: string): CompanionSession => ({
  id,
  title: `Session ${id}`,
  profile,
  source,
  origin: 'desktop',
  opened_in: ['desktop'],
  archived: false,
  hidden: false,
  started_at: '2026-09-01T00:00:00.000Z',
  last_active: '2026-09-02T00:00:00.000Z',
  status: null,
  project: null,
  linked_work_count: null,
  message_count: 1
})

const project: CompanionProject = {
  id: 'project-1',
  title: 'Project one',
  profile,
  source,
  type: 'desktop_project',
  archived: false,
  last_active: '2026-09-02T00:00:00.000Z',
  session_count: 2,
  linked_work_count: null,
  freshness: '2026-09-03T00:00:00.000Z'
}

const history = (id: string): CompanionSessionHistoryResult => ({
  session_id: id,
  profile,
  source,
  entries: [{ id: `${id}-message`, kind: 'message', role: 'assistant', content: id, label: null, occurred_at: '2026-09-02T00:00:00.000Z' }],
  linked_work: [],
  linked_work_available: false,
  has_more: false,
  next_cursor: null,
  coverage: { complete: true, freshness: '2026-09-03T00:00:00.000Z', message: null }
})

const projectDetail = (sessions: CompanionSession[], hasMore = false): CompanionProjectDetail => ({
  project,
  sessions,
  topics: [],
  needs_me: [],
  work: [],
  organization_available: false,
  membership_has_more: hasMore,
  membership_next_cursor: hasMore ? 'next-page' : null,
  coverage: { complete: !hasMore, freshness: '2026-09-03T00:00:00.000Z', message: null }
})

function gateway(): DirectoryGateway {
  return {
    listCompanionSessions: vi.fn(async () => ({
      sessions: [session('one'), session('two')],
      has_more: false,
      next_cursor: null,
      coverage: { complete: true, freshness: '2026-09-03T00:00:00.000Z', message: null }
    })),
    listCompanionProjects: vi.fn(async () => ({
      projects: [project],
      has_more: false,
      next_cursor: null,
      coverage: { complete: true, freshness: '2026-09-03T00:00:00.000Z', message: null }
    })),
    getCompanionSessionHistory: vi.fn(async (_profile, id) => history(id)),
    getCompanionProject: vi.fn(async () => projectDetail([session('one')])),
    listCompanionTopics: vi.fn(async () => topicPage([])),
    getCompanionTopic: vi.fn(async () => topicDetail()),
    listNeedsMePriorities: vi.fn(async (_profile: string, _reviewId?: string, groupBy: 'topic' | 'session' | 'project' = 'topic'): Promise<NeedsMePriorityResult> => ({
      profile, backend_namespace: 'organization-db', sort: 'recommended', policy_version: 'v1', review_id: null, group_by: groupBy,
      groups: [], as_of: '2026-09-03T00:00:00.000Z', coverage: { work: 'complete', organization: 'complete', authorization_filtered: false }
    })),
    listWork: vi.fn(async () => ({ items: [] })),
    getWork: vi.fn(async () => { throw new Error('Unexpected work lookup') })
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {resolve = done})

  return { promise, resolve }
}

describe('createDirectoryStore', () => {
  it('hydrates authorized topic bindings with durable Work and Needs Me details', async () => {
    const client = gateway()

    const binding: NonNullable<TopicDetail['work']['items']>[number] = {
      id: 'binding-1', canonical_id: 'binding:launch-checklist', work_kind: 'task', source_work_id: 'launch-checklist',
      source_namespace: { backend_id: 'organization-db', profile }, relationship: 'primary', version: 1,
      updated_at: '2026-09-03T00:00:00.000Z', authorization_filtered: false,
      source_status: { availability: 'unknown', coverage: 'unavailable' }, primary_session: null, related_sessions: [], source_projects: []
    }

    const card: WorkCard = {
      id: 'launch-checklist', profile, source_key: 'launch-checklist', state: 'needs_me', title: 'Approve launch checklist', brief: 'Review release gates.',
      evidence: [], next_action: 'Approve it', owner: profile, revision: 2, version: 3, created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-03T00:00:00.000Z', snoozed_until: null, attention_due: true, attention_key: 'launch-checklist', approval: null,
      preparation_status: 'prepared', handoff_key: null, execution_link: null, tracker_evidence: null, completion_evidence: null
    }

    const detailed = topicDetail()
    detailed.work = { items: [binding], coverage: { status: 'complete', organization_bindings: 'complete', authorization_filtered: false } }
    vi.mocked(client.getCompanionTopic).mockResolvedValue(detailed)
    vi.mocked(client.listWork).mockResolvedValue({ items: [card] })
    vi.mocked(client.getWork).mockResolvedValue({ item: card, comments: [], decisions: [], tracker_status_history: [] })
    vi.mocked(client.listNeedsMePriorities).mockResolvedValue({
      profile, backend_namespace: 'organization-db', sort: 'recommended', policy_version: 'v1', review_id: null, group_by: 'topic',
      groups: [{
        id: 'topic-1', group: { kind: 'topic', id: topic.id, name: topic.name, collection: topic.collection, objective: topic.objective },
        eligibility: 'assessed', eligible_action_count: 1, why_here: 'Release gate',
        items: [{ profile, work_id: card.id, candidate_id: 'candidate-1', eligibility: 'assessed', why_here: 'Release gate', next_step: 'Approve it', trade_off: 'Delay', assessed_at: null, evidence: [], assessment: null, override: null }]
      }],
      as_of: '2026-09-03T00:00:00.000Z', coverage: { work: 'complete', organization: 'complete', authorization_filtered: false }
    })
    const store = createDirectoryStore()
    await store.attach(client, [profile])

    await store.openTopic(profile, topic.id, 'organization-db')

    expect(client.listNeedsMePriorities).toHaveBeenLastCalledWith(profile, undefined, 'topic')
    expect(client.getWork).toHaveBeenCalledWith(profile, card.id)
    expect(store.getSnapshot().entityProjection).toMatchObject({
      status: 'ready', complete: true,
      work: [{ status: 'available', detail: { item: { title: 'Approve launch checklist' } } }],
      needsMe: [{ priority: { next_step: 'Approve it' } }]
    })
  })

  it('clears stale topic rows while a changed query loads and keeps them suppressed on failure', async () => {
    const client = gateway()
    vi.mocked(client.listCompanionTopics).mockResolvedValueOnce(topicPage([topic]))
    const store = createDirectoryStore()
    await store.attach(client, [profile])
    expect(store.getSnapshot().topics).toHaveLength(1)

    const pending = deferred<TopicListResult>()
    vi.mocked(client.listCompanionTopics).mockReturnValueOnce(pending.promise)
    const changed = store.setBrowseQuery({ search: 'different', archive: 'all' })
    expect(store.getSnapshot().topics).toEqual([])
    expect(store.getSnapshot().topicCoverage[0]).toMatchObject({ status: 'loading', loaded: 0, total: null })
    pending.resolve(topicPage([]))
    await changed

    vi.mocked(client.listCompanionTopics).mockRejectedValueOnce(new Error('offline'))
    await store.setBrowseQuery({ search: 'failed', archive: 'all' })
    expect(store.getSnapshot().topics).toEqual([])
    expect(store.getSnapshot().topicCoverage[0]).toMatchObject({ status: 'error', loaded: 0, total: null, backendNamespace: null })
  })

  it('queries all eligible session visibility by default', async () => {
    const client = gateway()
    const store = createDirectoryStore()

    await store.attach(client, [profile])

    expect(client.listCompanionSessions).toHaveBeenCalledWith(expect.objectContaining({ profile, view: 'all' }))
  })

  it('does not retain complete coverage or stale warnings across refresh outcomes', async () => {
    const client = gateway()
    const listSessions = vi.mocked(client.listCompanionSessions)
    const listProjects = vi.mocked(client.listCompanionProjects)
    listSessions.mockResolvedValueOnce({ sessions: [], has_more: false, next_cursor: null, coverage: { complete: true, freshness: null, message: 'Old warning.' } })
    const store = createDirectoryStore()

    await store.attach(client, [profile])
    expect(store.getSnapshot().coverage[0]).toMatchObject({ complete: true, message: 'Old warning.' })

    listSessions.mockRejectedValueOnce(new Error('temporary failure'))
    await store.refresh()
    expect(store.getSnapshot().coverage[0]).toMatchObject({ complete: false, sessionStatus: 'error', message: 'Sessions could not be verified.' })

    listSessions.mockResolvedValue({ sessions: [], has_more: false, next_cursor: null, coverage: { complete: true, freshness: null, message: null } })
    listProjects.mockResolvedValue({ projects: [], has_more: false, next_cursor: null, coverage: { complete: true, freshness: null, message: null } })
    await store.refresh()
    expect(store.getSnapshot().coverage[0]).toMatchObject({ status: 'ready', complete: true, message: null })
  })

  it('purges retained directory rows and history on owner revocation', async () => {
    const client = gateway(); const store = createDirectoryStore()
    await store.attach(client, [profile]); await store.openSession(profile, 'one', source)
    vi.mocked(client.listCompanionSessions).mockRejectedValue({ code: 4403 })
    await store.refresh()

    expect(store.getSnapshot()).toMatchObject({ sessions: [], projects: [], topics: [], selectedProject: null, selectedSession: null, selectedTopic: null, history: null, detailStatus: 'error' })
    expect(store.getSnapshot().coverage).toEqual([])
    expect(store.getSnapshot().topicCoverage).toEqual([])
    expect(JSON.stringify(store.getSnapshot())).not.toContain('one-message')
  })

  it('coalesces duplicate foreground refreshes and preserves the open detail', async () => {
    const client = gateway(); const store = createDirectoryStore()
    await store.attach(client, [profile]); await store.openSession(profile, 'one', source)
    const pending = deferred<Awaited<ReturnType<DirectoryGateway['listCompanionSessions']>>>()
    vi.mocked(client.listCompanionSessions).mockReturnValueOnce(pending.promise)
    const sessionsBefore = vi.mocked(client.listCompanionSessions).mock.calls.length

    const first = store.refresh(); const second = store.refresh()
    expect(vi.mocked(client.listCompanionSessions).mock.calls.length).toBe(sessionsBefore + 1)
    pending.resolve({ sessions: [session('one'), session('two')], has_more: false, next_cursor: null, coverage: { complete: true, freshness: '2026-09-03T00:00:00.000Z', message: null } })
    await Promise.all([first, second])

    expect(store.getSnapshot().selectedSession?.id).toBe('one')
    expect(store.getSnapshot().history?.session_id).toBe('one')
  })

  it('uses authoritative history identity instead of a URL-controlled source label', async () => {
    const client = gateway()
    const store = createDirectoryStore()
    await store.attach(client, [profile])

    await store.openSession(profile, 'one', 'spoofed-source')

    expect(store.getSnapshot()).toMatchObject({ detailStatus: 'error', detailMessage: 'Session history could not be verified.' })
    expect(store.getSnapshot().selectedSession).toBeNull()
    expect(JSON.stringify(store.getSnapshot())).not.toContain('spoofed-source')
  })

  it('appends and deduplicates paged project membership', async () => {
    const client = gateway()
    vi.mocked(client.getCompanionProject)
      .mockResolvedValueOnce(projectDetail([session('one')], true))
      .mockResolvedValueOnce(projectDetail([session('one'), session('two')]))
    const store = createDirectoryStore()
    await store.attach(client, [profile])

    await store.openProject(profile, project.id, source)
    await store.loadOlderProjectSessions()

    expect(store.getSnapshot().selectedProject?.sessions.map((item) => item.id)).toEqual(['one', 'two'])
    expect(client.getCompanionProject).toHaveBeenLastCalledWith(profile, project.id, 'next-page')
  })

  it('passes search/archive to session RPCs and exhausts project pages for local title search', async () => {
    const client = gateway()
    const store = createDirectoryStore()
    await store.attach(client, [profile])
    vi.mocked(client.listCompanionProjects).mockReset()
    vi.mocked(client.listCompanionProjects)
      .mockResolvedValueOnce({ projects: [project], has_more: true, next_cursor: 'projects-2', coverage: { complete: true, freshness: project.freshness, message: null } })
      .mockResolvedValueOnce({ projects: [{ ...project, id: 'older-project', title: 'Needle project' }], has_more: false, next_cursor: null, coverage: { complete: true, freshness: project.freshness, message: null } })

    await store.setBrowseQuery({ search: 'Needle', archive: 'archived', sources: ['desktop-db'], origins: ['desktop', 'cli'] })

    expect(client.listCompanionSessions).toHaveBeenLastCalledWith(expect.objectContaining({ profile, search: 'Needle', view: 'archived', sources: ['desktop-db'], origins: ['cli', 'desktop'] }))
    expect(client.listCompanionProjects).toHaveBeenNthCalledWith(1, expect.objectContaining({ profile, archived: true }))
    expect(client.listCompanionProjects).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'projects-2' }))
    expect(store.getSnapshot().projects.map((item) => item.id)).toEqual(['project-1', 'older-project'])
  })

  it('appends and deduplicates older history pages', async () => {
    const client = gateway()
    vi.mocked(client.getCompanionSessionHistory)
      .mockResolvedValueOnce({ ...history('one'), has_more: true, next_cursor: 'history-2' })
      .mockResolvedValueOnce({ ...history('one'), entries: [history('one').entries[0], { ...history('one').entries[0], id: 'older' }], has_more: false, next_cursor: null })
    const store = createDirectoryStore()
    await store.attach(client, [profile])

    await store.openSession(profile, 'one', source)
    await store.loadOlderHistory()

    expect(client.getCompanionSessionHistory).toHaveBeenLastCalledWith(profile, 'one', 'history-2', source)
    expect(store.getSnapshot().history?.entries.map((entry) => entry.id)).toEqual(['one-message', 'older'])
  })

  it('ignores stale detail responses after a newer selection wins', async () => {
    const client = gateway()
    const first = deferred<CompanionSessionHistoryResult>()
    const second = deferred<CompanionSessionHistoryResult>()
    vi.mocked(client.getCompanionSessionHistory).mockImplementation((_profile, id) => id === 'one' ? first.promise : second.promise)
    const store = createDirectoryStore()
    await store.attach(client, [profile])

    const openFirst = store.openSession(profile, 'one', source)
    const openSecond = store.openSession(profile, 'two', source)
    second.resolve(history('two'))
    await openSecond
    first.resolve(history('one'))
    await openFirst

    expect(store.getSnapshot().selectedSession?.id).toBe('two')
    expect(store.getSnapshot().history?.session_id).toBe('two')
  })

  it('forwards topic search filters, paginates, and enforces detail source identity', async () => {
    const client = gateway()
    vi.mocked(client.listCompanionTopics)
      .mockResolvedValueOnce(topicPage([topic], true, 2))
      .mockResolvedValueOnce(topicPage([{ ...topic, id: 'topic-2', canonical_id: 'topic:atlas:topic-2', name: 'Older topic' }], false, 2))
    const store = createDirectoryStore()
    await store.attach(client, [profile])

    await store.loadOlder('topics', profile)
    expect(client.listCompanionTopics).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'topics-2', profile }))
    expect(store.getSnapshot().topics.map((item) => item.id)).toEqual(['topic-1', 'topic-2'])

    await store.setBrowseQuery({
      search: 'launch', archive: 'current', collections: ['operations'],
      lifecycles: ['active'], verified: true, topicSort: 'name'
    })
    expect(client.listCompanionTopics).toHaveBeenLastCalledWith(expect.objectContaining({
      query: 'launch', collection: ['operations'], lifecycle: ['active'], verified: true, sort: 'name'
    }))

    await store.openTopic(profile, topic.id, 'forged-source')
    expect(store.getSnapshot()).toMatchObject({ detailStatus: 'error', detailMessage: 'Topic details could not be verified.' })
    expect(store.getSnapshot().selectedTopic).toBeNull()
  })
})
