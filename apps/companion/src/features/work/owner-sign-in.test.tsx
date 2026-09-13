import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OwnerSignIn } from './owner-sign-in'

const original = window.hermesCompanion
afterEach(() => { if (original) {window.hermesCompanion = original} else {delete window.hermesCompanion} })
describe('native owner sign-in entry', () => {
  it('never replaces unavailable native owner auth with a shared-token approval', () => {
    delete window.hermesCompanion
    render(<OwnerSignIn baseUrl="https://example.org" onOwnerConnect={vi.fn()} onOwnerSignOut={vi.fn()} ownerConnected={false} />)
    expect(screen.queryByRole('button', { name: 'Zaloguj się, aby podejmować decyzje' })).toBeNull()
    expect(screen.getByText(/obejście zatwierdzania za pomocą tokenu nie jest dostępne/)).toBeTruthy()
  })
  it('passes only baseUrl, ignores native return data, and rechecks connection', async () => {
    const ownerSignIn = vi.fn(async () => ({ opaque: 'not rendered' }))
    window.hermesCompanion = {
      gatewayToken: { get: vi.fn(), set: vi.fn(), reset: vi.fn() },
      ownerSignIn,
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn()
    }
    const connectOwner = vi.fn(async () => undefined)
    render(<OwnerSignIn baseUrl="https://example.org" onOwnerConnect={connectOwner} onOwnerSignOut={vi.fn()} ownerConnected={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Zaloguj się, aby podejmować decyzje' }))
    await waitFor(() => expect(connectOwner).toHaveBeenCalledTimes(1))
    expect(ownerSignIn).toHaveBeenCalledWith({ baseUrl: 'https://example.org' })
    expect(screen.getByText(/odświeżona funkcja serwera/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('not rendered')
  })
  it('keeps native errors and secrets out of renderer messages', async () => {
    window.hermesCompanion = {
      gatewayToken: { get: vi.fn(), set: vi.fn(), reset: vi.fn() },
      ownerSignIn: vi.fn(async () => {throw new Error('secret-ticket')}),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn()
    }
    const connectOwner = vi.fn()
    render(<OwnerSignIn baseUrl="https://example.org" onOwnerConnect={connectOwner} onOwnerSignOut={vi.fn()} ownerConnected={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Zaloguj się, aby podejmować decyzje' }))
    await screen.findByText(/Nie udało się zweryfikować logowania właściciela ani ponownego połączenia/)
    expect(connectOwner).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('secret-ticket')
  })

  it('does not report success when the owner socket connection fails', async () => {
    window.hermesCompanion = {
      gatewayToken: { get: vi.fn(), set: vi.fn(), reset: vi.fn() },
      ownerSignIn: vi.fn(async () => ({ signedIn: true })),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn()
    }
    const connectOwner = vi.fn(async () => {throw new Error('one-use-ticket-secret')})
    render(<OwnerSignIn baseUrl="https://example.org" onOwnerConnect={connectOwner} onOwnerSignOut={vi.fn()} ownerConnected={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Zaloguj się, aby podejmować decyzje' }))

    await screen.findByText(/Nie udało się zweryfikować logowania właściciela ani ponownego połączenia/)
    expect(screen.queryByText(/odświeżona funkcja serwera/)).toBeNull()
    expect(document.body.textContent).not.toContain('one-use-ticket-secret')
  })

  it('renders sign-out for a live owner connection', async () => {
    const ownerSignOut = vi.fn()
    window.hermesCompanion = {
      gatewayToken: { get: vi.fn(), set: vi.fn(), reset: vi.fn() },
      ownerSignIn: vi.fn(),
      ownerStatus: vi.fn(),
      ownerSignOut,
      ownerWebSocketUrl: vi.fn()
    }
    const signOut = vi.fn(async () => undefined)
    render(<OwnerSignIn baseUrl="https://example.org" onOwnerConnect={vi.fn()} onOwnerSignOut={signOut} ownerConnected />)

    fireEvent.click(screen.getByRole('button', { name: 'Wyloguj z dostępu do decyzji' }))
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
    expect(ownerSignOut).not.toHaveBeenCalled()
  })

  it('keeps credential reset available without a live owner socket', async () => {
    window.hermesCompanion = {
      gatewayToken: { get: vi.fn(), set: vi.fn(), reset: vi.fn() },
      ownerSignIn: vi.fn(),
      ownerStatus: vi.fn(),
      ownerSignOut: vi.fn(),
      ownerWebSocketUrl: vi.fn()
    }
    const signOut = vi.fn(async () => undefined)
    render(<OwnerSignIn baseUrl="https://example.org" onOwnerConnect={vi.fn()} onOwnerSignOut={signOut} ownerConnected={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Usuń zapisane logowanie właściciela' }))

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
    expect(screen.getByText(/Zapisane dane uwierzytelniające właściciela do decyzji zostały usunięte/)).toBeTruthy()
  })
  it('renders Polish owner sign-in chrome', () => {
    window.hermesCompanion = {
      gatewayToken: { get: vi.fn(), set: vi.fn(), reset: vi.fn() },
      ownerSignIn: vi.fn(), ownerStatus: vi.fn(), ownerSignOut: vi.fn(), ownerWebSocketUrl: vi.fn()
    }
    render(<OwnerSignIn baseUrl="https://example.org" onOwnerConnect={vi.fn()} onOwnerSignOut={vi.fn()} ownerConnected={false} />)
    expect(screen.getByRole('region', { name: 'Dostęp właściciela do decyzji' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Zaloguj się, aby podejmować decyzje' })).toBeTruthy()
  })
})
