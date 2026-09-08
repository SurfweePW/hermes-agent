import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App, libraryAssetParams } from './app'
import { createFakeGateway } from './fixtures/fake-gateway'
import { createFakeWorkGateway, FakeWorkGateway } from './fixtures/fake-work-gateway'
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

const libraryArtifactId = `art_${'a'.repeat(64)}`

describe('App', () => {
  it('opens a work asset by filename while retaining its full Library reference', () => {
    const params = libraryAssetParams('hoffeecmo', 'data/cmo/recommendations/a6-report.md')

    expect(Object.fromEntries(params)).toEqual({
      view: 'library',
      libraryProfile: 'hoffeecmo',
      libraryQ: 'a6-report.md',
      libraryOpen: 'data/cmo/recommendations/a6-report.md'
    })
  })

  beforeEach(() => window.history.replaceState({}, '', '/'))
  afterEach(() => {vi.useRealTimers(); vi.restoreAllMocks()})
  it('keeps durable work in Needs Me, shows the old-server boundary and preserves runtime attention', async () => {
    const store = await readyStore()
    render(<App store={store} />)
    fireEvent.click(screen.getAllByRole('button', { name: /^!Needs Me|Needs Me/ })[0])
    expect(screen.getByRole('heading', { name: 'Decision inbox' })).toBeTruthy()
    expect(screen.getByText(/does not support the durable work inbox/)).toBeTruthy()
    expect(screen.getByText('Runtime-local attention')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Kanban' })).toBeNull()
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
    const navigation = screen.getAllByRole('button', { name: 'Work' })[0]
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
      ownerSignIn: vi.fn(async () => ({ ignored: 'native-owner-secret' })),
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

  it('keeps primary navigation locked while Work URLs and filter focus stay stable', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(760)
    const scrollWindow = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    const focusMain = vi.spyOn(HTMLElement.prototype, 'focus')
    render(<App store={await readyDirectoryStore()} />)
    const workButtons = screen.getAllByRole('button', { name: 'Work' })
    scrollWindow.mockClear()
    fireEvent.click(workButtons[0])
    await waitFor(() => expect(screen.getByRole('main')).toBe(document.activeElement))
    expect(scrollWindow).toHaveBeenCalledWith({ top: 0 })
    expect(focusMain).toHaveBeenCalledWith({ preventScroll: true })
    expect(workButtons[0].getAttribute('aria-current')).toBe('page')
    expect(window.location.search).toBe('?view=work')
    expect(screen.queryByRole('button', { name: /Conversation|Chat/ })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }))
    const searchInput = screen.getByLabelText('Search titles')
    searchInput.focus()
    fireEvent.change(searchInput, { target: { value: 'Companion' } })
    expect(document.activeElement).toBe(searchInput)
    expect(new URLSearchParams(window.location.search).get('q')).toBe('Companion')
    expect(screen.getByRole('button', { name: /Companion project/ })).toBeTruthy()
  })

  it('restores a direct read-only session history URL without activating chat', async () => {
    window.history.replaceState({}, '', '/?view=work&section=sessions&focus=synthetic-session-1&focusProfile=atlas&focusSource=fixture-mac-mini&tab=history')
    const store = await readyDirectoryStore()
    const setBrowseQuery = vi.spyOn(store.directory, 'setBrowseQuery')
    render(<App store={store} />)

    expect(await screen.findByRole('heading', { name: '[SYNTHETIC QA] Desktop research session' })).toBeTruthy()
    expect(setBrowseQuery).toHaveBeenCalledWith(expect.objectContaining({ archive: 'all' }))
    expect(screen.getByText('Synthetic request for read-only QA.')).toBeTruthy()
    expect(screen.getByText(/Viewing history does not resume or activate this session/)).toBeTruthy()
    expect(screen.queryByLabelText('Message Atlas')).toBeNull()
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

  it('retries a cold-start directory deep link after the gateway attaches', async () => {
    window.history.replaceState({}, '', '/?view=work&section=sessions&focus=synthetic-session-1&focusProfile=atlas&focusSource=fixture-mac-mini&tab=history')
    const store = createCompanionStore({ gatewayFactory: createFakeWorkGateway, storage: { getItem: () => null, setItem: () => undefined } })
    const openSession = vi.spyOn(store.directory, 'openSession')
    render(<App store={store} />)

    expect(openSession).not.toHaveBeenCalled()
    await store.configure({ baseUrl: 'http://fixture.invalid', token: 'test-token' })

    expect(await screen.findByRole('heading', { name: '[SYNTHETIC QA] Desktop research session' })).toBeTruthy()
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
})
