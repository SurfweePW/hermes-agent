import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { PullToRefresh } from './pull-to-refresh'

describe('PullToRefresh', () => {
  it('triggers one refresh after a deliberate downward pull and shows progress', async () => {
    let finish: (() => void) | undefined
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => {finish = resolve}))
    const { container } = render(<PullToRefresh enabled onRefresh={onRefresh}><div>Lista</div></PullToRefresh>)
    const root = container.firstElementChild as HTMLElement

    fireEvent.touchStart(root, { touches: [{ clientX: 20, clientY: 10 }] })
    fireEvent.touchMove(root, { touches: [{ clientX: 22, clientY: 160 }] })
    fireEvent.touchEnd(root)

    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toContain('Odświeżanie…')

    fireEvent.touchStart(root, { touches: [{ clientX: 20, clientY: 10 }] })
    fireEvent.touchMove(root, { touches: [{ clientX: 20, clientY: 170 }] })
    fireEvent.touchEnd(root)
    expect(onRefresh).toHaveBeenCalledTimes(1)

    finish?.()
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Pociągnij, aby odświeżyć'))
  })

  it('ignores horizontal and short drags', () => {
    const onRefresh = vi.fn(async () => undefined)
    const { container } = render(<PullToRefresh enabled onRefresh={onRefresh}><div>Lista</div></PullToRefresh>)
    const root = container.firstElementChild as HTMLElement

    fireEvent.touchStart(root, { touches: [{ clientX: 10, clientY: 10 }] })
    fireEvent.touchMove(root, { touches: [{ clientX: 100, clientY: 40 }] })
    fireEvent.touchEnd(root)
    expect(onRefresh).not.toHaveBeenCalled()
  })
})
