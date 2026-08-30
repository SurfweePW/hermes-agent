import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { PendingApproval } from '../../state/companion-store'

import { ApprovalCard } from './approval-card'

const approval: PendingApproval = {
  requestId: 'request-1', sessionId: 'runtime-1', title: 'Publish?', description: 'Review the action.',
  choices: ['once', 'session', 'deny'], responding: false
}

describe('ApprovalCard', () => {
  it('offers only server-provided approval scopes and denial callbacks', () => {
    const onDecision = vi.fn()
    render(<ApprovalCard approval={approval} onDecision={onDecision} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve once' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve for session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onDecision.mock.calls).toEqual([['once'], ['session'], ['deny']])
    expect(screen.getByRole('group', { name: 'Approval choices' })).toBeTruthy()
  })

  it('disables choices while the exact request is resolving', () => {
    render(<ApprovalCard approval={{ ...approval, responding: true }} onDecision={() => undefined} />)
    expect((screen.getByRole('button', { name: 'Approve once' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
