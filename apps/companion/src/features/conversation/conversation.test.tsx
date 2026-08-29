import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Conversation } from './conversation'

describe('Conversation', () => {
  it('announces streaming progress in a semantic live region', () => {
    render(<Conversation isStreaming onApproval={() => undefined} />)

    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toContain('Atlas is working')
    expect(screen.getByText('Checking the final sources')).toBeTruthy()
  })

  it('replaces approval actions with one visible semantic decision status', () => {
    const { rerender } = render(<Conversation isStreaming={false} onApproval={() => undefined} />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve once' }))
    rerender(<Conversation decision="Approved once" isStreaming={false} onApproval={() => undefined} />)

    expect(screen.queryByRole('button', { name: 'Approve once' })).toBeNull()
    const statuses = screen.getAllByRole('status')
    expect(statuses).toHaveLength(1)
    expect(statuses[0].textContent).toContain('Choice saved: Approved once')
  })
})
