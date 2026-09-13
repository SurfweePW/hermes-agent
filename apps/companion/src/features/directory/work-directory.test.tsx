import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { validateCompanionProjectList, validateCompanionSessionList } from '../../gateway/companion-client'
import type { CompanionProject, CompanionProjectDetail, CompanionSession, CompanionSessionHistoryResult } from '../../gateway/types'
import type { ProfileSelectorOption } from '../../state/profile-selector'

import { createDirectoryStore, type DirectoryGateway, type DirectorySnapshot, type SourceCoverage } from './directory-store'
import { ChatsDirectory, WorkDirectory } from './work-directory'

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
  organization_complete: false, organization_message: 'Not hydrated.',
  membership_has_more: false, membership_next_cursor: null,
  coverage: { complete: true, freshness: '2026-09-06T10:00:00.000Z', message: null }
}

const snapshot = (change: Partial<DirectorySnapshot> = {}): DirectorySnapshot => ({
  projects: [project], sessions: [session], selectedProject: null, selectedSession: null, history: null,
  topics: [], selectedTopic: null, entityProjection: null, topicSourceDetails: [], topicCoverage: [], detailStatus: 'idle', detailMessage: null, coverage: [coverage], ...change
})

const props = (params: string, change: Partial<DirectorySnapshot> = {}) => ({
  snapshot: snapshot(change), params: new URLSearchParams(params), profileOptions: snapshot(change).coverage.map((item) => ({ teammateId: item.profile, profile: item.profile, name: item.profile === 'atlas' ? 'Atlas' : item.profile, servedByGateway: true, selectable: item.status !== 'error' && item.sessionStatus !== 'error' && item.projectStatus !== 'error', optionLabel: item.profile === 'atlas' ? 'Atlas' : item.profile, statusLabel: null, detail: null })), onNavigate: vi.fn(), onLoadOlder: vi.fn(),
  onLoadOlderHistory: vi.fn(), onLoadOlderProjectSessions: vi.fn(), onRefresh: vi.fn(), onBack: vi.fn(), onOpenOriginal: vi.fn()
})

const selectorOptions: ProfileSelectorOption[] = [
  { teammateId: 'atlas', profile: 'atlas', name: 'Atlas', servedByGateway: true, selectable: true, optionLabel: 'Atlas', statusLabel: null, detail: null },
  { teammateId: 'mentor', profile: 'mentor', name: 'Mentor', servedByGateway: true, selectable: false, optionLabel: 'Mentor — niedostępny', statusLabel: 'Niedostępny w tym połączeniu', detail: null },
  { teammateId: 'maven', profile: 'maven', name: 'Maven', servedByGateway: false, selectable: false, optionLabel: 'Maven — niedostępny', statusLabel: 'Niedostępny w tym połączeniu', detail: 'Ten profil nie jest obsługiwany przez bieżący gateway. Zmień konfigurację gatewaya, aby używać go w aplikacji.' }
]

