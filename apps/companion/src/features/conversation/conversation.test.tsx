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
  sessionKey: 'base-session',
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

  it.each([
    ['Launch plan', 'Atlas · Launch plan'],
    ['Bez projektu', 'Atlas · Bez projektu'],
    ['Projekt nieznany', 'Atlas · Projekt nieznany']
  ])('uses the session title as the semantic heading with agent and %s metadata', (projectLabel, metadata) => {
    render(<Conversation {...baseProps} projectLabel={projectLabel} sessionTitle="Named logical session" />)
    expect(screen.getByRole('heading', { name: 'Named logical session' })).toBeTruthy()
    expect(screen.getByText(metadata)).toBeTruthy()
  })

  it('only follows streamed content while the reader remains near the bottom', () => {
    let scrollHeight = 1_200
    const { rerender } = render(<Conversation {...baseProps} messages={[{ id: 'm1', role: 'assistant', text: 'Older work' }]} sessionKey="stream-near" />)
    const messageList = document.querySelector('.message-list') as HTMLDivElement
    Object.defineProperties(messageList, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, value: 880, writable: true }
    })

    fireEvent.scroll(messageList)
    scrollHeight = 1_400
    rerender(<Conversation {...baseProps} messages={[{ id: 'm1', role: 'assistant', text: 'Older work' }]} sessionKey="stream-near" streamingText="A new streamed answer" turnStatus="streaming" />)

    expect(messageList.scrollTop).toBe(1_400)
    expect(screen.queryByRole('button', { name: '↓ New messages' })).toBeNull()
  })

  it('preserves an away reader and reveals the indicator only after a new event', () => {
    let scrollHeight = 1_200
    const { rerender } = render(<Conversation {...baseProps} messages={[{ id: 'm1', role: 'assistant', text: 'Older work' }]} sessionKey="stream-away" />)
    const messageList = document.querySelector('.message-list') as HTMLDivElement
    Object.defineProperties(messageList, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, value: 200, writable: true }
    })

    fireEvent.scroll(messageList)
    expect(screen.queryByRole('button', { name: '↓ New messages' })).toBeNull()
    scrollHeight = 1_400
    rerender(<Conversation {...baseProps} messages={[{ id: 'm1', role: 'assistant', text: 'Older work' }, { id: 'm2', role: 'assistant', text: 'New work' }]} sessionKey="stream-away" />)

    expect(messageList.scrollTop).toBe(200)
    const jump = screen.getByRole('button', { name: '↓ New messages' })
    fireEvent.click(jump)
    expect(messageList.scrollTop).toBe(1_400)
    expect(screen.queryByRole('button', { name: '↓ New messages' })).toBeNull()
  })

  it('restores independent read positions when logical sessions switch', () => {
    const { rerender } = render(<Conversation {...baseProps} messages={[{ id: 'a1', role: 'assistant', text: 'Session A' }]} sessionKey="position-a" />)
    const messageList = document.querySelector('.message-list') as HTMLDivElement
    Object.defineProperties(messageList, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: { configurable: true, value: 240, writable: true }
    })
    fireEvent.scroll(messageList)

    rerender(<Conversation {...baseProps} messages={[{ id: 'b1', role: 'assistant', text: 'Session B' }]} sessionKey="position-b" />)
    messageList.scrollTop = 510
    fireEvent.scroll(messageList)
    rerender(<Conversation {...baseProps} messages={[{ id: 'a1', role: 'assistant', text: 'Session A' }]} sessionKey="position-a" />)

    expect(messageList.scrollTop).toBe(240)
  })

  it('restores a logical session position after the conversation remounts', () => {
    const first = render(<Conversation {...baseProps} messages={[{ id: 'r1', role: 'assistant', text: 'Reconnect history' }]} sessionKey="position-reconnect" />)
    const originalList = document.querySelector('.message-list') as HTMLDivElement
    Object.defineProperties(originalList, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: { configurable: true, value: 360, writable: true }
    })
    fireEvent.scroll(originalList)
    first.unmount()

    render(<Conversation {...baseProps} messages={[{ id: 'r1', role: 'assistant', text: 'Reconnect history' }]} sessionKey="position-reconnect" />)
    const restoredList = document.querySelector('.message-list') as HTMLDivElement

    expect(restoredList.scrollTop).toBe(360)
  })

  it('keeps the visible anchor stable when older rows are prepended', () => {
    let scrollHeight = 1_200
    const { rerender } = render(<Conversation {...baseProps} messages={[{ id: 'm1', role: 'assistant', text: 'Visible anchor' }, { id: 'm2', role: 'assistant', text: 'Later' }]} sessionKey="prepend-anchor" />)
    const messageList = document.querySelector('.message-list') as HTMLDivElement
    Object.defineProperties(messageList, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, value: 200, writable: true }
    })
    fireEvent.scroll(messageList)

    scrollHeight = 1_450
    rerender(<Conversation {...baseProps} messages={[{ id: 'older', role: 'assistant', text: 'Older persisted row' }, { id: 'm1', role: 'assistant', text: 'Visible anchor' }, { id: 'm2', role: 'assistant', text: 'Later' }]} sessionKey="prepend-anchor" />)

    expect(messageList.scrollTop).toBe(450)
    expect(screen.queryByRole('button', { name: '↓ New messages' })).toBeNull()
  })

  it('announces real streaming text in a semantic live region', () => {
    render(<Conversation {...baseProps} streamingText="Checking the final sources" turnStatus="streaming" />)
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toContain('Atlas is working')
    expect(screen.getByText('Checking the final sources')).toBeTruthy()
  })

  it('distinguishes transport submission from agent work', () => {
    const { rerender } = render(<Conversation {...baseProps} turnStatus="submitting" />)

    expect(screen.getByRole('status').textContent).toContain('Sending your message…')
    expect(screen.queryByText('Atlas is working')).toBeNull()

    rerender(<Conversation {...baseProps} turnStatus="streaming" />)
    expect(screen.getByRole('status').textContent).toContain('Atlas is working')
    expect(screen.queryByText('Sending your message…')).toBeNull()
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

  it('offers Stop once while working and disables it while the request is in flight', () => {
    const onInterrupt = vi.fn()
    const { rerender } = render(<Conversation {...baseProps} draft="next message" onInterrupt={onInterrupt} turnStatus="streaming" />)

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onInterrupt).toHaveBeenCalledOnce()

    rerender(<Conversation {...baseProps} draft="next message" onInterrupt={onInterrupt} streamingText="Partial answer" turnStatus="stopping" />)
    const stopping = screen.getByRole('button', { name: 'Stopping…' })
    expect(stopping.hasAttribute('disabled')).toBe(true)
    fireEvent.click(stopping)
    expect(onInterrupt).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toContain('Stopping Atlas…')
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(true)
  })

  it('clears the working card after interruption and leaves the composer recoverable', () => {
    render(<Conversation {...baseProps} draft="Follow-up" turnStatus="interrupted" />)

    expect(screen.getByRole('status').textContent).toContain('Turn interrupted')
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.queryByText('Atlas is working')).toBeNull()
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(false)
  })

  it('shows the current approval request', () => {
    const approval: PendingApproval = { requestId: 'r1', sessionId: 's1', title: 'Publish?', description: 'Review.', choices: ['once'], responding: false }
    render(<Conversation {...baseProps} approval={approval} />)
    expect(screen.getByRole('heading', { name: 'Publish?' })).toBeTruthy()
  })

  it('keeps plain Enter as a newline and sends once on click or Ctrl/Cmd+Enter', () => {
    const onSubmit = vi.fn()
    render(<Conversation {...baseProps} draft="ready" onSubmit={onSubmit} />)
    const composer = screen.getByLabelText('Message Atlas')

    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true })
    expect(onSubmit).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('does not submit while an IME composition is being confirmed', () => {
    const onSubmit = vi.fn()
    render(<Conversation {...baseProps} draft="未完" onSubmit={onSubmit} />)

    fireEvent.keyDown(screen.getByLabelText('Message Atlas'), { key: 'Enter', metaKey: true, isComposing: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('auto-resizes the shared composer as controlled draft content changes', () => {
    const { rerender } = render(<Conversation {...baseProps} draft="short" />)
    const composer = screen.getByLabelText('Message Atlas') as HTMLTextAreaElement
    expect(composer.rows).toBe(5)
    Object.defineProperty(composer, 'scrollHeight', { configurable: true, value: 240 })

    rerender(<Conversation {...baseProps} draft={'short\n'.repeat(20)} />)
    expect(composer.style.height).toBe('176px')

    Object.defineProperty(composer, 'scrollHeight', { configurable: true, value: 72 })
    rerender(<Conversation {...baseProps} draft="short again" />)
    expect(composer.style.height).toBe('72px')
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

  it('renders tool lifecycle and safe internal records as collapsed inert rows', () => {
    render(<Conversation {...baseProps} messages={[
      { id: 'tool-1', role: 'system', text: '{"output":"<img src=x onerror=alert(1)>"}', kind: 'tool', label: 'terminal', toolStatus: 'progress' },
      { id: 'internal-1', role: 'system', text: '[Safe link](https://example.com/internal) and [unsafe](javascript:alert(1))', kind: 'internal', label: 'Internal notification' },
      { id: 'compact-1', role: 'system', text: 'Private compacted detail', kind: 'compression', label: 'Earlier context summary' }
    ]} sessionKey="safe-status" />)

    expect(screen.getByText('terminal')).toBeTruthy()
    expect(screen.getByText('In progress')).toBeTruthy()
    expect(screen.getAllByRole('group')).toHaveLength(3)
    expect(document.body.textContent).not.toContain('onerror=alert')

    fireEvent.click(screen.getByText('terminal'))
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(document.querySelector('img')).toBeNull()

    fireEvent.click(screen.getByText('Internal notification'))
    const safeLink = screen.getByRole('link', { name: 'Safe link' })
    expect(safeLink.getAttribute('href')).toBe('https://example.com/internal')
    expect(safeLink.getAttribute('rel')).toBe('noreferrer')
    expect(screen.queryByRole('link', { name: 'unsafe' })).toBeNull()
  })
})
