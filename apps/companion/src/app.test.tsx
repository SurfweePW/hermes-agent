import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { App } from './app'

describe('App', () => {
  it('renders the Hermes Companion application shell', () => {
    render(<App />)

    expect(screen.getByRole('main')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Hermes Companion' })).toBeTruthy()
  })

  it('marks active navigation and focuses the newly selected screen context', async () => {
    render(<App />)

    const conversationButtons = screen.getAllByRole('button', { name: /Conversation|Chat/ })
    expect(screen.getAllByRole('button', { name: 'Teammates' })[0].getAttribute('aria-current')).toBe('page')

    fireEvent.click(conversationButtons[0])

    await waitFor(() => expect(screen.getByRole('main')).toBe(document.activeElement))
    expect(screen.getByRole('main').getAttribute('aria-label')).toBe('Conversation')
    expect(conversationButtons[0].getAttribute('aria-current')).toBe('page')
    expect(screen.getAllByRole('button', { name: 'Teammates' })[0].hasAttribute('aria-current')).toBe(false)
  })

  it('renders profile avatars as labelled non-interactive content', () => {
    render(<App />)

    expect(screen.queryByRole('button', { name: 'Open profile' })).toBeNull()
    expect(screen.getAllByLabelText('Profile: Atlas Weber')).toHaveLength(2)
  })
})
