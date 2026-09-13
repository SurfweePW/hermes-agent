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
  organization_complete: false,
  organization_message: 'Not hydrated.',
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

const otherProfile = 'mentor'
const sessionFor = (requestedProfile: string, id: string) => ({ ...session(id), profile: requestedProfile })
const projectFor = (requestedProfile: string) => ({ ...project, id: `${requestedProfile}-project`, profile: requestedProfile })
const topicFor = (requestedProfile: string) => ({ ...topic, id: `${requestedProfile}-topic`, canonical_id: `topic:${requestedProfile}`, name: `${requestedProfile} topic` })
const topicNamespaceFor = (requestedProfile: string) => requestedProfile === profile ? 'organization-db' : `${requestedProfile}-organization-db`

const topicPageFor = (requestedProfile: string, items: TopicItem[], hasMore = false, total = items.length): TopicListResult => ({
  ...topicPage(items, hasMore, total),
  profile: requestedProfile,
  backend_namespace: topicNamespaceFor(requestedProfile)
})

const topicDetailFor = (requestedProfile: string, item = topicFor(requestedProfile)): TopicDetail => ({
  ...topicDetail(item),
  profile: requestedProfile,
  backend_namespace: topicNamespaceFor(requestedProfile)
})

function seedTwoProfiles(client: DirectoryGateway) {
  vi.mocked(client.listCompanionSessions).mockImplementation(async ({ profile: requestedProfile }) => ({
    sessions: [sessionFor(requestedProfile, `${requestedProfile}-session`)], has_more: false, next_cursor: null,
    coverage: { complete: true, freshness: null, message: null }
  }))
  vi.mocked(client.listCompanionProjects).mockImplementation(async ({ profile: requestedProfile }) => ({
    projects: [projectFor(requestedProfile)], has_more: false, next_cursor: null,
    coverage: { complete: true, freshness: null, message: null }
  }))
  vi.mocked(client.listCompanionTopics).mockImplementation(async ({ profile: requestedProfile }) => topicPageFor(requestedProfile, [topicFor(requestedProfile)]))
  vi.mocked(client.getCompanionSessionHistory).mockImplementation(async (requestedProfile, id) => ({ ...history(id), profile: requestedProfile }))
  vi.mocked(client.getCompanionProject).mockImplementation(async (requestedProfile) => ({
    ...projectDetail([sessionFor(requestedProfile, `${requestedProfile}-session`)]),
    project: projectFor(requestedProfile)
  }))
  vi.mocked(client.getCompanionTopic).mockImplementation(async (requestedProfile, id) => topicDetailFor(requestedProfile, topicFor(requestedProfile).id === id ? topicFor(requestedProfile) : { ...topicFor(requestedProfile), id }))
}

