import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { App } from './app'
import { createFakeGateway } from './fixtures/fake-gateway'
import type { SessionSecretStore } from './security/secret-store'
import { createCompanionStore } from './state/companion-store'

async function readyStore() {
  const store = createCompanionStore({ gatewayFactory: createFakeGateway, storage: { getItem: () => null, setItem: () => undefined } })
  await store.configure({ baseUrl: 'http://fixture.invalid', token: 'test-token' })

  return store
}

describe('App', () => {
  it('renders first-run gateway setup without exposing a token as text', () => {
    const store = createCompanionStore({ gatewayFactory: createFakeGateway, storage: { getItem: () => null, setItem: () => undefined } })
    render(<App store={store} />)
    expect(screen.getByRole('heading', { name: 'Connect Hermes Companion' })).toBeTruthy()
    expect(screen.getByLabelText('Session token').getAttribute('type')).toBe('password')
    expect(document.body.textContent).not.toContain('test-token')
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

  it('labels browser credentials session-only and provides an explicit saved-token reset', () => {
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
    expect(token).toBeUndefined()
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
