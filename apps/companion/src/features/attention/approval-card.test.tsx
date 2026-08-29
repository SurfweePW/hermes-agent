import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ApprovalCard } from './approval-card'

describe('ApprovalCard', () => {
  it('offers explicit approval scopes and denial callbacks', () => {
    const onDecision = vi.fn()
    render(<ApprovalCard onDecision={onDecision} />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve once' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve for session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

    expect(onDecision.mock.calls).toEqual([["once"], ["session"], ["deny"]])
    expect(screen.getByRole('group', { name: 'Approval choices' })).toBeTruthy()
  })
})