describe('createDirectoryStore', () => {
  it('loads every eligible session page when search matches a project name', async () => {
    const client = gateway()
    const namedProject = { ...project, title: 'Deep Project Match', session_ids: ['older-member'] }
    vi.mocked(client.listCompanionProjects)
      .mockResolvedValueOnce({ projects: [namedProject], has_more: false, next_cursor: null, coverage: { complete: true, freshness: null, message: null } })
      .mockResolvedValueOnce({ projects: [namedProject], has_more: false, next_cursor: null, coverage: { complete: true, freshness: null, message: null } })
    vi.mocked(client.listCompanionSessions)
      .mockResolvedValueOnce({ sessions: [], has_more: false, next_cursor: null, coverage: { complete: true, freshness: null, message: null } })
      .mockResolvedValueOnce({ sessions: [], has_more: false, next_cursor: null, coverage: { complete: true, freshness: null, message: null } })
      .mockResolvedValueOnce({ sessions: [session('unrelated')], has_more: true, next_cursor: 'all-2', coverage: { complete: true, freshness: null, message: null } })
      .mockResolvedValueOnce({ sessions: [session('older-member')], has_more: false, next_cursor: null, coverage: { complete: true, freshness: null, message: null } })
    const store = createDirectoryStore()
    await store.attach(client, [profile])

    await store.setBrowseQuery({ search: 'deep project', archive: 'all' })

    expect(store.getSnapshot().sessions).toEqual([
      expect.objectContaining({ id: 'older-member', project: expect.objectContaining({ title: 'Deep Project Match' }) })
    ])
    expect(vi.mocked(client.listCompanionSessions).mock.calls.at(-1)?.[0]).toMatchObject({ cursor: 'all-2' })
    expect(store.getSnapshot().coverage[0].complete).toBe(true)
  })

  it('hydrates a project Topics relationship with the topic namespace intact', async () => {
    const client = gateway()
    const detailed = topicDetail()
    detailed.sources = {
      items: [{
        kind: 'project', canonical_id: 'project:desktop-db:atlas:project-1', relationship: 'primary_project',
        namespace: { backend_id: source, profile }, source_id: project.id, project_kind: 'desktop_project'
      }],
      coverage: { status: 'partial', organization_references: 'complete', source_details: 'unavailable', authorization_filtered: false }
    }
    vi.mocked(client.listCompanionTopics)
      .mockResolvedValueOnce(topicPage([]))
      .mockResolvedValueOnce(topicPage([topic]))
    vi.mocked(client.getCompanionTopic).mockResolvedValue(detailed)
    const store = createDirectoryStore()
    await store.attach(client, [profile])

    await store.openProject(profile, project.id, project.source)

    expect(store.getSnapshot().selectedProject).toMatchObject({
      organization_available: true,
      organization_complete: true,
      topics: [{ id: topic.id, title: topic.name, profile, source: 'organization-db', status: 'active' }]
    })
  })

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
      updated_at: '2026-09-03T00:00:00.000Z', snoozed_until: null, attention_due: true, attention_key: 'launch-checklist', recommended_action: 'approve_preparation', approval: null,
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

  it('stops all-page relationship hydration when the gateway replays a cursor', async () => {
    const client = gateway()
    const repeated = { ...topicPage([topic], true, 2), backend_namespace: project.source, next_cursor: 'replayed-cursor' }
    vi.mocked(client.listCompanionTopics)
      .mockResolvedValueOnce(topicPage([]))
      .mockResolvedValue(repeated)
    const store = createDirectoryStore()
    await store.attach(client, [profile])

    await store.openProject(profile, project.id, project.source)

    expect(client.listCompanionTopics).toHaveBeenCalledTimes(3)
    expect(store.getSnapshot().entityProjection).toMatchObject({
      status: 'error',
      complete: false,
      message: 'Authorized Work and Needs Me could not be verified.'
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

  it('drops only the revoked source and keeps every other profile verified', async () => {
    const client = gateway()
    const other = 'mentor'
    const otherSession = { ...session('other-session'), profile: other }
    const store = createDirectoryStore()
    vi.mocked(client.listCompanionSessions).mockResolvedValue({ sessions: [otherSession], has_more: false, next_cursor: null, coverage: { complete: true, freshness: null, message: null } })
    vi.mocked(client.listCompanionProjects).mockResolvedValue({ projects: [], has_more: false, next_cursor: null, coverage: { complete: true, freshness: null, message: null } })
    await store.attach(client, [profile, other])
    await store.openSession(other, 'other-session', source)
    vi.mocked(client.listCompanionSessions).mockImplementation(async ({ profile: requested }) => {
      if (requested === profile) {throw { code: 4403 }}

      return { sessions: [otherSession], has_more: false, next_cursor: null, coverage: { complete: true, freshness: null, message: null } }
    })
    vi.mocked(client.listCompanionProjects).mockImplementation(async ({ profile: requested }) => {
      if (requested === profile) {throw { code: 4403 }}

      return { projects: [], has_more: false, next_cursor: null, coverage: { complete: true, freshness: null, message: null } }
    })
    await store.refresh()

    const snapshot = store.getSnapshot()

    expect(snapshot.sessions.map((item) => item.profile)).toEqual([other])
    expect(snapshot.coverage.find((item) => item.profile === profile)).toMatchObject({ status: 'error', message: 'This source is not authorized.' })
    expect(snapshot.coverage.find((item) => item.profile === other)).toMatchObject({ status: 'ready' })
    expect(snapshot.selectedSession?.profile).toBe(other)
    expect(snapshot.history?.session_id).toBe('other-session')
  })

  it('drops the open detail of a revoked source without touching other profiles', async () => {
    const client = gateway(); const store = createDirectoryStore()
    await store.attach(client, [profile]); await store.openSession(profile, 'one', source)
    vi.mocked(client.listCompanionSessions).mockRejectedValue({ code: 4403 })
    await store.refresh()

    expect(store.getSnapshot()).toMatchObject({ sessions: [], selectedSession: null, history: null, detailStatus: 'error', detailMessage: 'This source is not authorized.' })
    expect(store.getSnapshot().coverage).toMatchObject([{ profile, status: 'error', message: 'This source is not authorized.' }])
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

  it('keeps later-page project membership unknown until the matching project page loads', async () => {
    const client = gateway()
    vi.mocked(client.listCompanionSessions).mockResolvedValue({
      sessions: [session('one')], has_more: false, next_cursor: null,
      coverage: { complete: true, freshness: project.freshness, message: null }
    })
    vi.mocked(client.listCompanionProjects)
      .mockResolvedValueOnce({
        projects: [{ ...project, session_ids: [] }], has_more: true, next_cursor: 'projects-2',
        coverage: { complete: true, freshness: project.freshness, message: null }
      })
      .mockResolvedValueOnce({
        projects: [{ ...project, id: 'project-2', title: 'Project two', session_ids: ['one'] }], has_more: false, next_cursor: null,
        coverage: { complete: true, freshness: project.freshness, message: null }
      })
    const store = createDirectoryStore()

    await store.attach(client, [profile])
    expect(store.getSnapshot().sessions[0]?.project).toBeUndefined()

    await store.loadOlder('projects', profile)
    expect(store.getSnapshot().sessions[0]?.project).toEqual({ id: 'project-2', title: 'Project two', profile })
  })

  it('preserves known positive membership and marks absent membership unknown when project loading fails', async () => {
    const client = gateway()
    vi.mocked(client.listCompanionSessions).mockResolvedValue({
      sessions: [
        { ...session('one'), project: { id: project.id, title: project.title, profile } },
        session('two')
      ],
      has_more: false, next_cursor: null,
      coverage: { complete: true, freshness: project.freshness, message: null }
    })
    vi.mocked(client.listCompanionProjects).mockRejectedValue(new Error('project source offline'))
    const store = createDirectoryStore()

    await store.attach(client, [profile])

    expect(store.getSnapshot().sessions.find((item) => item.id === 'one')?.project).toEqual({ id: project.id, title: project.title, profile })
    expect(store.getSnapshot().sessions.find((item) => item.id === 'two')?.project).toBeUndefined()
    expect(store.getSnapshot().coverage[0]).toMatchObject({ projectStatus: 'error', complete: false })
  })

  it('marks a session unassigned only after complete project coverage excludes it', async () => {
    const client = gateway()
    vi.mocked(client.listCompanionSessions).mockResolvedValue({
      sessions: [session('one')], has_more: false, next_cursor: null,
      coverage: { complete: true, freshness: project.freshness, message: null }
    })
    vi.mocked(client.listCompanionProjects).mockResolvedValue({
      projects: [], has_more: false, next_cursor: null,
      coverage: { complete: true, freshness: project.freshness, message: null }
    })
    const store = createDirectoryStore()

    await store.attach(client, [profile])

    expect(store.getSnapshot().sessions[0]?.project).toBeNull()
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
    expect(client.listCompanionProjects).toHaveBeenNthCalledWith(1, { profile, limit: 50 })
    expect(client.listCompanionProjects).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'projects-2' }))
    expect(store.getSnapshot().projects.map((item) => item.id)).toEqual(['project-1', 'older-project'])
  })

  it('does not mark active sessions in archived projects as unassigned', async () => {
    const client = gateway()
    const store = createDirectoryStore()
    await store.attach(client, [profile])
    vi.mocked(client.listCompanionSessions).mockResolvedValue({
      sessions: [session('one')], has_more: false, next_cursor: null,
      coverage: { complete: true, freshness: project.freshness, message: null }
    })
    vi.mocked(client.listCompanionProjects).mockResolvedValue({
      projects: [{ ...project, archived: true, session_ids: ['one'] }],
      has_more: false, next_cursor: null,
      coverage: { complete: true, freshness: project.freshness, message: null }
    })

    await store.setBrowseQuery({ search: '', archive: 'current' })

    expect(client.listCompanionProjects).toHaveBeenLastCalledWith({ profile, limit: 50 })
    expect(store.getSnapshot().sessions[0]?.project).toEqual({
      id: project.id, title: project.title, profile
    })
  })

  it('prepends and deduplicates older history pages', async () => {
    const client = gateway()
    vi.mocked(client.getCompanionSessionHistory)
      .mockResolvedValueOnce({ ...history('one'), has_more: true, next_cursor: 'history-2' })
      .mockResolvedValueOnce({ ...history('one'), entries: [history('one').entries[0], { ...history('one').entries[0], id: 'older' }], has_more: false, next_cursor: null })
    const store = createDirectoryStore()
    await store.attach(client, [profile])

    await store.openSession(profile, 'one', source)
    await store.loadOlderHistory()

    expect(client.getCompanionSessionHistory).toHaveBeenLastCalledWith(profile, 'one', 'history-2', source)
    expect(store.getSnapshot().history?.entries.map((entry) => entry.id)).toEqual(['older', 'one-message'])
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

  it('removes a rejected topic source completely when pagination returns 4403', async () => {
    const client = gateway()
    seedTwoProfiles(client)
    vi.mocked(client.listCompanionTopics).mockImplementation(async ({ profile: requestedProfile, cursor }) => {
      if (requestedProfile === profile && cursor) {throw { code: 4403 }}

      return topicPageFor(requestedProfile, [topicFor(requestedProfile)], requestedProfile === profile, requestedProfile === profile ? 2 : 1)
    })
    const detail = topicDetailFor(profile)
    detail.sources.items = [{ kind: 'namespace', canonical_id: 'namespace:atlas', relationship: 'owner', namespace: { profile, backend_id: topicNamespaceFor(profile) } }]
    vi.mocked(client.getCompanionTopic).mockResolvedValue(detail)
    const store = createDirectoryStore()
    await store.attach(client, [profile, otherProfile])
    await store.openTopic(profile, topicFor(profile).id, topicNamespaceFor(profile))
    expect(store.getSnapshot().topicSourceDetails.some((item) => item.source.namespace.profile === profile)).toBe(true)

    await store.loadOlder('topics', profile)

    const snapshot = store.getSnapshot()
    expect(snapshot.topics.some((item) => item.profile === profile)).toBe(false)
    expect(snapshot.topics.some((item) => item.profile === otherProfile)).toBe(true)
    expect(snapshot).toMatchObject({ selectedTopic: null, entityProjection: null, topicSourceDetails: [], history: null, detailStatus: 'error' })
    expect(snapshot.topicCoverage.find((item) => item.profile === profile)).toMatchObject({ status: 'error', coverage: null, backendNamespace: null })
  })

  it.each(['openProject', 'openSession', 'openTopic', 'loadOlderHistory', 'loadOlderProjectSessions'] as const)('cleans only the rejected profile after 4403 from %s', async (entryPoint) => {
    const client = gateway()
    seedTwoProfiles(client)

    if (entryPoint === 'loadOlderHistory') {
      vi.mocked(client.getCompanionSessionHistory).mockImplementation(async (requestedProfile, id) => ({
        ...history(id), profile: requestedProfile, has_more: requestedProfile === profile, next_cursor: requestedProfile === profile ? 'older-history' : null
      }))
    }

    if (entryPoint === 'loadOlderProjectSessions') {
      vi.mocked(client.getCompanionProject).mockImplementation(async (requestedProfile) => ({
        ...projectDetail([sessionFor(requestedProfile, `${requestedProfile}-session`)], requestedProfile === profile),
        project: projectFor(requestedProfile)
      }))
    }

    const store = createDirectoryStore()
    await store.attach(client, [profile, otherProfile])

    if (entryPoint === 'openProject' || entryPoint === 'loadOlderProjectSessions') {
      await store.openProject(profile, projectFor(profile).id, source)
    } else if (entryPoint === 'openSession' || entryPoint === 'loadOlderHistory') {
      await store.openSession(profile, `${profile}-session`, source)
    } else {
      await store.openTopic(profile, topicFor(profile).id, topicNamespaceFor(profile))
    }

    const before = store.getSnapshot()

    const control = {
      sessions: before.sessions.filter((item) => item.profile === otherProfile),
      projects: before.projects.filter((item) => item.profile === otherProfile),
      topics: before.topics.filter((item) => item.profile === otherProfile),
      coverage: before.coverage.find((item) => item.profile === otherProfile),
      topicCoverage: before.topicCoverage.find((item) => item.profile === otherProfile)
    }

    if (entryPoint === 'openProject') {
      vi.mocked(client.getCompanionProject).mockRejectedValue({ code: 4403 })
      await store.openProject(profile, projectFor(profile).id, source)
    } else if (entryPoint === 'openSession') {
      vi.mocked(client.getCompanionSessionHistory).mockRejectedValue({ code: 4403 })
      await store.openSession(profile, `${profile}-session`, source)
    } else if (entryPoint === 'openTopic') {
      vi.mocked(client.getCompanionTopic).mockRejectedValue({ code: 4403 })
      await store.openTopic(profile, topicFor(profile).id, topicNamespaceFor(profile))
    } else if (entryPoint === 'loadOlderHistory') {
      vi.mocked(client.getCompanionSessionHistory).mockRejectedValue({ code: 4403 })
      await store.loadOlderHistory()
    } else {
      vi.mocked(client.getCompanionProject).mockRejectedValue({ code: 4403 })
      await store.loadOlderProjectSessions()
    }

    const snapshot = store.getSnapshot()
    expect(snapshot.sessions.some((item) => item.profile === profile)).toBe(false)
    expect(snapshot.projects.some((item) => item.profile === profile)).toBe(false)
    expect(snapshot.topics.some((item) => item.profile === profile)).toBe(false)
    expect(snapshot).toMatchObject({ selectedProject: null, selectedSession: null, selectedTopic: null, history: null, entityProjection: null, topicSourceDetails: [], detailStatus: 'error' })
    expect(snapshot.coverage.find((item) => item.profile === profile)).toMatchObject({ status: 'error', backendNamespace: null })
    expect(snapshot.topicCoverage.find((item) => item.profile === profile)).toMatchObject({ status: 'error', backendNamespace: null })
    expect(snapshot.sessions.filter((item) => item.profile === otherProfile)).toEqual(control.sessions)
    expect(snapshot.projects.filter((item) => item.profile === otherProfile)).toEqual(control.projects)
    expect(snapshot.topics.filter((item) => item.profile === otherProfile)).toEqual(control.topics)
    expect(snapshot.coverage.find((item) => item.profile === otherProfile)).toEqual(control.coverage)
    expect(snapshot.topicCoverage.find((item) => item.profile === otherProfile)).toEqual(control.topicCoverage)
  })

  it('keeps successful supplemental source details when another linked source returns 4403', async () => {
    const client = gateway()
    seedTwoProfiles(client)
    const detail = topicDetailFor(profile)
    detail.sources.items = [
      { kind: 'project', canonical_id: 'project:atlas', relationship: 'related', namespace: { profile, backend_id: source }, source_id: 'atlas-source-project', project_kind: 'desktop_project' },
      { kind: 'project', canonical_id: 'project:mentor', relationship: 'related', namespace: { profile: otherProfile, backend_id: source }, source_id: 'mentor-source-project', project_kind: 'desktop_project' }
    ]
    vi.mocked(client.getCompanionTopic).mockResolvedValue(detail)
    vi.mocked(client.getCompanionProject).mockImplementation(async (requestedProfile) => {
      if (requestedProfile === otherProfile) {throw { code: 4403 }}

      return { ...projectDetail([]), project: projectFor(requestedProfile) }
    })
    const store = createDirectoryStore()
    await store.attach(client, [profile, otherProfile])

    await store.openTopic(profile, topicFor(profile).id, topicNamespaceFor(profile))

    const snapshot = store.getSnapshot()
    expect(snapshot.selectedTopic?.profile).toBe(profile)
    expect(snapshot.entityProjection?.status).toBe('ready')
    expect(snapshot.topicSourceDetails).toEqual([
      expect.objectContaining({ status: 'ready', source: expect.objectContaining({ canonical_id: 'project:atlas' }) }),
      expect.objectContaining({ status: 'error', detail: 'This source is not authorized.', source: expect.objectContaining({ canonical_id: 'project:mentor' }) })
    ])
    expect(snapshot.sessions.some((item) => item.profile === otherProfile)).toBe(false)
    expect(snapshot.projects.some((item) => item.profile === otherProfile)).toBe(false)
    expect(snapshot.topics.some((item) => item.profile === otherProfile)).toBe(false)
  })

  it('signals owner authorization loss without profile-scoped cleanup', async () => {
    const client = gateway()
    seedTwoProfiles(client)
    vi.mocked(client.listCompanionTopics).mockImplementation(async ({ profile: requestedProfile, cursor }) => {
      if (requestedProfile === profile && cursor) {throw { code: 4401 }}

      return topicPageFor(requestedProfile, [topicFor(requestedProfile)], requestedProfile === profile, requestedProfile === profile ? 2 : 1)
    })
    const onOwnerAuthorizationLost = vi.fn()
    const store = createDirectoryStore({ onOwnerAuthorizationLost })
    await store.attach(client, [profile, otherProfile])
    const before = store.getSnapshot()

    await store.loadOlder('topics', profile)

    expect(onOwnerAuthorizationLost).toHaveBeenCalledWith(expect.objectContaining({ code: 4401 }))
    expect(store.getSnapshot().sessions).toEqual(before.sessions)
    expect(store.getSnapshot().projects).toEqual(before.projects)
    expect(store.getSnapshot().topics).toEqual(before.topics)
  })
})
