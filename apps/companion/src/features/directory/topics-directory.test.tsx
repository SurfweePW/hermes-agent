import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { TopicCoverage, TopicDetail, TopicItem } from '../../gateway/topic-types'

import type { DirectorySnapshot, EntityProjection, TopicSourceDetail } from './directory-store'
import { WorkDirectory } from './work-directory'

const topic: TopicItem = {
  id: 'topic-1',
  canonical_id: 'topic:atlas:topic-1',
  collection: 'operations',
  name: 'Companion launch',
  objective: 'Ship the read-only companion directory.',
  lifecycle: 'active',
  version: 3,
  created_at: '2026-09-01T10:00:00.000Z',
  updated_at: '2026-09-06T10:00:00.000Z',
  verified_status: {
    value: 'active',
    verified: true,
    authority: 'organization.topic.lifecycle',
    observed_at: '2026-09-06T10:00:00.000Z'
  },
  next_useful_action: {
    availability: 'available',
    assessment_id: 'assessment-1',
    outcome_id: 'outcome-1',
    action_id: 'action-1',
    references: ['Run frontend verification'],
    assessed_at: '2026-09-06T10:00:00.000Z',
    confidence: 'high',
    benefit: 'release confidence',
    potential: 0.9
  },
  linked_work: {
    coverage: 'partial',
    organization_bindings: 'complete',
    source_records: 'unavailable',
    authorization_filtered: false
  }
}

const coverage: TopicCoverage = {
  configured: true,
  status: 'complete',
  population: 'authorized topics',
  source: 'organization.db',
  freshness: {
    as_of: '2026-09-06T10:00:00.000Z',
    organization_updated_at: '2026-09-06T09:00:00.000Z'
  },
  linked_collections: {
    needs_me: 'unavailable',
    work_source_records: 'unavailable',
    files: 'unavailable',
    source_details: 'unavailable'
  }
}

const detail: TopicDetail = {
  topic,
  overview: {
    objective: topic.objective,
    next_useful_action: topic.next_useful_action,
    verified_status: topic.verified_status,
    coverage: { status: 'complete', authority: 'organization.db' }
  },
  needs_me: { items: null, coverage: { status: 'unavailable' } },
  work: { items: [], coverage: { status: 'complete' } },
  files: { items: null, coverage: { status: 'unavailable' } },
  sources: { items: [], coverage: { status: 'complete' } },
  tabs: ['overview', 'needs_me', 'work', 'files', 'sources'],
  as_of: '2026-09-06T10:00:00.000Z',
  profile: 'atlas',
  backend_namespace: 'organization-db',
  coverage,
  warnings: []
}

const binding: NonNullable<TopicDetail['work']['items']>[number] = {
  id: 'binding-1',
  canonical_id: 'work-binding:atlas:launch-checklist',
  work_kind: 'task',
  source_work_id: 'launch-checklist',
  source_namespace: { backend_id: 'organization-db', profile: 'atlas' },
  relationship: 'primary',
  version: 2,
  updated_at: '2026-09-06T09:30:00.000Z',
  authorization_filtered: false,
  source_status: { availability: 'unknown', coverage: 'unavailable' },
  primary_session: null,
  related_sessions: [],
  source_projects: []
}

const entityProjection: EntityProjection = {
  status: 'ready',
  complete: true,
  work: [{
    id: binding.canonical_id,
    binding,
    status: 'available',
    detail: {
      item: {
        id: 'launch-checklist', profile: 'atlas', source_key: 'launch-checklist', state: 'needs_me', title: 'Approve launch checklist', brief: 'Review release gates.',
        evidence: [], next_action: 'Approve the checklist', owner: 'atlas', revision: 4, version: 5,
        created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-06T09:30:00.000Z', snoozed_until: null,
        attention_due: true, attention_key: 'launch-checklist', recommended_action: 'approve_preparation', approval: null, preparation_status: 'prepared', handoff_key: null,
        execution_link: null, tracker_evidence: null, completion_evidence: null
      },
      comments: [], decisions: [], tracker_status_history: []
    },
    priority: {
      profile: 'atlas', work_id: 'launch-checklist', candidate_id: 'candidate-1', eligibility: 'assessed', why_here: 'Release gate is ready',
      next_step: 'Approve the checklist', trade_off: 'Delays launch if deferred', assessed_at: '2026-09-06T09:30:00.000Z', evidence: [], assessment: null, override: null
    }
  }],
  needsMe: [],
  message: null
}

