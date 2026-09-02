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
  it('shows the active session and a direct route back to its session list', () => {
    const onBackToSessions = vi.fn()
    render(<Conversation {...baseProps} onBackToSessions={onBackToSessions} sessionTitle="Companion navigation polish" />)

    expect(screen.getByText('Companion navigation polish')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Atlas sessions' }))
    expect(onBackToSessions).toHaveBeenCalledOnce()
  })

  it('offers a jump to latest control after the reader scrolls away from the bottom', () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    render(<Conversation {...baseProps} messages={[{ id: 'm1', role: 'assistant', text: 'Older work' }]} />)
    const messageList = document.querySelector('.message-list') as HTMLDivElement
    Object.defineProperties(messageList, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: { configurable: true, value: 200, writable: true }
    })

    fireEvent.scroll(messageList)
    const jump = screen.getByRole('button', { name: '↓ Latest' })
    fireEvent.click(jump)
    expect(scrollIntoView).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '↓ Latest' })).toBeNull()
  })

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

  it('sends on Enter and leaves Shift+Enter for a newline', () => {
    const onSubmit = vi.fn()
    render(<Conversation {...baseProps} draft="ready" onSubmit={onSubmit} />)
    const composer = screen.getByLabelText('Message Atlas')

    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('does not submit while an IME composition is being confirmed', () => {
    const onSubmit = vi.fn()
    render(<Conversation {...baseProps} draft="未完" onSubmit={onSubmit} />)

    fireEvent.keyDown(screen.getByLabelText('Message Atlas'), { key: 'Enter', isComposing: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not submit by keyboard while working or disconnected', () => {
    const onSubmit = vi.fn()
    const { rerender } = render(<Conversation {...baseProps} draft="ready" onSubmit={onSubmit} turnStatus="streaming" />)
    fireEvent.keyDown(screen.getByLabelText('Message Atlas'), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(true)

    rerender(<Conversation {...baseProps} connected={false} draft="ready" onSubmit={onSubmit} />)
    fireEvent.keyDown(screen.getByLabelText('Message Atlas'), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('presents compaction payloads as system disclosures even when history labels them as user messages', () => {
    render(<Conversation {...baseProps} messages={[{ id: 'compact', role: 'user', text: '[CONTEXT COMPACTION — REFERENCE ONLY]\n## Historical Task Snapshot\nInternal details\n--- END OF CONTEXT SUMMARY — respond to the message below ---' }]} />)

    const disclosure = screen.getByLabelText('Earlier context summary')
    expect(disclosure.closest('article')?.className).toContain('message--system')
    expect(disclosure.closest('article')?.className).not.toContain('message--mine')
    expect(screen.queryByText(/Historical Task Snapshot/)).toBeNull()
  })
})
