import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Recovery } from './recovery'

describe('Recovery', () => {
  it('explains disconnection and draft preservation', () => {
    render(<Recovery onRetry={() => undefined} />)

    expect(screen.getByRole('heading', { name: 'Connection paused. Your work is safe.' })).toBeTruthy()
    expect(screen.getByText(/Your draft is saved on this device/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('finishes safely by returning through the provided back action', () => {
    const onBack = vi.fn()
    render(<Recovery onBack={onBack} onRetry={() => undefined} />)

    fireEvent.click(screen.getByRole('button', { name: 'Finish safely' }))

    expect(onBack).toHaveBeenCalledOnce()
  })
})
