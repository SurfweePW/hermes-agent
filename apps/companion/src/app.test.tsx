import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App, libraryAssetParams } from './app'
import { createFakeGateway, FakeCompanionGateway } from './fixtures/fake-gateway'
import { createFakeWorkGateway, FakeWorkGateway } from './fixtures/fake-work-gateway'
import type { CreateCompanionSessionRequest } from './gateway/types'
import type { OwnerAuthBridge } from './security/owner-auth'
import type { SessionSecretStore } from './security/secret-store'
import { createCompanionStore } from './state/companion-store'

async function readyStore() {
  const store = createCompanionStore({ gatewayFactory: createFakeGateway, storage: { getItem: () => null, setItem: () => undefined } })
  await store.configure({ baseUrl: 'http://fixture.invalid', token: 'test-token' })

  return store
}

async function readyDirectoryStore() {
  const store = createCompanionStore({ gatewayFactory: createFakeWorkGateway, storage: { getItem: () => null, setItem: () => undefined } })
  await store.configure({ baseUrl: 'http://fixture.invalid', token: 'test-token' })

  return store
}

async function readyOwnerDirectoryStore(gateway = new FakeWorkGateway()) {
  const ownerAuth: OwnerAuthBridge = {
    ownerSignIn: vi.fn(async () => ({ signedIn: true, ownerScope: 'owner-account-a' })),
    ownerStatus: vi.fn(),
    ownerSignOut: vi.fn(),
    ownerWebSocketUrl: vi.fn(async () => 'wss://fixture.invalid/api/ws?ticket=owner')
  }

  const values = new Map<string, string>()

  const store = createCompanionStore({
    gatewayFactory: () => gateway,
    ownerAuthBridge: ownerAuth,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {values.set(key, value)},
      removeItem: (key) => {values.delete(key)}
    },
    creationLock: {
      request: async (_name, _options, callback) => callback({ name: _name })
    }
  })

  await store.configureOwner({ baseUrl: 'https://fixture.invalid' })

  return { store, gateway }
}

const libraryArtifactId = `art_${'a'.repeat(64)}`

