import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { PendingApproval } from '../../state/companion-store'

import { Conversation } from './conversation'

const teammate = { id: 'atlas', initials: 'A', name: 'Atlas', role: 'Chief of Staff', status: 'working' as const, summary: 'Working.' }

const baseProps = {
  teammate,
  messages: [],
  streamingText: '',
  turnStatus: 'idle' as const,
  approval: null,
  draft: '',
  connected: true,
  onDraftChange: () => undefined,
  onSubmit: () => undefined,
  onInterrupt: () => undefined,
  onApproval: () => undefined
}

describe('Conversation', () => {
  it('announces real streaming text in a semantic live region', () => {
    render(<Conversation {...baseProps} streamingText="Checking the final sources" turnStatus="streaming" />)
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toContain('Atlas is working')
    expect(screen.getByText('Checking the final sources')).toBeTruthy()
  })

  it('renders finalized messages and controls the draft through typed callbacks', () => {
    const onDraftChange = vi.fn()
    const onSubmit = vi.fn()
    render(<Conversation {...baseProps} draft="new work" messages={[{ id: 'm1', role: 'assistant', text: 'Loaded history.' }]} onDraftChange={onDraftChange} onSubmit={onSubmit} />)
    expect(screen.getByText('Loaded history.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Message Atlas'), { target: { value: 'updated' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Send message' }).closest('form')!)
    expect(onDraftChange).toHaveBeenCalledWith('updated')
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('shows uncertainty without claiming a server-side failure', () => {
    render(<Conversation {...baseProps} connected={false} turnStatus="uncertain" />)
    expect(screen.getByRole('status').textContent).toContain('server-side outcome is not yet known')
  })

  it('shows the current approval request', () => {
    const approval: PendingApproval = { requestId: 'r1', sessionId: 's1', title: 'Publish?', description: 'Review.', choices: ['once'], responding: false }
    render(<Conversation {...baseProps} approval={approval} />)
    expect(screen.getByRole('heading', { name: 'Publish?' })).toBeTruthy()
  })
})
