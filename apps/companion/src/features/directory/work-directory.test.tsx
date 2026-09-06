import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { CompanionProject, CompanionProjectDetail, CompanionSession, CompanionSessionHistoryResult } from '../../gateway/types'

import type { DirectorySnapshot, SourceCoverage } from './directory-store'
import { WorkDirectory } from './work-directory'

const project: CompanionProject = {
  id: 'project-1', title: 'Launch plan', profile: 'atlas', source: 'desktop-db', type: 'desktop_project', archived: false,
  last_active: '2026-09-05T10:00:00.000Z', session_count: 1, linked_work_count: null, freshness: '2026-09-06T10:00:00.000Z'
}

const session: CompanionSession = {
  id: 'session-1', title: 'Launch research', profile: 'atlas', source: 'desktop-db', origin: 'desktop', opened_in: [],
  archived: false, hidden: false, started_at: '2026-09-04T10:00:00.000Z', last_active: '2026-09-05T10:00:00.000Z',
  status: null, type: 'direct', project: { id: project.id, title: project.title, profile: 'atlas' },
  topics: [{ id: 'topic-1', title: 'Companion launch' }], linked_work_count: null, message_count: 2
}

const coverage: SourceCoverage = {
  profile: 'atlas', status: 'ready', complete: true, freshness: '2026-09-06T10:00:00.000Z', message: null,
  sessionCursor: null, projectCursor: null, sessionsHasMore: false, projectsHasMore: false,
  sessionComplete: true, projectComplete: true, sessionStatus: 'ready', projectStatus: 'ready'
}

const history: CompanionSessionHistoryResult = {
  session_id: session.id, profile: 'atlas', source: 'desktop-db',
  entries: [
    { id: '1', kind: 'message', role: 'user', content: 'Please research launch timing.', label: null, occurred_at: '2026-09-04T10:00:00.000Z' },
    { id: '2', kind: 'internal', role: null, content: '', label: 'Tool execution', occurred_at: '2026-09-04T10:01:00.000Z' },
    { id: '3', kind: 'message', role: 'assistant', content: 'Research complete.', label: null, occurred_at: '2026-09-04T10:02:00.000Z' }
  ],
  linked_work: [], linked_work_available: false, has_more: false, next_cursor: null,
  coverage: { complete: true, freshness: '2026-09-06T10:00:00.000Z', message: null }
}

const projectDetail: CompanionProjectDetail = {
  project, sessions: [session], topics: [], needs_me: [], work: [], organization_available: false,
  membership_has_more: false, membership_next_cursor: null,
  coverage: { complete: true, freshness: '2026-09-06T10:00:00.000Z', message: null }
}

const snapshot = (change: Partial<DirectorySnapshot> = {}): DirectorySnapshot => ({
  projects: [project], sessions: [session], selectedProject: null, selectedSession: null, history: null,
  topics: [], selectedTopic: null, entityProjection: null, topicSourceDetails: [], topicCoverage: [], detailStatus: 'idle', detailMessage: null, coverage: [coverage], ...change
})

const props = (params: string, change: Partial<DirectorySnapshot> = {}) => ({
  snapshot: snapshot(change), params: new URLSearchParams(params), onNavigate: vi.fn(), onLoadOlder: vi.fn(),
  onLoadOlderHistory: vi.fn(), onLoadOlderProjectSessions: vi.fn(), onRefresh: vi.fn(), onBack: vi.fn()
})

