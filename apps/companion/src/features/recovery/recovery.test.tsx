import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Recovery } from './recovery'

describe('Recovery', () => {
  it('explains draft preservation, uncertainty, and no replay', () => {
    render(<Recovery hasDraft onRetry={() => undefined} recovering={false} turnUncertain />)
    expect(screen.getByRole('heading', { name: 'Connection paused. Your work is safe.' })).toBeTruthy()
    expect(screen.queryByText(/unsent draft/)).toBeNull()
    expect(screen.getByText(/draft text is saved.*outcome is unknown/)).toBeTruthy()
    expect(screen.getByText(/may have been accepted/)).toBeTruthy()
    expect(screen.getByText(/No prompt will be replayed automatically/)).toBeTruthy()
  })

  it('finishes safely by returning through the provided back action', () => {
    const onBack = vi.fn()
    render(<Recovery hasDraft={false} onBack={onBack} onRetry={() => undefined} recovering={false} turnUncertain={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Finish safely' }))
    expect(onBack).toHaveBeenCalledOnce()
  })
})
