import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { safeWorkUrl, type WorkCardView, WorkInbox, type WorkInboxProps } from './work-inbox'

export const card: WorkCardView = {
  id: 'work-1', profile: 'CMO Exact', title: 'Prepare campaign', brief: 'A focused business brief', revision: 2,
  status: 'needs_me', bucket: 'needs_me', evidence: [{ label: 'Research', url: 'https://example.org/report' }],
  permitted: ['Draft copy'], excluded: ['Publish'], nextAction: 'Review preparation', owner: 'Pawel',
  decision: 'Awaiting review', previews: [{ label: 'Unsafe preview', url: 'javascript:alert(1)' }],
  discussion: [{ id: 'c1', author: 'CMO', body: 'Which audience?' }], actionable: true
}

function props(overrides: Partial<WorkInboxProps> = {}): WorkInboxProps {
  return { items: [card], selected: card, status: 'verified', pending: false, message: null, groupBy: 'topic', sources: [],
    onOpen: vi.fn(), onClose: vi.fn(), onRefresh: vi.fn(), onGroupBy: vi.fn(), onDecision: vi.fn(async () => true), onComment: vi.fn(async () => true), ...overrides }
}

describe('durable work inbox', () => {
  it('shows dispatch and revision-scoped decision history without claiming execution', () => {
    render(<WorkInbox {...props({ selected: { ...card, status: 'in_progress', actionable: false,
      preparationStatus: 'Preparation approved — awaiting execution tracker task link',
      decisionHistory: [{ id: 'd1', revision: 1, action: 'request_changes', actor: 'human', reason: 'Narrow earlier scope', createdAt: '2026-01-01T00:00:00Z', scope: 'none', snoozedUntil: null }]
    } })} />)
    expect(screen.getByText('Preparation approved — awaiting execution tracker task link')).toBeTruthy()
    expect(screen.getByText('request changes · Revision 1')).toBeTruthy()
    expect(screen.getByText('Narrow earlier scope')).toBeTruthy()
    expect(screen.getByText(/shared-token connections comment as an agent/)).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Decision for revision 2' }).hasAttribute('disabled')).toBe(true)
  })
  it('switching filters leaves detail and never retargets a pending decision', () => {
    const p = props(); const { rerender } = render(<WorkInbox {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ideas' }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
    rerender(<WorkInbox {...p} pending />)
    fireEvent.click(screen.getByRole('button', { name: 'In Progress' }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })

  it('renders revision, evidence, scope, owner and persisted discussion without active unsafe previews', () => {
    render(<WorkInbox {...props()} />)
    expect(screen.getByRole('heading', { name: card.title })).toBeTruthy()
    expect(screen.getByText('CMO Exact · needs_me · Revision 2')).toBeTruthy()

    for (const text of ['Draft copy', 'Publish', 'Pawel', 'Which audience?']) {expect(screen.getByText(text)).toBeTruthy()}
    expect(screen.getByRole('link', { name: /Research/ }).getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.queryByRole('link', { name: /Unsafe preview/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Always approve/ })).toBeNull()
  })
  it('renders tracker blocker, result, completion evidence and observed history', () => {
    render(<WorkInbox {...props({ selected: { ...card,
      trackerEvidence: { state: 'prepared', observed_at: '2026-09-06T11:00:00Z', evidence: ['tracker read-back'], result_evidence: ['prepared artifact'] },
      completionEvidence: ['final artifact'],
      trackerStatusHistory: [{ state: 'blocked', observed_at: '2026-09-06T10:00:00Z', evidence: ['block event'], blocker: 'Legal review' }]
    } })} />)
    expect(screen.getByText(/Observed 2026-09-06T11:00:00Z/)).toBeTruthy()
    expect(screen.getByText(/Result:/)).toBeTruthy()
    expect(screen.getByText(/Blocker:/)).toBeTruthy()
    expect(screen.getByText('final artifact')).toBeTruthy()
  })
  it('switches Topic, Session and Project grouping through the control', () => {
    const p = props({ selected: null }); render(<WorkInbox {...p} />)
    fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'session' } })
    expect(p.onGroupBy).toHaveBeenCalledWith('session')
  })
  it('keeps detailed source errors behind progressive disclosure', () => {
    render(<WorkInbox {...props({ selected: null, sources: [
      { profile: 'atlas', status: 'verified', incomplete: false, lastSuccess: '2026-09-07T10:00:00Z', message: null },
      { profile: 'offline', status: 'error', incomplete: true, lastSuccess: null, message: 'Refresh failed' }
    ] })} />)
    const summary = screen.getByText('1 of 2 work sources incomplete')
    const details = summary.closest('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    fireEvent.click(summary)
    expect(details.open).toBe(true)
  })
  it.each(['offline', 'error', 'unsupported', 'loading'] as const)('disables decision and comment on %s', (status) => {
    render(<WorkInbox {...props({ status })} />)
    expect(screen.getByRole('group', { name: 'Decision for revision 2' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Add comment' }).hasAttribute('disabled')).toBe(true)
  })
  it('does not pretend unsupported is an empty inbox', () => {
    render(<WorkInbox {...props({ selected: null, items: [], status: 'unsupported' })} />)
    expect(screen.getByText(/does not support the durable work inbox/)).toBeTruthy()
    expect(screen.queryByText(/No work in this view/)).toBeNull()
  })
  it('requires a changes comment and sends preparation-only decisions', async () => {
    const p = props(); render(<WorkInbox {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    expect(p.onDecision).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Discussion / requested changes'), { target: { value: 'Narrow audience' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    await waitFor(() => expect(p.onDecision).toHaveBeenCalledWith({ action: 'request_changes', comment: 'Narrow audience' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve preparation' }))
    await waitFor(() => expect(p.onDecision).toHaveBeenCalledWith({ action: 'approve_preparation' }))
  })
  it('submits snooze date and decline distinctly, never permission choices', async () => {
    const p = props(); render(<WorkInbox {...p} />)
    fireEvent.change(screen.getByLabelText('Snooze until'), { target: { value: '2099-12-01T12:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }))
    await waitFor(() => expect(p.onDecision).toHaveBeenCalledWith({ action: 'snooze', snoozedUntil: new Date('2099-12-01T12:00').toISOString() }))
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(p.onDecision).toHaveBeenCalledWith({ action: 'decline' }))
  })
  it('keeps historical work recoverable and opens exact profile/id without chat', () => {
    const p = props({ selected: null, items: [{ ...card, bucket: 'history', status: 'declined' }] }); render(<WorkInbox {...p} />)
    expect(screen.queryByText(card.title)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'History & snoozed' }))
    fireEvent.click(screen.getByRole('button', { name: /Prepare campaign/ }))
    expect(p.onOpen).toHaveBeenCalledWith('CMO Exact', 'work-1')
  })
  it('blocks duplicate pending controls and read-only work', () => {
    render(<WorkInbox {...props({ pending: true })} />)
    expect(screen.getByRole('group', { name: 'Decision for revision 2' }).hasAttribute('disabled')).toBe(true)
  })
  it('rejects executable, local and credential-bearing links', () => {
    for (const url of ['file:///etc/passwd', 'data:text/html,x', 'javascript:alert(1)', 'https://u:p@example.org', '/relative']) {expect(safeWorkUrl(url)).toBeUndefined()}
  })
})