describe('WorkDirectory', () => {
  it('exposes Topics, Projects, and Sessions rows without claiming unsupported topics are empty', () => {
    const topics = props('section=topics', {
      topicCoverage: [{
        profile: 'atlas', status: 'unsupported', coverage: null,
        message: 'Topics require an organization backend update', cursor: null,
        hasMore: false, loaded: 0, total: null, backendNamespace: null
      }]
    })

    const { rerender } = render(<WorkDirectory {...topics} />)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Topics', 'Projects', 'Sessions'])
    expect(screen.getByText('Topics require an organization backend update')).toBeTruthy()

    rerender(<WorkDirectory {...props('section=projects')} />)
    expect(screen.getByRole('button', { name: /Launch plan/ })).toBeTruthy()

    rerender(<WorkDirectory {...props('section=sessions')} />)
    expect(screen.getByRole('button', { name: /Launch research/ })).toBeTruthy()
  })

  it('opens direct read-only project details and session history', () => {
    const { rerender } = render(<WorkDirectory {...props('section=projects&focus=project-1&focusProfile=atlas&focusSource=desktop-db', { selectedProject: projectDetail, detailStatus: 'ready' })} />)
    expect(screen.getByText('Read-only source detail')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }))

    rerender(<WorkDirectory {...props('section=sessions&focus=session-1&focusProfile=atlas&focusSource=desktop-db&tab=history', { selectedSession: session, history, detailStatus: 'ready' })} />)
    expect(screen.getByText('Please research launch timing.')).toBeTruthy()
    expect(screen.getByText('Research complete.')).toBeTruthy()
    expect(screen.getByText(/Viewing history does not resume or activate this session/)).toBeTruthy()
    expect(screen.getByText(/Tool execution/)).toBeTruthy()
  })

  it('uses verified entity projections and Library relationship routes in project and session details', () => {
    const projection = { status: 'ready' as const, complete: true, work: [], needsMe: [], message: null }

    const projectView = props('section=projects&focus=project-1&focusProfile=atlas&focusSource=desktop-db&tab=needs%20me', {
      selectedProject: projectDetail, entityProjection: projection, detailStatus: 'ready'
    })

    const { rerender } = render(<WorkDirectory {...projectView} />)
    expect(screen.getByText('No Needs Me items')).toBeTruthy()

    const projectFiles = props('section=projects&focus=project-1&focusProfile=atlas&focusSource=desktop-db&tab=files', {
      selectedProject: projectDetail, entityProjection: projection, detailStatus: 'ready'
    })

    rerender(<WorkDirectory {...projectFiles} />)
    fireEvent.click(screen.getByRole('button', { name: 'View files in Library' }))
    expect(Object.fromEntries(projectFiles.onNavigate.mock.calls[0][0] as URLSearchParams)).toEqual({
      view: 'library', libraryProfile: 'atlas', libraryProject: 'project-1'
    })

    const sessionView = props('section=sessions&focus=session-1&focusProfile=atlas&focusSource=desktop-db&tab=linked%20work', {
      selectedSession: session, history, entityProjection: projection, detailStatus: 'ready'
    })

    rerender(<WorkDirectory {...sessionView} />)
    expect(screen.getByText('No linked work')).toBeTruthy()

    const sessionFiles = props('section=sessions&focus=session-1&focusProfile=atlas&focusSource=desktop-db&tab=files', {
      selectedSession: session, history, entityProjection: projection, detailStatus: 'ready'
    })

    rerender(<WorkDirectory {...sessionFiles} />)
    fireEvent.click(screen.getByRole('button', { name: 'View files in Library' }))
    expect(Object.fromEntries(sessionFiles.onNavigate.mock.calls[0][0] as URLSearchParams)).toEqual({
      view: 'library', libraryProfile: 'atlas', librarySession: 'session-1'
    })
  })

  it('applies the conversation privacy boundary to persisted history', () => {
    const privateHistory: CompanionSessionHistoryResult = {
      ...history,
      entries: [{
        id: 'private-image', kind: 'message', role: 'user', label: null, occurred_at: null,
        content: '[sender|123] /Users/alice/private/photo.png\n[Image attached at: /Users/alice/private/photo.png]\ndata:image/png;base64,AAAA'
      }]
    }

    render(<WorkDirectory {...props('section=sessions&focus=session-1&focusProfile=atlas&focusSource=desktop-db&tab=history', { selectedSession: session, history: privateHistory, detailStatus: 'ready' })} />)

    expect(screen.getByText(/Image attachment/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('/Users/alice')
    expect(document.body.textContent).not.toContain('data:image')
    expect(document.body.textContent).not.toContain('[sender|123]')
  })

  it('renders compression summaries distinctly and keeps their content privacy-safe', () => {
    const compressed: CompanionSessionHistoryResult = {
      ...history,
      entries: [{ id: 'compressed', kind: 'compression', role: 'user', label: 'Compression summary', occurred_at: null, content: '[CONTEXT SUMMARY]:\n[Image attached at: /Users/alice/private/context.png]' }]
    }

    render(<WorkDirectory {...props('section=sessions&focus=session-1&focusProfile=atlas&focusSource=desktop-db&tab=history', { selectedSession: session, history: compressed, detailStatus: 'ready' })} />)

    expect(screen.getByRole('complementary', { name: 'Compression summary' })).toBeTruthy()
    expect(screen.getByText(/Generated context carried forward/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('/Users/alice')
    expect(screen.queryByText('You')).toBeNull()
  })

  it('never presents unknown project membership as verified absence', () => {
    render(<WorkDirectory {...props('section=sessions', { sessions: [{ ...session, project: null }] })} />)

    expect(screen.getByRole('button', { name: /Project membership not reported/ })).toBeTruthy()
    expect(document.body.textContent).not.toContain('No project')
  })

  it('exposes functional visibility, source, origin, date, topic, project, and type filters with chips and clear', () => {
    const onNavigate = vi.fn()
    render(<WorkDirectory {...props('section=sessions&source=desktop-db&profile=atlas&origin=desktop&visibility=current&dateFrom=2026-09-01&dateTo=2026-09-30&topic=topic-1&project=project-1&type=direct&sort=name&group=profile&q=Launch')} onNavigate={onNavigate} />)
    expect((screen.getByLabelText('Search titles') as HTMLInputElement).value).toBe('Launch')
    expect((screen.getByLabelText('Visibility') as HTMLSelectElement).value).toBe('current')
    expect((screen.getByLabelText('From date') as HTMLInputElement).value).toBe('2026-09-01')
    expect((screen.getByLabelText('To date') as HTMLInputElement).value).toBe('2026-09-30')
    expect((screen.getByLabelText('Sort') as HTMLSelectElement).value).toBe('name')
    expect((screen.getByLabelText('Group by') as HTMLSelectElement).value).toBe('profile')
    const chips = screen.getByLabelText('Active filters').textContent
    expect(chips).toContain('Source: desktop-db')
    expect(chips).toContain('Origin: desktop')
    expect(chips).toContain('Topic: Companion launch')
    expect(chips).toContain('Project: Launch plan')
    expect(chips).toContain('Type: direct')
    expect(screen.getByRole('button', { name: /Launch research/ })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Search titles'), { target: { value: 'Research' } })
    const next = onNavigate.mock.calls.at(-1)?.[0] as URLSearchParams
    expect(next.get('q')).toBe('Research')
    expect(next.getAll('source')).toEqual(['desktop-db'])
    expect(next.getAll('profile')).toEqual(['atlas'])
    expect(next.getAll('origin')).toEqual(['desktop'])

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    const cleared = onNavigate.mock.calls.at(-1)?.[0] as URLSearchParams

    for (const key of ['q', 'source', 'profile', 'origin', 'visibility', 'dateFrom', 'dateTo', 'topic', 'project', 'type']) {expect(cleared.has(key)).toBe(false)}
  })

  it('distinguishes verified empty results from update-required and failed coverage', () => {
    const { rerender } = render(<WorkDirectory {...props('section=projects', { projects: [] })} />)
    expect(screen.getByText('No eligible records')).toBeTruthy()
    expect(screen.getByText(/complete empty result/)).toBeTruthy()

    const unsupportedCoverage = { ...coverage, status: 'unsupported' as const, complete: false, projectStatus: 'unsupported' as const, message: 'Projects require a backend update.' }
    rerender(<WorkDirectory {...props('section=projects', { projects: [], coverage: [unsupportedCoverage] })} />)
    expect(screen.getAllByText('Backend update required').length).toBeGreaterThan(0)
    expect(screen.getByText(/not a complete empty result/)).toBeTruthy()

    const failedCoverage = { ...coverage, status: 'error' as const, complete: false, projectStatus: 'error' as const, message: 'Projects could not be verified.' }
    rerender(<WorkDirectory {...props('section=projects', { projects: [], coverage: [failedCoverage] })} />)
    expect(screen.getByText('Source coverage unavailable')).toBeTruthy()
    expect(screen.getByText(/not a complete empty result/)).toBeTruthy()

    const loadingCoverage = { ...coverage, status: 'loading' as const, complete: false, projectStatus: 'loading' as const, projectComplete: false }
    rerender(<WorkDirectory {...props('section=projects', { projects: [], coverage: [coverage, loadingCoverage] })} />)
    expect(screen.getByText('Loading verified source records…')).toBeTruthy()

    rerender(<WorkDirectory {...props('section=projects', { projects: [], coverage: [] })} />)
    expect(screen.getByText('Loading verified source records…')).toBeTruthy()
  })

  it('normalizes invalid URL enums and exposes complete keyboard-operable tab semantics', () => {
    const listing = props('section=sessions&archive=forged&group=forged')
    const { rerender } = render(<WorkDirectory {...listing} />)
    expect((screen.getByLabelText('Visibility') as HTMLSelectElement).value).toBe('all')
    expect((screen.getByLabelText('Group by') as HTMLSelectElement).value).toBe('none')
    const topics = screen.getByRole('tab', { name: 'Topics' })
    const projects = screen.getByRole('tab', { name: 'Projects' })
    expect(topics.tabIndex).toBe(-1)
    expect(projects.getAttribute('aria-controls')).toBe('work-directory-panel-projects')
    expect(document.getElementById('work-directory-panel-sessions')?.getAttribute('role')).toBe('tabpanel')
    expect(document.getElementById('work-directory-panel-projects')?.hidden).toBe(true)
    expect(document.getElementById('work-directory-panel-topics')?.hidden).toBe(true)
    fireEvent.keyDown(projects, { key: 'ArrowRight' })
    expect((listing.onNavigate.mock.calls.at(-1)?.[0] as URLSearchParams).get('section')).toBe('sessions')

    rerender(<WorkDirectory {...props('section=projects&focus=project-1&focusProfile=atlas&focusSource=desktop-db&tab=forged', { selectedProject: projectDetail, detailStatus: 'ready' })} />)
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('project-detail-tab-overview')
    expect(screen.getByText('Last activity')).toBeTruthy()
  })

  it('keeps the selected source identity in detail URLs and clears only focus when going back', () => {
    const listing = props('section=projects&q=Launch')
    const { rerender } = render(<WorkDirectory {...listing} />)
    fireEvent.click(screen.getByRole('button', { name: /Launch plan/ }))
    const focused = listing.onNavigate.mock.calls[0][0] as URLSearchParams
    expect(Object.fromEntries(focused)).toMatchObject({ section: 'projects', focus: 'project-1', focusProfile: 'atlas', focusSource: 'desktop-db', q: 'Launch' })

    const detail = props(focused.toString(), { selectedProject: projectDetail, detailStatus: 'ready' })
    rerender(<WorkDirectory {...detail} />)
    fireEvent.click(screen.getByRole('button', { name: '← Back to projects' }))
    const restored = detail.onNavigate.mock.calls[0][0] as URLSearchParams
    expect(restored.get('focus')).toBeNull()
    expect(restored.get('q')).toBe('Launch')
    expect(detail.onBack).toHaveBeenCalledOnce()
  })
})
