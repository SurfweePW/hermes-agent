import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { App } from './app'
import { createFakeGateway } from './fixtures/fake-gateway'
import type { OwnerAuthBridge } from './security/owner-auth'
import type { SessionSecretStore } from './security/secret-store'
import { createCompanionStore } from './state/companion-store'

async function readyStore() {
  const store = createCompanionStore({ gatewayFactory: createFakeGateway, storage: { getItem: () => null, setItem: () => undefined } })
  await store.configure({ baseUrl: 'http://fixture.invalid', token: 'test-token' })

  return store
}

describe('App', () => {
  it('keeps durable work in Needs Me, shows the old-server boundary and preserves runtime attention', async () => {
    const store = await readyStore()
    render(<App store={store} />)
    fireEvent.click(screen.getAllByRole('button', { name: /^!Needs Me|Needs Me/ })[0])
    expect(screen.getByRole('heading', { name: 'Decision inbox' })).toBeTruthy()
    expect(screen.getByText(/does not support the durable work inbox/)).toBeTruthy()
    expect(screen.getByText('Runtime-local attention')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Kanban' })).toBeNull()
  })

  it('refreshes server work on visibility and online events', async () => {
    const store = await readyStore()
    const refresh = vi.spyOn(store.work, 'refresh')
    render(<App store={store} />)
    fireEvent(document, new Event('visibilitychange'))
    fireEvent(window, new Event('online'))
    expect(refresh).toHaveBeenCalledTimes(2)
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
    const form = screen.getByRole('form', { name: 'Quick task' })
    expect(form.classList.contains('quick-task')).toBe(true)
    expect(screen.getByLabelText('Assign to').tagName).toBe('SELECT')
    expect(screen.getByLabelText('Task').tagName).toBe('TEXTAREA')
    expect(screen.getByRole('button', { name: 'Send task' })).toBeTruthy()
  })

  it('marks active navigation and focuses the newly selected screen context', async () => {
    render(<App store={await readyStore()} />)
    const conversationButtons = screen.getAllByRole('button', { name: /Conversation|Chat/ })
    fireEvent.click(conversationButtons[0])
    await waitFor(() => expect(screen.getByRole('main')).toBe(document.activeElement))
    expect(screen.getByRole('main').getAttribute('aria-label')).toBe('Conversation')
    expect(screen.getByRole('main').classList.contains('main-content--conversation')).toBe(true)
    expect(document.querySelector('.desktop-topbar')).toBeNull()
    expect(conversationButtons[0].getAttribute('aria-current')).toBe('page')
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
