import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { TopicCoverage, TopicDetail, TopicItem } from '../../gateway/topic-types'

import type { DirectorySnapshot } from './directory-store'
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

const snapshot = (change: Partial<DirectorySnapshot> = {}): DirectorySnapshot => ({
  sessions: [],
  projects: [],
  selectedProject: null,
  selectedSession: null,
  history: null,
  topics: [{ ...topic, profile: 'atlas', source: 'organization-db' }],
  selectedTopic: null,
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
    expect(screen.getByRole('button', { name: /Companion launch/ }).textContent).toContain('Backend: organization-db · Profile: atlas')
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

  it('renders read-only deep-link tabs without claiming unavailable collections are empty', () => {
    const focused = props('section=topics&focus=topic-1&focusProfile=atlas&focusSource=organization-db&tab=needs_me&q=launch', {
      selectedTopic: detail,
      detailStatus: 'ready'
    })

    render(<WorkDirectory {...focused} />)

    expect(screen.getByText('Read-only organization detail')).toBeTruthy()
    expect(screen.getByText(/Backend: organization-db · Profile: atlas/)).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Needs Me' }).getAttribute('aria-selected')).toBe('true')

    for (const name of ['Overview', 'Needs Me', 'Work', 'Files', 'Sources']) {
      const tab = screen.getByRole('tab', { name })

      expect(document.getElementById(tab.getAttribute('aria-controls')!)).toBeTruthy()
    }

    expect(screen.getByText('Needs Me unavailable')).toBeTruthy()
    expect(screen.getByText(/no empty result is being claimed/i)).toBeTruthy()

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Needs Me' }), { key: 'ArrowRight' })
    expect((focused.onNavigate.mock.calls.at(-1)?.[0] as URLSearchParams).get('tab')).toBe('work')

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