entityProjection.needsMe = [...entityProjection.work]

const topicSourceDetails: TopicSourceDetail[] = [{
  source: { kind: 'project', canonical_id: 'project:atlas:launch', relationship: 'primary_project', namespace: { backend_id: 'organization-db', profile: 'atlas' }, source_id: 'launch-project', project_kind: 'desktop_project' },
  status: 'ready',
  title: 'Launch project',
  detail: 'desktop project · current'
}]

const snapshot = (change: Partial<DirectorySnapshot> = {}): DirectorySnapshot => ({
  sessions: [],
  projects: [],
  selectedProject: null,
  selectedSession: null,
  history: null,
  topics: [{ ...topic, profile: 'atlas', source: 'organization-db' }],
  selectedTopic: null,
  entityProjection: null,
  topicSourceDetails: [],
  topicCoverage: [{
    profile: 'atlas',
    status: 'ready',
    coverage,
    message: null,
    cursor: 'topics-2',
    hasMore: true,
    loaded: 1,
    total: 2,
    backendNamespace: 'organization-db'
  }],
  detailStatus: 'idle',
  detailMessage: null,
  coverage: [],
  ...change
})

const props = (params: string, change: Partial<DirectorySnapshot> = {}) => ({
  snapshot: snapshot(change),
  params: new URLSearchParams(params),
  onNavigate: vi.fn(),
  onLoadOlder: vi.fn(),
  onLoadOlderHistory: vi.fn(),
  onLoadOlderProjectSessions: vi.fn(),
  onRefresh: vi.fn(),
  onBack: vi.fn()
})