describe('WorkDirectory', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exposes new-conversation entry only in the mobile Rozmowy layout', () => {
    const profileOptions = [
      { teammateId: 'atlas', profile: 'atlas', name: 'Atlas', servedByGateway: true, selectable: true, optionLabel: 'Atlas', statusLabel: null, detail: null },
      { teammateId: 'mentor', profile: 'mentor', name: 'Mentor', servedByGateway: true, selectable: true, optionLabel: 'Mentor', statusLabel: null, detail: null }
    ]
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390)

    const { unmount } = render(<ChatsDirectory {...props('')} onCreateConversation={vi.fn(async () => ({ status: 'admitted' as const, target: { backend_namespace: 'desktop-db', profile: 'atlas', stored_session_id: 'new' } }))} onOpenSession={vi.fn()} profileOptions={profileOptions} />)
    expect(screen.getByRole('button', { name: 'Nowa rozmowa' })).toBeTruthy()
    unmount()

    vi.restoreAllMocks()
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024)
    render(<ChatsDirectory {...props('')} onCreateConversation={vi.fn(async () => ({ status: 'admitted' as const, target: { backend_namespace: 'desktop-db', profile: 'atlas', stored_session_id: 'new' } }))} onOpenSession={vi.fn()} profileOptions={profileOptions} />)
    expect(screen.queryByRole('button', { name: 'Nowa rozmowa' })).toBeNull()
  })

  it('groups raw gateway sessions by authoritative project-tree membership and keeps unmatched sessions visible', async () => {
    const sessionPage = validateCompanionSessionList({
      profile: 'atlas', backend_namespace: 'desktop-db', coverage: 'complete', has_more: false, next_cursor: null,
      as_of: '2026-09-06T10:00:00Z', warnings: [],
      items: [
        { identity: { profile: 'atlas', backend_namespace: 'desktop-db', root_id: 'session-1' }, root_id: 'session-1', title: 'Grouped raw session', origin: 'desktop', archived: false, hidden: false, started_at: 1, last_active: 2, message_count: 3 },
        { identity: { profile: 'atlas', backend_namespace: 'desktop-db', root_id: 'session-2' }, root_id: 'session-2', title: 'Unmatched raw session', origin: 'desktop', archived: false, hidden: false, started_at: 1, last_active: 2, message_count: 1 }
      ]
    }, 'atlas')
    const projectPage = validateCompanionProjectList({
      profile: 'atlas', backend_namespace: 'desktop-db', coverage: { named_projects: 'complete', membership: 'complete' },
      has_more: false, next_cursor: null, as_of: '2026-09-06T10:00:00Z', warnings: [],
      items: [{ id: 'project-1', name: 'Raw Desktop project', kind: 'desktop_project', archived: false, profile: 'atlas', backend_namespace: 'desktop-db', session_count: 1, session_ids: ['session-1'], last_active: 2 }]
    }, 'atlas')
    const gateway: Partial<DirectoryGateway> = {
      listCompanionSessions: vi.fn(async () => sessionPage),
      listCompanionProjects: vi.fn(async () => projectPage),
      getCompanionSessionHistory: vi.fn(async () => history),
      getCompanionProject: vi.fn(async () => projectDetail)
    }
    const store = createDirectoryStore()
    await store.attach(gateway, ['atlas'])

    const listing = props('chatView=projects', store.getSnapshot())
    render(<ChatsDirectory {...listing} onOpenSession={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Raw Desktop project/ }))

    expect(screen.getByRole('button', { name: /Grouped raw session/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Unmatched raw session/ })).toBeTruthy()
    expect(screen.getByText('Bez projektu')).toBeTruthy()
  })

  it('shows unknown project membership separately from verified unassigned sessions', () => {
    render(<ChatsDirectory {...props('chatView=projects', {
      sessions: [
        { ...session, id: 'unknown', title: 'Unknown membership', project: undefined },
        { ...session, id: 'unassigned', title: 'Verified unassigned', project: null }
      ],
      projects: [],
      coverage: [{ ...coverage, complete: false, projectStatus: 'error', projectComplete: false }]
    })} onOpenSession={vi.fn()} />)

    expect(screen.getByText('Przypisanie projektu nieznane')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Unknown membership/ })).toBeTruthy()
    expect(screen.getByText('Bez projektu')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Verified unassigned/ })).toBeTruthy()
  })

  it('loads older Rozmowy pages from existing coverage for the selected profile', () => {
    const coderCoverage = { ...coverage, profile: 'coder', sessionsHasMore: true, sessionComplete: false }
    const atlasCoverage = { ...coverage, sessionsHasMore: true, sessionComplete: false }
    const listing = props('agent=atlas&chatView=recent', { coverage: [atlasCoverage, coderCoverage] })

    render(<ChatsDirectory {...listing} onOpenSession={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Wczytaj starsze od Atlas' }))
    expect(listing.onLoadOlder).toHaveBeenCalledWith('sessions', 'atlas')
    expect(screen.queryByRole('button', { name: 'Wczytaj starsze od Coder' })).toBeNull()
  })

  it('loads later project pages and does not claim project view completeness early', () => {
    const listing = props('agent=atlas&chatView=projects', {
      projects: [], sessions: [],
      coverage: [{ ...coverage, complete: false, projectCursor: 'projects-2', projectsHasMore: true, projectComplete: true }]
    })

    render(<ChatsDirectory {...listing} onOpenSession={vi.fn()} />)
    expect(screen.getByText('Niepełne dane rozmów')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Wczytaj więcej projektów od Atlas' }))
    expect(listing.onLoadOlder).toHaveBeenCalledWith('projects', 'atlas')
  })

  it('writes the Rozmowy search to the backend-observed chat query parameter', () => {
    const listing = props('chatView=recent')

    render(<ChatsDirectory {...listing} onOpenSession={vi.fn()} />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Szukaj rozmów' }), {
      target: { value: 'older session' }
    })

    const next = listing.onNavigate.mock.calls[0][0] as URLSearchParams
    expect(next.get('chatQ')).toBe('older session')
  })

  it.each([
    [{ id: 'project-1', title: 'Launch plan', profile: 'atlas' }, 'Atlas · Launch plan'],
    [null, 'Atlas · Bez projektu'],
    [undefined, 'Atlas · Projekt nieznany']
  ])('renders a semantic saved-session title and truthful project metadata for %#', (membership, metadata) => {
    const selectedSession = { ...session, project: membership } as CompanionSession
    render(<ChatsDirectory {...props('chat=session-1&chatProfile=atlas&chatSource=desktop-db', {
      selectedSession, history, detailStatus: 'ready'
    })} onOpenSession={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Launch research' })).toBeTruthy()
    expect(screen.getByText(metadata)).toBeTruthy()
  })

  it('keeps the saved-session draft when Back returns to the list', () => {
    const listing = props('chat=session-1&chatProfile=atlas&chatSource=desktop-db', {
      selectedSession: session, history, detailStatus: 'ready'
    })
    const onDraftChange = vi.fn()
    render(<ChatsDirectory {...listing} draft="unsent session draft" onDraftChange={onDraftChange} onOpenSession={vi.fn()} />)

    expect((screen.getByLabelText('Wiadomość do Atlas') as HTMLTextAreaElement).value).toBe('unsent session draft')
    fireEvent.click(screen.getByRole('button', { name: /Wróć do rozmów/ }))
    expect(listing.onBack).toHaveBeenCalledOnce()
    expect(onDraftChange).not.toHaveBeenCalled()
  })

  it('keeps mobile Enter as a newline and submits a saved session once by button', async () => {
    const onSubmitSession = vi.fn(async () => undefined)
    render(<ChatsDirectory {...props('chat=session-1&chatProfile=atlas&chatSource=desktop-db', {
      selectedSession: session, history, detailStatus: 'ready'
    })} draft="  continue named session  " onDraftChange={vi.fn()} onOpenSession={vi.fn()} onSubmitSession={onSubmitSession} />)
    const composer = screen.getByLabelText('Wiadomość do Atlas')

    fireEvent.keyDown(composer, { key: 'Enter' })
    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true, isComposing: true })
    expect(onSubmitSession).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Wyślij wiadomość' }))
    await waitFor(() => expect(onSubmitSession).toHaveBeenCalledOnce())
    expect(onSubmitSession).toHaveBeenCalledWith(session, '  continue named session  ')
  })

  it('shows sanitized retry feedback for a rejected saved-session submit without leaking its error', async () => {
    const onSubmitSession = vi.fn(async () => {throw new Error('gateway rejected API_KEY=synthetic-secret cookie=session-token')})
    render(<ChatsDirectory {...props('chat=session-1&chatProfile=atlas&chatSource=desktop-db', {
      selectedSession: session, history, detailStatus: 'ready'
    })} draft="  preserve this  " onDraftChange={vi.fn()} onOpenSession={vi.fn()} onSubmitSession={onSubmitSession} />)

    fireEvent.click(screen.getByRole('button', { name: 'Wyślij wiadomość' }))

    await waitFor(() => expect((screen.getByRole('button', { name: 'Wyślij wiadomość' }) as HTMLButtonElement).disabled).toBe(false))
    expect(onSubmitSession).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert').textContent).toBe('Nie udało się wysłać wiadomości. Treść pozostała w polu — spróbuj ponownie.')
    expect(screen.getByRole('heading', { name: 'Launch research' })).toBeTruthy()
    expect(onSubmitSession).toHaveBeenCalledWith(session, '  preserve this  ')
    expect((screen.getByLabelText('Wiadomość do Atlas') as HTMLTextAreaElement).value).toBe('  preserve this  ')
    expect(document.body.textContent).not.toContain('synthetic-secret')
  })

  it('fences pending state and late submit failures by exact saved-session identity', async () => {
    const sessionB: CompanionSession = {
      ...session,
      id: 'session-2',
      title: 'Second conversation',
      profile: 'coder',
      source: 'backend-2',
      project: null
    }
    let rejectA!: (error: Error) => void
    const pendingA = new Promise<void>((_resolve, reject) => {rejectA = reject})
    const onSubmitSession = vi.fn((item: CompanionSession) => item.id === session.id ? pendingA : Promise.resolve())
    const sessions = [session, sessionB]
    const viewA = props('chat=session-1&chatProfile=atlas&chatSource=desktop-db', {
      sessions, selectedSession: session, history, detailStatus: 'ready'
    })
    const { rerender } = render(<ChatsDirectory {...viewA} draft="Draft A" onDraftChange={vi.fn()} onOpenSession={vi.fn()} onSubmitSession={onSubmitSession} />)

    fireEvent.click(screen.getByRole('button', { name: 'Wyślij wiadomość' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Wyślij wiadomość' }) as HTMLButtonElement).disabled).toBe(true))

    const viewB = props('chat=session-2&chatProfile=coder&chatSource=backend-2', {
      sessions, selectedSession: sessionB, history: { ...history, session_id: sessionB.id, profile: sessionB.profile, source: sessionB.source }, detailStatus: 'ready'
    })
    rerender(<ChatsDirectory {...viewB} draft="Draft B" onDraftChange={vi.fn()} onOpenSession={vi.fn()} onSubmitSession={onSubmitSession} />)

    expect(screen.getByRole('heading', { name: 'Second conversation' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Wyślij wiadomość' }) as HTMLButtonElement).disabled).toBe(false)
    await act(async () => {rejectA(new Error('late failure from session A'))})

    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByRole('button', { name: 'Wyślij wiadomość' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('exposes Topics, Projects, and Sessions rows without claiming unsupported topics are empty', () => {
    const topics = props('section=topics', {
      topicCoverage: [{
        profile: 'atlas', status: 'unsupported', coverage: null,
        message: 'Topics require an organization backend update', cursor: null,
        hasMore: false, loaded: 0, total: null, backendNamespace: null
      }]
    })

    const { rerender } = render(<WorkDirectory {...topics} />)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Tematy', 'Projekty', 'Rozmowy'])
    expect(screen.getByText('Topics require an organization backend update')).toBeTruthy()

    rerender(<WorkDirectory {...props('section=projects')} />)
    expect(screen.getByRole('button', { name: /Launch plan/ })).toBeTruthy()

    rerender(<WorkDirectory {...props('section=sessions')} />)
    expect(screen.getByRole('button', { name: /Launch research/ })).toBeTruthy()
  })

  it('localizes detail loading fallbacks', () => {
    const view = render(<WorkDirectory {...props('section=sessions&focus=missing&focusProfile=atlas&focusSource=desktop-db', { detailStatus: 'loading' })} />)
    expect(screen.getByText('Wczytywanie zweryfikowanych szczegółów…')).toBeTruthy()
    expect(screen.getByText('Oczekiwanie na zapisaną projekcję źródła tylko do odczytu.')).toBeTruthy()

    view.rerender(<WorkDirectory {...props('section=sessions&focus=missing&focusProfile=atlas&focusSource=desktop-db', { detailStatus: 'unsupported' })} />)
    expect(screen.getByText('Wymagana aktualizacja backendu')).toBeTruthy()

    view.rerender(<WorkDirectory {...props('section=sessions&focus=missing&focusProfile=atlas&focusSource=desktop-db', { detailStatus: 'error' })} />)
    expect(screen.getByText('Szczegóły niedostępne')).toBeTruthy()
  })

  it('uses one conversation fallback title, Polish statuses, and conversation nouns', () => {
    const untitled = { ...session, title: '', status: 'completed' }
    const listing = props('chatView=recent', { sessions: [untitled] })
    const view = render(<ChatsDirectory {...listing} onOpenSession={vi.fn()} />)

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Ostatnie rozmowy', 'Projekty'])
    expect(screen.getByRole('tab', { name: 'Ostatnie rozmowy' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Istniejące zapisane rozmowy')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Nazwa rozmowy niedostępna/ }).textContent).toContain('Zakończone')
    fireEvent.click(screen.getByRole('button', { name: /Nazwa rozmowy niedostępna/ }))

    view.rerender(<WorkDirectory {...props('section=sessions&focus=session-1&focusProfile=atlas&focusSource=desktop-db', { selectedSession: untitled, history, detailStatus: 'ready' })} />)
    const heading = screen.getByRole('heading', { name: 'Nazwa rozmowy niedostępna' })
    expect(heading.getAttribute('title')).toBe('Nazwa rozmowy niedostępna')
    expect(screen.getByText('Ukończona')).toBeTruthy()
  })

  it('localizes linked topic status labels', () => {
    const linkedProject = { ...projectDetail, topics: [{ id: 'topic-1', title: 'Companion launch', status: 'active', profile: 'atlas', source: 'organization-db' }], organization_available: true, organization_complete: true }
    render(<WorkDirectory {...props('section=projects&focus=project-1&focusProfile=atlas&focusSource=desktop-db&tab=topics', { selectedProject: linkedProject, detailStatus: 'ready' })} />)
    expect(screen.getByText(/organization-db · atlas · Aktywny/)).toBeTruthy()
    expect(document.body.textContent).not.toContain(' · active')
  })

  it('opens direct read-only project details and session history', () => {
    const { rerender } = render(<WorkDirectory {...props('section=projects&focus=project-1&focusProfile=atlas&focusSource=desktop-db', { selectedProject: projectDetail, detailStatus: 'ready' })} />)
    expect(screen.getByText('Szczegóły źródła tylko do odczytu')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Rozmowy' }))

    rerender(<WorkDirectory {...props('section=sessions&focus=session-1&focusProfile=atlas&focusSource=desktop-db&tab=history', { selectedSession: session, history, detailStatus: 'ready' })} />)
    expect(screen.getByText('Please research launch timing.')).toBeTruthy()
    expect(screen.getByText('Research complete.')).toBeTruthy()
    expect(screen.getByText('Ty')).toBeTruthy()
    expect(screen.getByText('Asystent')).toBeTruthy()
    expect(screen.getByText(/Wyświetlenie historii nie wznawia ani nie aktywuje tej rozmowy/)).toBeTruthy()
    expect(screen.getByText(/Tool execution/)).toBeTruthy()
  })

  it('shows authorized live Project topics with their organization namespace and partial coverage', () => {
    const linkedProject: CompanionProjectDetail = {
      ...projectDetail,
      topics: [{ id: 'topic-1', title: 'Companion launch', status: 'active', profile: 'atlas', source: 'organization-db' }],
      organization_available: true,
      organization_complete: false,
      organization_message: 'Some authorized Topic relationships could not be verified.'
    }

    render(<WorkDirectory {...props('section=projects&focus=project-1&focusProfile=atlas&focusSource=desktop-db&tab=topics', { selectedProject: linkedProject, detailStatus: 'ready' })} />)

    expect(screen.getByText('Companion launch')).toBeTruthy()
    expect(screen.getByText(/organization-db.*atlas/)).toBeTruthy()
    expect(screen.getByText('Nie udało się zweryfikować części autoryzowanych powiązań tematów.')).toBeTruthy()
  })

  it('offers only a verified current-client original route and otherwise gives a complete fallback', () => {
    const unsupported = props('section=sessions&focus=session-1&focusProfile=atlas&focusSource=desktop-db&tab=history', { selectedSession: session, history, detailStatus: 'ready' })
    const { rerender } = render(<WorkDirectory {...unsupported} />)

    expect(screen.queryByRole('button', { name: 'Otwórz źródło' })).toBeNull()
    expect(screen.getAllByText('Szczegóły techniczne')[0].closest('details')?.hasAttribute('open')).toBe(false)
    expect(screen.getByText(/Kontynuuj tę rozmowę w dotychczasowym kliencie/)).toBeTruthy()
    expect(screen.getByText('Please research launch timing.')).toBeTruthy()

    const routedHistory: CompanionSessionHistoryResult = {
      ...history,
      original_route: { verified: true, client: 'hermes-desktop', platform: 'macos', url: 'hermes://session/session-1?profile=atlas' }
    }

    const routed = props('section=sessions&focus=session-1&focusProfile=atlas&focusSource=desktop-db&tab=history', { selectedSession: session, history: routedHistory, detailStatus: 'ready' })
    rerender(<WorkDirectory {...routed} />)
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz źródło' }))
    expect(routed.onOpenOriginal).toHaveBeenCalledWith(routedHistory.original_route, 'atlas', 'session-1')
  })

  it('hides native handoff when the current runtime has no verified opener', () => {
    const routedHistory: CompanionSessionHistoryResult = {
      ...history,
      original_route: { verified: true, client: 'hermes-desktop', platform: 'macos', url: 'hermes://session/session-1?profile=atlas' }
    }

    const routed = props('section=sessions&focus=session-1&focusProfile=atlas&focusSource=desktop-db&tab=history', {
      selectedSession: session, history: routedHistory, detailStatus: 'ready'
    })

    render(<WorkDirectory {...routed} onOpenOriginal={undefined} />)

    expect(screen.queryByRole('button', { name: 'Otwórz źródło' })).toBeNull()
    expect(screen.getAllByText('Szczegóły techniczne')[0].closest('details')?.hasAttribute('open')).toBe(false)
  })

  it('awaits native handoff and shows a safe fallback when it fails', async () => {
    const routedHistory: CompanionSessionHistoryResult = {
      ...history,
      original_route: { verified: true, client: 'hermes-desktop', platform: 'macos', url: 'hermes://session/session-1?profile=atlas' }
    }

    let rejectOpen!: (error: Error) => void
    const onOpenOriginal = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectOpen = reject }))

    const routed = props('section=sessions&focus=session-1&focusProfile=atlas&focusSource=desktop-db&tab=history', {
      selectedSession: session, history: routedHistory, detailStatus: 'ready'
    })

    render(<WorkDirectory {...routed} onOpenOriginal={onOpenOriginal} />)
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz źródło' }))

    expect((screen.getByRole('button', { name: 'Otwieranie źródła…' }) as HTMLButtonElement).disabled).toBe(true)
    rejectOpen(new Error('secret native detail'))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/nie mógł otworzyć/i))
    expect(document.body.textContent).not.toContain('secret native detail')
    expect(screen.getAllByText('Szczegóły techniczne')[0].closest('details')?.hasAttribute('open')).toBe(false)
  })

  it('uses verified entity projections and Library relationship routes in project and session details', () => {
    const projection = { status: 'ready' as const, complete: true, work: [], needsMe: [], message: null }

    const projectView = props('section=projects&focus=project-1&focusProfile=atlas&focusSource=desktop-db&tab=needs%20me', {
      selectedProject: projectDetail, entityProjection: projection, detailStatus: 'ready'
    })

    const { rerender } = render(<WorkDirectory {...projectView} />)
    expect(screen.getByText('Brak pozycji wymagających mnie')).toBeTruthy()

    const projectFiles = props('section=projects&focus=project-1&focusProfile=atlas&focusSource=desktop-db&tab=files', {
      selectedProject: projectDetail, entityProjection: projection, detailStatus: 'ready'
    })

    rerender(<WorkDirectory {...projectFiles} />)
    fireEvent.click(screen.getByRole('button', { name: 'Zobacz pliki' }))
    expect(Object.fromEntries(projectFiles.onNavigate.mock.calls[0][0] as URLSearchParams)).toEqual({
      view: 'library', libraryProfile: 'atlas', libraryProject: 'project-1'
    })

    const sessionView = props('section=sessions&focus=session-1&focusProfile=atlas&focusSource=desktop-db&tab=linked%20work', {
      selectedSession: session, history, entityProjection: projection, detailStatus: 'ready'
    })

    rerender(<WorkDirectory {...sessionView} />)
    expect(screen.getByText('Brak powiązanej pracy')).toBeTruthy()

    const sessionFiles = props('section=sessions&focus=session-1&focusProfile=atlas&focusSource=desktop-db&tab=files', {
      selectedSession: session, history, entityProjection: projection, detailStatus: 'ready'
    })

    rerender(<WorkDirectory {...sessionFiles} />)
    fireEvent.click(screen.getByRole('button', { name: 'Zobacz pliki' }))
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

    expect(screen.getByText(/Załącznik obrazu/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('/Users/alice')
    expect(document.body.textContent).not.toContain('data:image')
    expect(document.body.textContent).not.toContain('[sender|123]')
  })

  it('renders compression summaries as collapsed statuses and keeps their content privacy-safe', () => {
    const compressed: CompanionSessionHistoryResult = {
      ...history,
      entries: [{ id: 'compressed', kind: 'compression', role: 'user', label: 'Compression summary', occurred_at: null, content: '[CONTEXT SUMMARY]:\n[Image attached at: /Users/alice/private/context.png]' }]
    }

    render(<WorkDirectory {...props('section=sessions&focus=session-1&focusProfile=atlas&focusSource=desktop-db&tab=history', { selectedSession: session, history: compressed, detailStatus: 'ready' })} />)

    const disclosure = screen.getAllByRole('group')[2]
    expect(screen.getByText('Compression summary')).toBeTruthy()
    expect(document.body.textContent).not.toContain('CONTEXT SUMMARY')
    fireEvent.click(screen.getByText('Compression summary'))
    expect(document.body.textContent).toContain('CONTEXT SUMMARY')
    expect(document.body.textContent).not.toContain('/Users/alice')
    expect(screen.queryByText('You')).toBeNull()
    expect(disclosure.hasAttribute('open')).toBe(true)
  })

  it('uses the shared inert status disclosure for every persisted technical event', () => {
    const unsafeHistory: CompanionSessionHistoryResult = {
      ...history,
      entries: [
        { id: 'tool', kind: 'tool', role: null, label: '<img src=x onerror=alert(1)>', occurred_at: null, content: '<script>alert(1)</script>' },
        { id: 'internal', kind: 'internal', role: null, label: 'Internal event', occurred_at: null, content: '[safe](https://example.com) [unsafe](javascript:alert(1))' },
        { id: 'compression', kind: 'compression', role: null, label: 'Compression summary', occurred_at: null, content: '<svg onload=alert(1)>' }
      ]
    }

    render(<ChatsDirectory {...props('chat=session-1&chatProfile=atlas&chatSource=desktop-db', { selectedSession: session, history: unsafeHistory, detailStatus: 'ready' })} onOpenSession={vi.fn()} />)

    expect(screen.getAllByRole('group')).toHaveLength(5)
    expect(document.body.textContent).not.toContain('<script>')
    expect(document.querySelector('img, script, svg')).toBeNull()

    fireEvent.click(screen.getByText('<img src=x onerror=alert(1)>'))
    expect(document.body.textContent).toContain('<script>alert(1)</script>')
    expect(document.querySelector('img, script, svg')).toBeNull()

    fireEvent.click(screen.getByText('Internal event'))
    expect(screen.getByRole('link', { name: 'safe' }).getAttribute('href')).toBe('https://example.com')
    expect(screen.queryByRole('link', { name: 'unsafe' })).toBeNull()

    fireEvent.click(screen.getByText('Compression summary'))
    expect(document.body.textContent).toContain('<svg onload=alert(1)>')
    expect(document.querySelector('svg')).toBeNull()
  })

  it('preserves the saved-history anchor on prepend without announcing old rows', () => {
    let scrollHeight = 1_200
    const initial = { ...history, has_more: true, next_cursor: 'older', entries: history.entries.filter((entry) => entry.kind === 'message') }
    const listing = props('chat=session-1&chatProfile=atlas&chatSource=desktop-db', { selectedSession: session, history: initial, detailStatus: 'ready' })
    const view = render(<ChatsDirectory {...listing} onOpenSession={vi.fn()} />)
    const transcript = document.querySelector('.history-transcript') as HTMLDivElement
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, value: 200, writable: true }
    })
    fireEvent.scroll(transcript)

    scrollHeight = 1_450
    const older = { ...initial, has_more: false, next_cursor: null, entries: [{ id: 'older', kind: 'message' as const, role: 'assistant' as const, content: 'Older row', label: null, occurred_at: null }, ...initial.entries] }
    view.rerender(<ChatsDirectory {...props('chat=session-1&chatProfile=atlas&chatSource=desktop-db', { selectedSession: session, history: older, detailStatus: 'ready' })} onOpenSession={vi.fn()} />)

    expect(transcript.scrollTop).toBe(450)
    expect(screen.queryByRole('button', { name: '↓ Nowe wiadomości' })).toBeNull()
  })

  it('follows saved-history appends only near bottom and announces them only while away', () => {
    let scrollHeight = 1_200
    const initial = { ...history, entries: history.entries.filter((entry) => entry.kind === 'message') }
    const view = render(<ChatsDirectory {...props('chat=session-1&chatProfile=atlas&chatSource=desktop-db', { selectedSession: session, history: initial, detailStatus: 'ready' })} onOpenSession={vi.fn()} />)
    const transcript = document.querySelector('.history-transcript') as HTMLDivElement
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, value: 880, writable: true }
    })
    fireEvent.scroll(transcript)

    scrollHeight = 1_400
    const appended = { ...initial, entries: [...initial.entries, { id: 'new-near', kind: 'message' as const, role: 'assistant' as const, content: 'Near append', label: null, occurred_at: null }] }
    view.rerender(<ChatsDirectory {...props('chat=session-1&chatProfile=atlas&chatSource=desktop-db', { selectedSession: session, history: appended, detailStatus: 'ready' })} onOpenSession={vi.fn()} />)
    expect(transcript.scrollTop).toBe(1_400)
    expect(screen.queryByRole('button', { name: '↓ Nowe wiadomości' })).toBeNull()

    transcript.scrollTop = 200
    fireEvent.scroll(transcript)
    scrollHeight = 1_600
    const awayAppend = { ...appended, entries: [...appended.entries, { id: 'new-away', kind: 'message' as const, role: 'assistant' as const, content: 'Away append', label: null, occurred_at: null }] }
    view.rerender(<ChatsDirectory {...props('chat=session-1&chatProfile=atlas&chatSource=desktop-db', { selectedSession: session, history: awayAppend, detailStatus: 'ready' })} onOpenSession={vi.fn()} />)

    expect(transcript.scrollTop).toBe(200)
    fireEvent.click(screen.getByRole('button', { name: '↓ Nowe wiadomości' }))
    expect(transcript.scrollTop).toBe(1_600)
  })

  it('restores saved-history positions by source, profile, and stored id across switches and remounts', () => {
    const historyAt = (source: string, id: string) => ({ ...history, source, session_id: id, entries: [{ ...history.entries[0], id: `${source}-${id}` }] })
    const sessionAt = (source: string, id: string) => ({ ...session, source, id })
    const renderAt = (source: string, id: string) => <ChatsDirectory {...props(`chat=${id}&chatProfile=atlas&chatSource=${source}`, { selectedSession: sessionAt(source, id), history: historyAt(source, id), detailStatus: 'ready' })} onOpenSession={vi.fn()} />
    const view = render(renderAt('source-a', 'same-id'))
    const transcript = document.querySelector('.history-transcript') as HTMLDivElement
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: { configurable: true, value: 240, writable: true }
    })
    fireEvent.scroll(transcript)

    view.rerender(renderAt('source-b', 'same-id'))
    transcript.scrollTop = 510
    fireEvent.scroll(transcript)
    view.rerender(renderAt('source-a', 'same-id'))
    expect(transcript.scrollTop).toBe(240)

    view.unmount()
    render(renderAt('source-a', 'same-id'))
    expect((document.querySelector('.history-transcript') as HTMLDivElement).scrollTop).toBe(240)
  })

  it('never presents unknown project membership as verified absence', () => {
    render(<WorkDirectory {...props('section=sessions', { sessions: [{ ...session, project: null }] })} />)

    expect(screen.getByRole('button', { name: /Nie zgłoszono przypisania do projektu/ })).toBeTruthy()
    expect(document.body.textContent).not.toContain('Brak projektu')
  })

  it('exposes functional visibility, source, origin, date, topic, project, and type filters with chips and clear', () => {
    const onNavigate = vi.fn()
    render(<WorkDirectory {...props('section=sessions&source=desktop-db&profile=atlas&origin=desktop&visibility=current&dateFrom=2026-09-01&dateTo=2026-09-30&topic=topic-1&project=project-1&type=direct&sort=name&group=profile&q=Launch')} onNavigate={onNavigate} />)
    expect((screen.getByLabelText('Szukaj nazw') as HTMLInputElement).value).toBe('Launch')
    expect((screen.getByLabelText('Widoczność') as HTMLSelectElement).value).toBe('current')
    expect((screen.getByLabelText('Data od') as HTMLInputElement).value).toBe('2026-09-01')
    expect((screen.getByLabelText('Data do') as HTMLInputElement).value).toBe('2026-09-30')
    expect((screen.getByLabelText('Sortowanie') as HTMLSelectElement).value).toBe('name')
    expect((screen.getByLabelText('Grupuj według') as HTMLSelectElement).value).toBe('profile')
    const chips = screen.getByLabelText('Aktywne filtry').textContent
    expect(chips).toContain('Źródło: desktop-db')
    expect(chips).toContain('Pochodzenie: desktop')
    expect(chips).toContain('Temat: Companion launch')
    expect(chips).toContain('Projekt: Launch plan')
    expect(chips).toContain('Typ: direct')
    expect(screen.getByRole('button', { name: /Launch research/ })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Szukaj nazw'), { target: { value: 'Research' } })
    const next = onNavigate.mock.calls.at(-1)?.[0] as URLSearchParams
    expect(next.get('q')).toBe('Research')
    expect(next.getAll('source')).toEqual(['desktop-db'])
    expect(next.getAll('profile')).toEqual(['atlas'])
    expect(next.getAll('origin')).toEqual(['desktop'])

    fireEvent.click(screen.getByRole('button', { name: 'Wyczyść filtry' }))
    const cleared = onNavigate.mock.calls.at(-1)?.[0] as URLSearchParams

    for (const key of ['q', 'source', 'profile', 'origin', 'visibility', 'dateFrom', 'dateTo', 'topic', 'project', 'type']) {expect(cleared.has(key)).toBe(false)}
  })

  it('distinguishes verified empty results from update-required and failed coverage', () => {
    const { rerender } = render(<WorkDirectory {...props('section=projects', { projects: [] })} />)
    expect(screen.getByText('Brak dostępnych rekordów')).toBeTruthy()
    expect(screen.getByText(/pełną pustą listę/)).toBeTruthy()

    const unsupportedCoverage = { ...coverage, status: 'unsupported' as const, complete: false, projectStatus: 'unsupported' as const, message: 'Projects require a backend update.' }
    rerender(<WorkDirectory {...props('section=projects', { projects: [], coverage: [unsupportedCoverage] })} />)
    expect(screen.getAllByText('Wymagana aktualizacja backendu').length).toBeGreaterThan(0)
    expect(screen.getByText(/nie jest potwierdzoną pustą listą/)).toBeTruthy()

    const failedCoverage = { ...coverage, status: 'error' as const, complete: false, projectStatus: 'error' as const, message: 'Projects could not be verified.' }
    rerender(<WorkDirectory {...props('section=projects', { projects: [], coverage: [failedCoverage] })} />)
    expect(screen.getByText('Zakres źródeł niedostępny')).toBeTruthy()
    expect(screen.getByText(/nie jest potwierdzoną pustą listą/)).toBeTruthy()

    const loadingCoverage = { ...coverage, status: 'loading' as const, complete: false, projectStatus: 'loading' as const, projectComplete: false }
    rerender(<WorkDirectory {...props('section=projects', { projects: [], coverage: [coverage, loadingCoverage] })} />)
    expect(screen.getByText('Wczytywanie zweryfikowanych rekordów źródłowych…')).toBeTruthy()

    rerender(<WorkDirectory {...props('section=projects', { projects: [], coverage: [] })} />)
    expect(screen.getByText('Wczytywanie zweryfikowanych rekordów źródłowych…')).toBeTruthy()
  })

  it('normalizes invalid URL enums and exposes complete keyboard-operable tab semantics', () => {
    const listing = props('section=sessions&archive=forged&group=forged')
    const { rerender } = render(<WorkDirectory {...listing} />)
    expect((screen.getByLabelText('Widoczność') as HTMLSelectElement).value).toBe('all')
    expect((screen.getByLabelText('Grupuj według') as HTMLSelectElement).value).toBe('none')
    const topics = screen.getByRole('tab', { name: 'Tematy' })
    const projects = screen.getByRole('tab', { name: 'Projekty' })
    expect(topics.tabIndex).toBe(-1)
    expect(projects.getAttribute('aria-controls')).toBe('work-directory-panel-projects')
    expect(document.getElementById('work-directory-panel-sessions')?.getAttribute('role')).toBe('tabpanel')
    expect(document.getElementById('work-directory-panel-projects')?.hidden).toBe(true)
    expect(document.getElementById('work-directory-panel-topics')?.hidden).toBe(true)
    fireEvent.keyDown(projects, { key: 'ArrowRight' })
    expect((listing.onNavigate.mock.calls.at(-1)?.[0] as URLSearchParams).get('section')).toBe('sessions')

    rerender(<WorkDirectory {...props('section=projects&focus=project-1&focusProfile=atlas&focusSource=desktop-db&tab=forged', { selectedProject: projectDetail, detailStatus: 'ready' })} />)
    expect(screen.getByRole('tab', { name: 'Przegląd' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('project-detail-tab-overview')
    expect(screen.getByText('Ostatnia aktywność')).toBeTruthy()
  })

  it('keeps the selected source identity in detail URLs and clears only focus when going back', () => {
    const listing = props('section=projects&q=Launch')
    const { rerender } = render(<WorkDirectory {...listing} />)
    fireEvent.click(screen.getByRole('button', { name: /Launch plan/ }))
    const focused = listing.onNavigate.mock.calls[0][0] as URLSearchParams
    expect(Object.fromEntries(focused)).toMatchObject({ section: 'projects', focus: 'project-1', focusProfile: 'atlas', focusSource: 'desktop-db', q: 'Launch' })

    const detail = props(focused.toString(), { selectedProject: projectDetail, detailStatus: 'ready' })
    rerender(<WorkDirectory {...detail} />)
    fireEvent.click(screen.getByRole('button', { name: '← Wróć do projektów' }))
    const restored = detail.onNavigate.mock.calls[0][0] as URLSearchParams
    expect(restored.get('focus')).toBeNull()
    expect(restored.get('q')).toBe('Launch')
    expect(detail.onBack).toHaveBeenCalledOnce()
  })

  it('preserves a new-conversation draft on refusal and unknown outcome, then clears it only after admission', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390)
    const outcomes = [
      { status: 'refused' as const },
      { status: 'unknown' as const },
      { status: 'admitted' as const, target: { profile: 'atlas', backend_namespace: 'backend-1', stored_session_id: 'stored-1' } }
    ]
    const create = vi.fn(async (_profile: string, _text: string) => outcomes.shift()!)
    const Harness = () => {
      const [draft, setDraft] = useState('')

      return <ChatsDirectory {...props('section=sessions')} draft={draft} onCreateConversation={async (profile, text) => {
        const outcome = await create(profile, text)

        if (outcome.status === 'admitted') {setDraft('')}

        return outcome
      }} onDraftChange={setDraft} onOpenSession={vi.fn()} profileOptions={selectorOptions} />
    }

    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Nowa rozmowa' }))
    fireEvent.change(screen.getByLabelText('Pierwsza wiadomość'), { target: { value: 'Nie zgub tej wiadomości' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Nowa rozmowa' }))
    expect(await screen.findByText(/Nie można teraz utworzyć rozmowy/)).toBeTruthy()
    expect((screen.getByLabelText('Pierwsza wiadomość') as HTMLTextAreaElement).value).toBe('Nie zgub tej wiadomości')
    expect(screen.getByRole('form', { name: 'Nowa rozmowa' })).toBeTruthy()

    fireEvent.submit(screen.getByRole('form', { name: 'Nowa rozmowa' }))
    expect(await screen.findByText(/Nie można potwierdzić utworzenia rozmowy/)).toBeTruthy()
    expect((screen.getByLabelText('Pierwsza wiadomość') as HTMLTextAreaElement).value).toBe('Nie zgub tej wiadomości')

    fireEvent.submit(screen.getByRole('form', { name: 'Nowa rozmowa' }))
    await waitFor(() => expect((screen.getByLabelText('Pierwsza wiadomość') as HTMLTextAreaElement).value).toBe(''))
    expect(create).toHaveBeenCalledTimes(3)
  })

  it('uses the same selectable profile set in the conversation composer and Chats filter', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390)
    render(<ChatsDirectory {...props('section=sessions')} onCreateConversation={vi.fn(async () => ({ status: 'refused' as const }))} onOpenSession={vi.fn()} profileOptions={selectorOptions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Nowa rozmowa' }))
    const selectors = screen.getAllByLabelText('Rozmawiaj z') as HTMLSelectElement[]

    expect(selectors).toHaveLength(2)
    for (const selector of selectors) {
      const options = Array.from(selector.options).filter((option) => option.value && option.value !== 'all')
      expect(options.map((option) => [option.value, option.disabled])).toEqual([
        ['atlas', false],
        ['mentor', true],
        ['maven', true]
      ])
    }
    expect(screen.getAllByRole('option', { name: /Maven — niedostępny/ }).every((option) => (option as HTMLOptionElement).disabled)).toBe(true)
  })
})
