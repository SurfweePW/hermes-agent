import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { App } from './app'
import { createFakeGateway } from './fixtures/fake-gateway'
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

  it('renders the ready application shell and live roster', async () => {
    render(<App store={await readyStore()} />)
    expect(screen.getByRole('main')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Hermes Companion' })).toBeTruthy()
    expect(screen.getAllByText('Atlas').length).toBeGreaterThan(0)
  })

  it('marks active navigation and focuses the newly selected screen context', async () => {
    render(<App store={await readyStore()} />)
    const conversationButtons = screen.getAllByRole('button', { name: /Conversation|Chat/ })
    fireEvent.click(conversationButtons[0])
    await waitFor(() => expect(screen.getByRole('main')).toBe(document.activeElement))
    expect(screen.getByRole('main').getAttribute('aria-label')).toBe('Conversation')
    expect(conversationButtons[0].getAttribute('aria-current')).toBe('page')
  })

  it('creates a selected teammate session and operates the fixture conversation', async () => {
    render(<App store={await readyStore()} />)
    fireEvent.click(screen.getAllByRole('button', { name: /Atlas/ })[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Message Atlas' }))
    const input = await screen.findByLabelText('Message Atlas')
    fireEvent.change(input, { target: { value: 'Check this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(screen.getAllByText(/I received: “Check this”/).length).toBeGreaterThan(0))
  })
})