describe('Topics directory', () => {
  it('keeps filters and source identity in URL navigation and exposes pagination', () => {
    const listing = props('section=topics&q=launch&collection=operations&lifecycle=active&verified=true&sort=name')
    render(<WorkDirectory {...listing} />)

    expect((screen.getByLabelText('Search topics') as HTMLInputElement).value).toBe('launch')
    expect((screen.getByLabelText('Topic sort') as HTMLSelectElement).value).toBe('name')
    expect(screen.getByText('1 of 2 topics loaded')).toBeTruthy()
    expect(screen.getByLabelText('Active topic filters').textContent).toContain('Collection: operations')
    expect(screen.getByRole('button', { name: /Companion launch/ }).textContent).toContain('Profil: atlas')
    expect(screen.getByRole('button', { name: /Companion launch/ }).textContent).not.toContain('organization-db')
    expect(screen.getAllByText('Szczegóły techniczne').some((summary) => summary.closest('details')?.textContent?.includes('organization-db'))).toBe(true)
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Companion launch/ }))
    expect(Object.fromEntries((listing.onNavigate.mock.calls[0][0] as URLSearchParams).entries())).toMatchObject({
      section: 'topics',
      focus: 'topic-1',
      focusProfile: 'atlas',
      focusSource: 'organization-db',
      q: 'launch',
      collection: 'operations',
      lifecycle: 'active',
      verified: 'true',
      sort: 'name'
    })

    fireEvent.click(screen.getByRole('button', { name: 'Load more topics from atlas' }))
    expect(listing.onLoadOlder).toHaveBeenCalledWith('topics', 'atlas')
  })

  it('renders authorized Work, Needs Me, Sources, and Files behavior from deep links', () => {
    const focused = props('section=topics&focus=topic-1&focusProfile=atlas&focusSource=organization-db&tab=needs_me&q=launch', {
      selectedTopic: detail,
      entityProjection,
      topicSourceDetails,
      detailStatus: 'ready'
    })

    const { rerender } = render(<WorkDirectory {...focused} />)

    expect(screen.getByText('Read-only organization detail')).toBeTruthy()
    const technical = screen.getByText('Szczegóły techniczne').closest('details')
    expect(technical?.hasAttribute('open')).toBe(false)
    expect(technical?.textContent).toContain('organization-db')
    expect(screen.getByText(/Profil: atlas/)).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Needs Me' }).getAttribute('aria-selected')).toBe('true')

    for (const name of ['Overview', 'Needs Me', 'Work', 'Files', 'Sources']) {
      const tab = screen.getByRole('tab', { name })

      expect(document.getElementById(tab.getAttribute('aria-controls')!)).toBeTruthy()
    }

    expect(screen.getByText('Approve launch checklist')).toBeTruthy()
    expect(screen.getByText(/Release gate is ready · Next: Approve the checklist/)).toBeTruthy()

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Needs Me' }), { key: 'ArrowRight' })
    expect((focused.onNavigate.mock.calls.at(-1)?.[0] as URLSearchParams).get('tab')).toBe('work')

    const workView = props('section=topics&focus=topic-1&focusProfile=atlas&focusSource=organization-db&tab=work', {
      selectedTopic: detail, entityProjection, topicSourceDetails, detailStatus: 'ready'
    })

    rerender(<WorkDirectory {...workView} />)
    expect(screen.getByText('Approve launch checklist')).toBeTruthy()
    expect(screen.getByText(/needs me · prepared · revision 4/)).toBeTruthy()

    const sourcesView = props('section=topics&focus=topic-1&focusProfile=atlas&focusSource=organization-db&tab=sources', {
      selectedTopic: detail, entityProjection, topicSourceDetails, detailStatus: 'ready'
    })

    rerender(<WorkDirectory {...sourcesView} />)
    expect(screen.getByText('Launch project')).toBeTruthy()
    expect(screen.getByText(/primary_project · ready · desktop project · current/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open project' }))
    expect(Object.fromEntries((sourcesView.onNavigate.mock.calls.at(-1)?.[0] as URLSearchParams).entries())).toMatchObject({
      section: 'projects', focus: 'launch-project', focusProfile: 'atlas', focusSource: 'organization-db', tab: 'overview'
    })

    const filesView = props('section=topics&focus=topic-1&focusProfile=atlas&focusSource=organization-db&tab=files&q=launch', {
      selectedTopic: detail, entityProjection, topicSourceDetails, detailStatus: 'ready'
    })

    rerender(<WorkDirectory {...filesView} />)
    fireEvent.click(screen.getByRole('button', { name: 'View files in Library' }))
    expect(Object.fromEntries((filesView.onNavigate.mock.calls.at(-1)?.[0] as URLSearchParams).entries())).toEqual({
      view: 'library', libraryProfile: 'atlas', libraryTopic: 'topic-1'
    })

    rerender(<WorkDirectory {...focused} />)
    fireEvent.click(screen.getByRole('button', { name: '← Back to topics' }))
    const restored = focused.onNavigate.mock.calls.at(-1)?.[0] as URLSearchParams
    expect(restored.get('focus')).toBeNull()
    expect(restored.get('focusSource')).toBeNull()
    expect(restored.get('q')).toBe('launch')
  })

  it('only claims an empty population when every topic source reports complete coverage', () => {
    const empty = snapshot({
      topics: [],
      topicCoverage: [{
        profile: 'atlas',
        status: 'ready',
        coverage,
        message: null,
        cursor: null,
        hasMore: false,
        loaded: 0,
        total: 0,
        backendNamespace: 'organization-db'
      }]
    })

    const { rerender } = render(<WorkDirectory {...props('section=topics')} snapshot={empty} />)
    expect(screen.getByText('No topics yet')).toBeTruthy()

    rerender(<WorkDirectory {...props('section=topics')} snapshot={{
      ...empty,
      topicCoverage: [{ ...empty.topicCoverage[0], status: 'error', coverage: null, total: null }]
    }} />)
    expect(screen.getByText('Topic coverage unavailable')).toBeTruthy()
    expect(screen.getByText(/cannot claim this directory is empty/i)).toBeTruthy()
  })
})