describe('App', () => {
  it('retains the explicit full Library reference for exact server resolution', () => {
    const params = libraryAssetParams('hoffeecmo', 'library:recommendations/a6-report.md')

    expect(Object.fromEntries(params)).toEqual({
      view: 'library',
      libraryProfile: 'hoffeecmo',
      libraryOpen: 'library:recommendations/a6-report.md'
    })
  })

  beforeEach(() => window.history.replaceState({}, '', '/'))
  afterEach(() => {vi.useRealTimers(); vi.restoreAllMocks()})
  it('keeps durable work in Needs Me, shows the old-server boundary and preserves runtime attention', async () => {
    const store = await readyStore()
    render(<App store={store} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Decyzje' })[0])
    expect(screen.getByRole('heading', { name: 'Do decyzji' })).toBeTruthy()
    expect(screen.getByText(/does not support the durable work inbox/)).toBeTruthy()
    expect(screen.getByText('Runtime-local attention')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Kanban' })).toBeNull()
  })

  it('shows one canonical decision badge for the same Work and runtime-attention record', async () => {
    const gateway = new FakeWorkGateway()
    vi.spyOn(gateway, 'listAttention').mockResolvedValue({
      items: [{
        id: 'synthetic:review:2', kind: 'approval', profile: 'atlas', runtime_session_id: 'runtime-review',
        stored_session_id: 'synthetic-session-1', title: 'Review', detail: 'Same canonical ask',
        occurred_at: 1, actionable: true, resolution: 'approval',
        work_ref: { profile: 'atlas', id: 'fixture-review' }
      }],
      scope: 'This gateway runtime only'
    })
    const store = createCompanionStore({ gatewayFactory: () => gateway, storage: { getItem: () => null, setItem: () => undefined } })
    await store.configure({ baseUrl: 'http://fixture.invalid', token: 'test-token' })

    render(<App store={store} />)

    expect(screen.getAllByRole('button', { name: 'Decyzje, 1 items' })).toHaveLength(2)
  })

  it('routes an authoritative project priority through the existing directory contract', async () => {
    const gateway = new FakeWorkGateway()
    Object.assign(gateway, { listNeedsMePriorities: vi.fn(async () => ({
      profile: 'atlas', backend_namespace: 'priority-aggregate-default', sort: 'recommended' as const,
      policy_version: 'v1', review_id: null, group_by: 'project' as const, as_of: '2026-09-01T00:00:00Z',
      coverage: { work: 'complete', organization: 'complete', authorization_filtered: true },
      groups: [{
        id: 'wrapper-id', eligibility: 'assessed' as const, eligible_action_count: 1, why_here: 'Project review',
        group: { kind: 'project' as const, id: 'canonical-priority-project', source_id: 'synthetic-project-1', namespace: { backend_id: 'fixture-mac-mini', profile: 'atlas' }, name: 'Companion project', collection: null, objective: null },
        items: [{ profile: 'atlas', work_id: 'fixture-review', candidate_id: 'candidate-review', eligibility: 'assessed' as const, why_here: 'Project review', next_step: 'Decide', trade_off: 'Wait', assessed_at: null, evidence: [], assessment: null, override: null }]
      }]
    })) })
    const store = createCompanionStore({ gatewayFactory: () => gateway, storage: { getItem: () => null, setItem: () => undefined } })
    await store.configure({ baseUrl: 'http://fixture.invalid', token: 'test-token' })
    window.history.replaceState({}, '', '/?view=needs')
    render(<App store={store} />)

    fireEvent.click(screen.getByRole('button', { name: /Prepare a sample campaign brief/ }))
    await screen.findByRole('button', { name: 'Otwórz projekt' })
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz projekt' }))

    await waitFor(() => expect(Object.fromEntries(new URLSearchParams(window.location.search))).toMatchObject({
      view: 'work', section: 'projects', focus: 'synthetic-project-1', focusProfile: 'atlas', focusSource: 'fixture-mac-mini'
    }))
    await waitFor(() => expect(screen.getByText('[SYNTHETIC QA] Companion project')).toBeTruthy())
  })

  it('does not badge or render stale runtime attention while disconnected', async () => {
    const gateway = new FakeCompanionGateway()
    vi.spyOn(gateway, 'listAttention').mockResolvedValue({
      items: [{
        id: 'runtime-attention:approval:1', kind: 'approval', profile: 'atlas', runtime_session_id: 'runtime-attention',
        stored_session_id: 'stored-attention', title: 'Runtime-local attention', detail: 'Approve this runtime request',
        occurred_at: 1, actionable: true, resolution: 'approval'
      }],
      scope: 'This gateway runtime only'
    })
    const store = createCompanionStore({ gatewayFactory: () => gateway, storage: { getItem: () => null, setItem: () => undefined } })
    await store.configure({ baseUrl: 'http://fixture.invalid', token: 'test-token' })
    render(<App store={store} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Decyzje, 1 items' }))[0])
    expect(screen.getByText('Approve this runtime request')).toBeTruthy()

    gateway.close()

    await waitFor(() => expect(store.getSnapshot().phase).toBe('disconnected'))
    expect(screen.queryByText('Approve this runtime request')).toBeNull()
    expect(screen.queryByRole('button', { name: /Decyzje, 1 items/ })).toBeNull()
  })

  it('shows fresh runtime attention when a retained Work source fails to refresh', async () => {
    const gateway = new FakeWorkGateway()
    vi.spyOn(gateway, 'listAttention').mockResolvedValue({
      items: [{
        id: 'runtime-after-work-outage', kind: 'approval', profile: 'atlas', runtime_session_id: 'runtime-review',
        stored_session_id: 'synthetic-session-1', title: 'Fresh runtime approval', detail: 'Visible after the Work-only outage',
        occurred_at: 2, actionable: true, resolution: 'approval',
        work_ref: { profile: 'atlas', id: 'fixture-review' }
      }],
      scope: 'This gateway runtime only'
    })
    const { store } = await readyOwnerDirectoryStore(gateway)
    render(<App store={store} />)
    vi.spyOn(gateway, 'listWork').mockRejectedValue(new Error('Work refresh failed'))

    await store.work.refresh()
    await store.refreshAttention()
    fireEvent.click(screen.getAllByRole('button', { name: 'Decyzje, 1 items' })[0])

    expect(await screen.findByText('Visible after the Work-only outage')).toBeTruthy()
    expect(store.work.getSnapshot().sources.find((source) => source.profile === 'atlas')?.status).toBe('error')
  })

  it('refreshes an open directory on foreground return without duplicating work refreshes', async () => {
    const store = await readyDirectoryStore()
    window.history.replaceState({}, '', '/?view=work')
    const workRefresh = vi.spyOn(store.work, 'refresh')
    const directoryRefresh = vi.spyOn(store.directory, 'refresh')
    render(<App store={store} />)
    fireEvent(document, new Event('visibilitychange'))
    expect(workRefresh).toHaveBeenCalledOnce()
    expect(directoryRefresh).toHaveBeenCalledOnce()
  })

  it('refreshes an open directory within thirty seconds and not while hidden', async () => {
    vi.useFakeTimers()
    const store = await readyDirectoryStore()
    window.history.replaceState({}, '', '/?view=work')
    const directoryRefresh = vi.spyOn(store.directory, 'refresh')
    render(<App store={store} />)

    vi.advanceTimersByTime(30_000)
    expect(directoryRefresh).toHaveBeenCalledOnce()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    vi.advanceTimersByTime(30_000)
    expect(directoryRefresh).toHaveBeenCalledOnce()
    visibility.mockRestore()
    vi.useRealTimers()
  })

  it('refreshes every persisted catalog without moving keyboard focus', async () => {
    vi.useFakeTimers()
    const store = await readyDirectoryStore()
    const workRefresh = vi.spyOn(store.work, 'refresh')
    const directoryRefresh = vi.spyOn(store.directory, 'refresh')
    const attentionRefresh = vi.spyOn(store, 'refreshAttention')
    render(<App store={store} />)
    const navigation = screen.getAllByRole('button', { name: 'Rozmowy' })[0]
    navigation.focus()

    vi.advanceTimersByTime(30_000)
    expect(workRefresh).toHaveBeenCalledOnce()
    expect(directoryRefresh).toHaveBeenCalledOnce()
    expect(attentionRefresh).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(navigation)
    vi.useRealTimers()
  })

  it('renders first-run gateway setup without exposing a token as text', () => {
    const store = createCompanionStore({ gatewayFactory: createFakeGateway, storage: { getItem: () => null, setItem: () => undefined } })
    render(<App store={store} />)
    expect(screen.getByRole('heading', { name: 'Connect Hermes Companion' })).toBeTruthy()
    expect(screen.getByLabelText('Session token').getAttribute('type')).toBe('password')
    expect(document.body.textContent).not.toContain('test-token')
  })

  it('offers native Google owner sign-in during setup and reaches owner-ready without a token', async () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(async () => ({ signedIn: true, ownerScope: 'owner-account-a', ignored: 'native-owner-secret' })),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn(async () => 'wss://fixture.invalid/api/ws?ticket=single-use-ticket')
    }

    const store = createCompanionStore({
      gatewayFactory: createFakeGateway,
      ownerAuthBridge: ownerAuth,
      storage: { getItem: () => null, setItem: () => undefined }
    })

    render(<App store={store} />)
    fireEvent.change(screen.getByLabelText('Gateway base URL'), { target: { value: 'https://fixture.invalid/' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }))

    await waitFor(() => expect(store.getSnapshot()).toMatchObject({ phase: 'ready', connectionMode: 'owner' }))
    expect(ownerAuth.ownerSignIn).toHaveBeenCalledWith({ baseUrl: 'https://fixture.invalid' })
    expect(document.body.textContent).not.toContain('native-owner-secret')
    expect(screen.getByText('Companion is ready')).toBeTruthy()
  })

  it('describes owner bootstrap without claiming it is Android-only', () => {
    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn()
    }

    const store = createCompanionStore({
      gatewayFactory: createFakeGateway,
      ownerAuthBridge: ownerAuth,
      storage: { getItem: () => null, setItem: () => undefined }
    })

    render(<App store={store} />)

    expect(screen.getByText(/native app.*system browser.*single-use connection ticket/i)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Android browser flow/i)
  })

  it('does not offer browser owner bootstrap when the trusted native bridge is unavailable', () => {
    const store = createCompanionStore({ gatewayFactory: createFakeGateway, storage: { getItem: () => null, setItem: () => undefined } })

    render(<App store={store} />)

    expect(screen.queryByRole('button', { name: 'Sign in with Google' })).toBeNull()
    expect(screen.getByText(/Google owner sign-in requires a trusted native app bridge.*Browser setup requires a session token/i)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/only in the native Android app/i)
  })

  it('truthfully distinguishes encrypted native storage and allows a saved-token connection', async () => {
    let token: string | undefined = 'saved-native-token'

    const secretStore: SessionSecretStore = {
      persistent: true,
      get: () => token,
      set: (_name, value) => { token = value },
      delete: () => { token = undefined },
      revoke: () => { token = undefined },
      clear: () => undefined
    }

    const store = createCompanionStore({ gatewayFactory: createFakeGateway, secretStore, storage: { getItem: () => 'http://fixture.invalid', setItem: () => undefined } })
    render(<App store={store} />)

    expect(screen.getByText(/native app stores the token encrypted/i)).toBeTruthy()
    expect(screen.getByLabelText('Session token').hasAttribute('required')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /use saved token/i }))
    await waitFor(() => expect(store.getSnapshot().phase).toBe('ready'))
    expect(document.body.textContent).not.toContain('saved-native-token')
  })

  it('labels browser credentials session-only and provides an explicit saved-token reset', async () => {
    let token: string | undefined = 'saved-native-token'

    const secretStore: SessionSecretStore = {
      persistent: true,
      get: () => token,
      set: (_name, value) => { token = value },
      delete: () => { token = undefined },
      revoke: () => { token = undefined },
      clear: () => undefined
    }

    const store = createCompanionStore({ gatewayFactory: createFakeGateway, secretStore, storage: { getItem: () => null, setItem: () => undefined } })
    const { unmount } = render(<App store={store} />)
    fireEvent.click(screen.getByRole('button', { name: /forget saved token/i }))
    await waitFor(() => expect(token).toBeUndefined())
    unmount()

    render(<App store={createCompanionStore({ gatewayFactory: createFakeGateway, storage: { getItem: () => null, setItem: () => undefined } })} />)
    expect(screen.getByText(/browser keeps the token for this session only/i)).toBeTruthy()
  })

  it('offers a working reset when encrypted token storage cannot be read', async () => {
    const secretStore: SessionSecretStore = {
      persistent: true,
      get: () => { throw new Error('corrupt ciphertext') },
      set: () => undefined,
      delete: vi.fn(),
      revoke: vi.fn(),
      clear: () => undefined
    }

    const store = createCompanionStore({ gatewayFactory: createFakeGateway, secretStore, storage: { getItem: () => null, setItem: () => undefined } })

    render(<App store={store} />)

    fireEvent.click(screen.getByRole('button', { name: /forget saved token/i }))
    await waitFor(() => expect(secretStore.delete).toHaveBeenCalledWith('gateway-token'))
    expect(store.getSnapshot()).toMatchObject({ canForgetSavedToken: false, error: null })
  })

  it('keeps owner credential reset reachable after the socket disconnects', async () => {
    const original = window.hermesCompanion

    const ownerAuth: OwnerAuthBridge = {
      ownerSignIn: vi.fn(),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(async () => undefined),
      ownerWebSocketUrl: vi.fn()
    }

    window.hermesCompanion = {
      gatewayToken: { get: vi.fn(), set: vi.fn(), reset: vi.fn() },
      ...ownerAuth
    }
    const store = createCompanionStore({ gatewayFactory: createFakeGateway, ownerAuthBridge: ownerAuth, storage: { getItem: () => null, setItem: () => undefined } })
    await store.configure({ baseUrl: 'http://fixture.invalid', token: 'test-token' })
    await store.signOutOwner()

    render(<App store={store} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear saved owner sign-in' }))

    await waitFor(() => expect(ownerAuth.ownerSignOut).toHaveBeenCalledTimes(2))

    if (original) {window.hermesCompanion = original} else {delete window.hermesCompanion}
  })

  it('renders the ready application shell and live roster', async () => {
    render(<App store={await readyStore()} />)
    expect(screen.getByRole('main')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Hermes Companion' })).toBeTruthy()
    expect(screen.getAllByText('Atlas').length).toBeGreaterThan(0)
    expect(document.querySelector('.activity-rail')).toBeNull()
    expect(document.querySelector('.app-shell')?.classList.contains('app-shell--two-column')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull()
  })

  it('renders quick task as a labelled stacked composer', async () => {
    render(<App store={await readyStore()} />)
    fireEvent.click(screen.getAllByRole('button', { name: /Atlas/ })[0])
    fireEvent.click(await screen.findByRole('button', { name: '← Back' }))
    const form = screen.getByRole('form', { name: 'Quick task' })
    expect(form.classList.contains('quick-task')).toBe(true)
    expect(screen.getByLabelText('Assign to').tagName).toBe('SELECT')
    expect(screen.getByLabelText('Task').tagName).toBe('TEXTAREA')
    expect(screen.getByRole('button', { name: 'Send task' })).toBeTruthy()
  })

  it('submits a mobile new conversation through durable companion creation', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390)
    const gateway = new FakeWorkGateway()
    const listCompanionSessions = gateway.listCompanionSessions.bind(gateway)
    const listCompanionProjects = gateway.listCompanionProjects.bind(gateway)

    const createCompanionSession = vi.fn(async (request: CreateCompanionSessionRequest) => ({
      ...request,
      operation_kind: 'create' as const,
      stored_session_id: 'stored-mobile-1',
      row_state: 'present' as const,
      operation_status: 'completed' as const,
      runtime_session_id: null
    }))

    Object.assign(gateway, {
      createCompanionSession,
      listCompanionSessions: async (options: { profile: string; limit?: number; cursor?: string }) => ({ ...(await listCompanionSessions(options)), backend_namespace: 'fixture-mac-mini' }),
      listCompanionProjects: async (options: { profile: string; limit?: number; cursor?: string }) => ({ ...(await listCompanionProjects(options)), backend_namespace: 'fixture-mac-mini' })
    })
    const { store } = await readyOwnerDirectoryStore(gateway)
    await vi.waitFor(() => expect(store.directory.getSnapshot().coverage.find((item) => item.profile === 'atlas')?.backendNamespace).toBe('fixture-mac-mini'))
    render(<App store={store} />)

    fireEvent.click(screen.getByRole('button', { name: 'Nowa rozmowa' }))
    expect((screen.getByLabelText('Profil rozmowy') as HTMLSelectElement).value).toBe('atlas')
    fireEvent.change(screen.getByLabelText('Pierwsza wiadomość'), { target: { value: 'Sprawdź mobilne wejście' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rozpocznij rozmowę' }))

    await waitFor(() => expect(createCompanionSession).toHaveBeenCalledOnce())
    expect(createCompanionSession).toHaveBeenCalledWith(expect.objectContaining({
      version: 1,
      backend_namespace: 'fixture-mac-mini',
      profile: 'atlas',
      project_id: null,
      text: 'Sprawdź mobilne wejście'
    }))
  })

  it('marks active navigation and focuses the newly selected screen context', async () => {
    render(<App store={await readyStore()} />)
    fireEvent.click(screen.getAllByRole('button', { name: /Atlas/ })[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Open conversation' }))
    await waitFor(() => expect(screen.getByRole('main')).toBe(document.activeElement))
    expect(screen.getByRole('main').getAttribute('aria-label')).toBe('Conversation')
    expect(screen.getByRole('main').classList.contains('main-content--conversation')).toBe(true)
    expect(document.querySelector('.desktop-topbar')).toBeNull()
    expect(screen.queryByRole('button', { name: /Conversation|Chat/ })).toBeNull()
  })

  it('uses Rozmowy, Decyzje, and Pliki navigation while retaining compatible URLs', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(760)
    const scrollWindow = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    const focusMain = vi.spyOn(HTMLElement.prototype, 'focus')
    render(<App store={await readyDirectoryStore()} />)
    const chatsButtons = screen.getAllByRole('button', { name: 'Rozmowy' })
    expect(screen.getAllByRole('button', { name: /^Decyzje/ })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Pliki' })).toHaveLength(2)
    expect(screen.getByRole('main').getAttribute('aria-label')).toBe('Rozmowy')
    expect(chatsButtons[0].getAttribute('aria-current')).toBe('page')
    scrollWindow.mockClear()

    fireEvent.click(screen.getAllByRole('button', { name: /^Decyzje/ })[0])
    await waitFor(() => expect(screen.getByRole('main')).toBe(document.activeElement))
    expect(scrollWindow).toHaveBeenCalledWith({ top: 0 })
    expect(focusMain).toHaveBeenCalledWith({ preventScroll: true })
    expect(window.location.search).toBe('?view=needs')
    expect(screen.getByRole('main').getAttribute('aria-label')).toBe('Decyzje')

    fireEvent.click(screen.getAllByRole('button', { name: 'Rozmowy' })[0])
    expect(window.location.search).toBe('?view=work')
    expect(screen.queryByRole('button', { name: /Conversation|Chat/ })).toBeNull()
  })

  it('restores a direct read-only session history URL without activating chat', async () => {
    window.history.replaceState({}, '', '/?view=work&section=sessions&focus=synthetic-session-1&focusProfile=atlas&focusSource=fixture-mac-mini&tab=history')
    const store = await readyDirectoryStore()
    const setBrowseQuery = vi.spyOn(store.directory, 'setBrowseQuery')
    render(<App store={store} />)

    expect(await screen.findByText('[SYNTHETIC QA] Desktop research session')).toBeTruthy()
    expect(setBrowseQuery).toHaveBeenCalledWith(expect.objectContaining({ archive: 'all' }))
    expect(screen.getByText('Synthetic request for read-only QA.')).toBeTruthy()
    expect(screen.getByText(/Atlas · \[SYNTHETIC QA\] Companion project/)).toBeTruthy()
    expect(screen.queryByLabelText('Message Atlas')).toBeNull()
  })

  it('returns from a catalog live chat to the exact Chats directory state', async () => {
    const expandedKey = JSON.stringify(['fixture-mac-mini', 'atlas', 'synthetic-project-1'])

    const params = new URLSearchParams({
      view: 'work', chat: 'synthetic-session-1', chatProfile: 'atlas', chatSource: 'fixture-mac-mini',
      chatQ: 'synthetic', chatView: 'projects', agent: 'atlas', chatExpanded: JSON.stringify([expandedKey]), chatScroll: '240'
    })

    window.history.replaceState({}, '', `/?${params}`)
    const { store } = await readyOwnerDirectoryStore()
    render(<App store={store} />)
    const main = screen.getByRole('main')

    expect(await screen.findByText('Synthetic request for read-only QA.')).toBeTruthy()
    main.scrollTop = 240
    fireEvent.change(screen.getByLabelText('Wiadomość do Atlas'), { target: { value: 'Continue safely' } })
    fireEvent.click(screen.getByRole('button', { name: 'Wyślij wiadomość' }))
    expect(await screen.findByRole('button', { name: 'Back to Atlas sessions' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Atlas sessions' }))

    expect((await screen.findByRole('searchbox', { name: 'Szukaj rozmów' }) as HTMLInputElement).value).toBe('synthetic')
    expect(screen.getByRole('button', { name: /Companion project/ }).getAttribute('aria-expanded')).toBe('true')
    expect(new URLSearchParams(window.location.search).get('chat')).toBeNull()
    await waitFor(() => expect(main.scrollTop).toBe(240))
  })

  it('forwards the Rozmowy chat query to the authoritative session search', async () => {
    window.history.replaceState({}, '', '/?view=work&chatQ=older%20session')
    const store = await readyDirectoryStore()
    const setBrowseQuery = vi.spyOn(store.directory, 'setBrowseQuery')

    render(<App store={store} />)

    await waitFor(() => expect(setBrowseQuery).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'older session', archive: 'all' })
    ))
  })

  it('reaches the full session archive from the normal Rozmowy search control', async () => {
    const store = await readyDirectoryStore()
    const setBrowseQuery = vi.spyOn(store.directory, 'setBrowseQuery')
    render(<App store={store} />)

    fireEvent.change(screen.getByRole('searchbox', { name: 'Szukaj rozmów' }), {
      target: { value: 'archived conversation' }
    })

    await waitFor(() => expect(setBrowseQuery).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'archived conversation', archive: 'all' })
    ))
    expect(new URLSearchParams(window.location.search).get('chatQ')).toBe('archived conversation')
  })

  it('restores topic filters and a source-bound topic deep link', async () => {
    window.history.replaceState({}, '', '/?view=work&section=topics&focus=topic-1&focusProfile=atlas&focusSource=organization-db&q=launch&collection=operations&lifecycle=active&verified=true&sort=name')
    const store = await readyDirectoryStore()
    const setBrowseQuery = vi.spyOn(store.directory, 'setBrowseQuery')
    const openTopic = vi.spyOn(store.directory, 'openTopic')
    render(<App store={store} />)

    await waitFor(() => expect(openTopic).toHaveBeenCalledWith('atlas', 'topic-1', 'organization-db'))
    expect(setBrowseQuery).toHaveBeenCalledWith({
      search: 'launch',
      archive: 'current',
      sources: [],
      origins: [],
      collections: ['operations'],
      lifecycles: ['active'],
      verified: true,
      topicSort: 'name'
    })
  })

  it.each([
    ['project', 'projects', 'synthetic-project-1', 'fixture-mac-mini', '[SYNTHETIC QA] Companion project', 'Read-only source detail'],
    ['topic', 'topics', 'synthetic-topic-1', 'fixture-organization-db', '[SYNTHETIC QA] Companion launch', 'Read-only organization detail']
  ])('renders the legacy Work %s deep-link target instead of the Chats directory', async (_kind, section, focus, source, title, note) => {
    window.history.replaceState({}, '', `/?view=work&section=${section}&focus=${focus}&focusProfile=atlas&focusSource=${source}&tab=overview`)
    const store = await readyDirectoryStore()

    render(<App store={store} />)

    expect(await screen.findByRole('heading', { name: title })).toBeTruthy()
    expect(screen.getByText(note)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Rozmowy' })).toBeNull()
  })

  it('retries a cold-start directory deep link after the gateway attaches', async () => {
    window.history.replaceState({}, '', '/?view=work&section=sessions&focus=synthetic-session-1&focusProfile=atlas&focusSource=fixture-mac-mini&tab=history')
    const store = createCompanionStore({ gatewayFactory: createFakeWorkGateway, storage: { getItem: () => null, setItem: () => undefined } })
    const openSession = vi.spyOn(store.directory, 'openSession')
    render(<App store={store} />)

    expect(openSession).not.toHaveBeenCalled()
    await store.configure({ baseUrl: 'http://fixture.invalid', token: 'test-token' })

    expect(await screen.findByText('[SYNTHETIC QA] Desktop research session')).toBeTruthy()
    expect(openSession).toHaveBeenCalledOnce()
  })

  it('restores the same directory deep link again after reconnect', async () => {
    window.history.replaceState({}, '', '/?view=work&section=sessions&focus=synthetic-session-1&focusProfile=atlas&focusSource=fixture-mac-mini&tab=history')
    const gateways: FakeWorkGateway[] = []

    const store = createCompanionStore({ gatewayFactory: () => {
      const gateway = new FakeWorkGateway()

      gateways.push(gateway)

      return gateway
    }, storage: { getItem: () => null, setItem: () => undefined } })

    const openSession = vi.spyOn(store.directory, 'openSession')
    render(<App store={store} />)
    await store.configure({ baseUrl: 'http://fixture.invalid', token: 'test-token' })
    await waitFor(() => expect(openSession).toHaveBeenCalledTimes(1))

    gateways[0].close()
    await waitFor(() => expect(store.getSnapshot().phase).toBe('disconnected'))
    await store.recover()

    await waitFor(() => expect(openSession).toHaveBeenCalledTimes(2))
    expect(store.directory.getSnapshot().history?.session_id).toBe('synthetic-session-1')
  })

  it.each([
    ['project', 'libraryProject', 'synthetic-project-1', { projects: [{ id: 'synthetic-project-1', title: '[SYNTHETIC QA] Companion project', backend_namespace: 'fixture-mac-mini', profile: 'atlas' }], topics: [], sessions: [] }],
    ['topic', 'libraryTopic', 'synthetic-topic-1', { projects: [], topics: [{ id: 'synthetic-topic-1', title: '[SYNTHETIC QA] Companion launch', backend_namespace: 'fixture-organization-db', profile: 'atlas' }], sessions: [] }],
    ['session', 'librarySession', 'synthetic-session-1', { projects: [], topics: [], sessions: [{ id: 'synthetic-session-1', title: '[SYNTHETIC QA] Desktop research session', backend_namespace: 'fixture-mac-mini', profile: 'atlas', relationship: 'primary' }] }]
  ])('restores a validated %s relationship when Library is opened by direct URL', async (_kind, routeKey, relationId, relationships) => {
    window.history.replaceState({}, '', `/?view=library&libraryProfile=atlas&${routeKey}=${relationId}&libraryArtifact=${libraryArtifactId}`)
    const gateway = new FakeWorkGateway()
    const pin = vi.spyOn(gateway, 'pinReviewedLibraryArtifact')
    const store = createCompanionStore({ gatewayFactory: () => gateway, storage: { getItem: () => null, setItem: () => undefined } })
    await store.configure({ baseUrl: 'http://fixture.invalid', token: 'test-token' })
    render(<App store={store} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Load safe preview' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Mark previewed version reviewed' }))

    await waitFor(() => expect(pin).toHaveBeenCalledWith(expect.objectContaining({ relationships })))
  })

  it('fails closed when a direct Library relationship cannot be validated', async () => {
    window.history.replaceState({}, '', `/?view=library&libraryProfile=atlas&libraryProject=missing-project&libraryArtifact=${libraryArtifactId}`)
    const gateway = new FakeWorkGateway()
    const pin = vi.spyOn(gateway, 'pinReviewedLibraryArtifact')
    const store = createCompanionStore({ gatewayFactory: () => gateway, storage: { getItem: () => null, setItem: () => undefined } })
    await store.configure({ baseUrl: 'http://fixture.invalid', token: 'test-token' })
    render(<App store={store} />)

    expect((await screen.findByRole('alert')).textContent).toMatch(/relationship.*could not be verified/i)
    fireEvent.click(await screen.findByRole('button', { name: 'Load safe preview' }))
    expect((await screen.findByRole('button', { name: 'Mark previewed version reviewed' })).hasAttribute('disabled')).toBe(true)
    expect(pin).not.toHaveBeenCalled()
  })

  it('creates a selected teammate session and operates the fixture conversation', async () => {
    render(<App store={await readyStore()} />)
    fireEvent.click(screen.getAllByRole('button', { name: /Atlas/ })[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Open conversation' }))
    const input = await screen.findByLabelText('Message Atlas')
    fireEvent.change(input, { target: { value: 'Check this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(screen.getAllByText(/I received: “Check this”/).length).toBeGreaterThan(0))
  })

  it('opens persisted history without resume and continues it once from Rozmowy', async () => {
    const { store, gateway } = await readyOwnerDirectoryStore()
    const history = vi.spyOn(gateway, 'getCompanionSessionHistory')
    const resume = vi.spyOn(gateway, 'resumeSession')
    const continuation = vi.spyOn(gateway, 'continueCompanionSession')
    render(<App store={store} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Ostatnie' }))
    fireEvent.click(await screen.findByRole('button', { name: /Desktop research session/ }))
    expect(await screen.findByText('Synthetic request for read-only QA.')).toBeTruthy()
    expect(history).toHaveBeenCalledWith('atlas', 'synthetic-session-1', undefined, 'fixture-mac-mini')
    expect(resume).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Wiadomość do Atlas'), { target: { value: 'Kontynuuj dokładnie tutaj' } })
    fireEvent.click(screen.getByRole('button', { name: 'Wyślij wiadomość' }))

    await waitFor(() => expect(screen.getByRole('main').getAttribute('aria-label')).toBe('Conversation'))
    expect(continuation).toHaveBeenCalledOnce()
    expect(continuation).toHaveBeenCalledWith(expect.objectContaining({
      backend_namespace: 'fixture-mac-mini', profile: 'atlas', stored_session_id: 'synthetic-session-1', text: 'Kontynuuj dokładnie tutaj'
    }))
    expect(screen.getByText('Synthetic request for read-only QA.')).toBeTruthy()
  })

  it('keeps a failed saved-session send in Rozmowy with sanitized retry feedback', async () => {
    const { store, gateway } = await readyOwnerDirectoryStore()
    const continuation = vi.spyOn(gateway, 'continueCompanionSession').mockRejectedValueOnce(new Error('gateway rejected API_KEY=synthetic-secret cookie=synthetic-cookie token=synthetic-token'))
    render(<App store={store} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Ostatnie' }))
    fireEvent.click(await screen.findByRole('button', { name: /Desktop research session/ }))
    fireEvent.change(screen.getByLabelText('Wiadomość do Atlas'), { target: { value: '  preserve this  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Wyślij wiadomość' }))

    await waitFor(() => expect(continuation).toHaveBeenCalledOnce())
    expect(await screen.findByText('Nie udało się wysłać wiadomości. Treść pozostała w polu — spróbuj ponownie.')).toBeTruthy()
    expect(screen.getByRole('main').getAttribute('aria-label')).toBe('Rozmowy')
    expect(continuation).toHaveBeenCalledWith(expect.objectContaining({ text: 'preserve this' }))
    expect((screen.getByLabelText('Wiadomość do Atlas') as HTMLTextAreaElement).value).toBe('  preserve this  ')
    expect(JSON.stringify(store.getSnapshot())).not.toContain('synthetic-secret')
    expect(document.body.textContent).not.toContain('synthetic-secret')
    expect(document.body.textContent).not.toContain('synthetic-cookie')
    expect(document.body.textContent).not.toContain('synthetic-token')
  })

  it('absorbs an expected persisted-continuation rejection from the active composer', async () => {
    const { store, gateway } = await readyOwnerDirectoryStore()
    const continuation = vi.spyOn(gateway, 'continueCompanionSession')
    render(<App store={store} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Ostatnie' }))
    fireEvent.click(await screen.findByRole('button', { name: /Desktop research session/ }))
    fireEvent.change(screen.getByLabelText('Wiadomość do Atlas'), { target: { value: 'Pierwsza wiadomość' } })
    fireEvent.click(screen.getByRole('button', { name: 'Wyślij wiadomość' }))
    await waitFor(() => expect(screen.getByRole('main').getAttribute('aria-label')).toBe('Conversation'))
    await waitFor(() => expect(continuation).toHaveBeenCalledOnce())

    continuation.mockRejectedValueOnce(new Error('secret continuation detail'))
    fireEvent.change(screen.getByLabelText('Message Atlas'), { target: { value: 'Nie wysyłaj ponownie' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not reach the gateway/i))
    expect(screen.getByRole('main').getAttribute('aria-label')).toBe('Conversation')
    expect(continuation).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).not.toContain('secret continuation detail')
  })

  it('preserves a saved-session draft through Back and reopening the same logical session', async () => {
    const { store } = await readyOwnerDirectoryStore()
    render(<App store={store} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Ostatnie' }))
    fireEvent.click(await screen.findByRole('button', { name: /Desktop research session/ }))
    const composer = await screen.findByLabelText('Wiadomość do Atlas')
    fireEvent.change(composer, { target: { value: 'Nie wysyłaj jeszcze' } })
    fireEvent.click(screen.getByRole('button', { name: 'Wróć do rozmów' }))
    fireEvent.click(await screen.findByRole('button', { name: /Desktop research session/ }))

    expect((await screen.findByLabelText('Wiadomość do Atlas') as HTMLTextAreaElement).value).toBe('Nie wysyłaj jeszcze')
  })
})
