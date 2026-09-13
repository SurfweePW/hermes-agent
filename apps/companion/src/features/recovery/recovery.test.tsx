import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Recovery } from './recovery'

describe('Recovery', () => {
  it('explains draft preservation, uncertainty, and no replay', () => {
    render(<Recovery hasDraft onRetry={() => undefined} recovering={false} turnUncertain />)
    expect(screen.getByRole('heading', { name: 'Połączenie wstrzymane. Twoja praca jest bezpieczna.' })).toBeTruthy()
    expect(screen.queryByText(/Niewysłana treść/)).toBeNull()
    expect(screen.getByText(/Treść robocza jest zapisana.*wynik jej wysłania pozostaje nieznany/)).toBeTruthy()
    expect(screen.getByText(/Tura mogła zostać przyjęta/)).toBeTruthy()
    expect(screen.getByText(/Żadna wiadomość nie zostanie wysłana ponownie automatycznie/)).toBeTruthy()
  })

  it('finishes safely by returning through the provided back action', () => {
    const onBack = vi.fn()
    render(<Recovery hasDraft={false} onBack={onBack} onRetry={() => undefined} recovering={false} turnUncertain={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Zakończ bezpiecznie' }))
    expect(onBack).toHaveBeenCalledOnce()
  })
})
