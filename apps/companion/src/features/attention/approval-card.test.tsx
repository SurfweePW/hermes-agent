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
    fireEvent.click(screen.getByRole('button', { name: 'Zatwierdź raz' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zatwierdź dla rozmowy' }))
    fireEvent.click(screen.getByRole('button', { name: 'Odmów' }))
    expect(onDecision.mock.calls).toEqual([['once'], ['session'], ['deny']])
    expect(screen.getByRole('group', { name: 'Opcje zatwierdzenia' })).toBeTruthy()
  })

  it('disables choices while the exact request is resolving', () => {
    render(<ApprovalCard approval={{ ...approval, responding: true }} onDecision={() => undefined} />)
    expect((screen.getByRole('button', { name: 'Zatwierdź raz' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders Polish approval chrome without translating request content', () => {
    render(<ApprovalCard approval={approval} onDecision={() => undefined} />)
    expect(screen.getByText('Twoja zgoda')).toBeTruthy()
    expect(screen.getByText('Publish?')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Opcje zatwierdzenia' })).toBeTruthy()
  })
})
