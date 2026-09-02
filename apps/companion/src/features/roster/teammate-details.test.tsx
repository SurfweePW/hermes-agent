import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TeammateDetails } from './teammate-details'

const teammate = { id: 'atlas', initials: 'A', name: 'Atlas', role: 'Chief of Staff', status: 'idle' as const, summary: 'Ready.' }

describe('TeammateDetails', () => {
  it('renders bounded semantic session rows with separate pin and resume actions', () => {
    const onPin = vi.fn()
    const onResume = vi.fn()
    const title = 'A very long session title that must remain bounded without turning the entire row into one nested control'
    render(<TeammateDetails onBotChat={() => undefined} onMessage={() => undefined} onPin={onPin} onResume={onResume} sessions={[{ id: 'stored-1', resolved_id: 'resolved-1', title, preview: 'A long preview '.repeat(30), started_at: 1, last_active: 1, message_count: 2, source: 'companion', pinned: false }]} sessionsLoading={false} teammate={teammate} />)

    const row = screen.getByRole('article', { name: title })
    expect(row.classList.contains('session-row')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onResume).toHaveBeenCalledWith('resolved-1')
    fireEvent.click(screen.getByRole('button', { name: `Pin ${title}` }))
    expect(onPin).toHaveBeenCalledWith('stored-1', true)
  })

  it('renders malformed gateway timestamps without crashing', () => {
    render(<TeammateDetails onBotChat={() => undefined} onMessage={() => undefined} onPin={() => undefined} onResume={() => undefined} sessions={[{ id: 'bad-time', title: 'Recovered session', preview: 'Still readable', started_at: 1, last_active: 1e20, message_count: 2, source: 'companion', pinned: false }]} sessionsLoading={false} teammate={teammate} />)

    const time = screen.getByText('Last activity unknown')
    expect(time.getAttribute('datetime')).toBeNull()
  })
})