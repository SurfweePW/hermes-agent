import { afterEach, describe, expect, it, vi } from 'vitest'

import { installDirectoryRefreshLifecycle } from './directory-refresh'

afterEach(() => vi.useRealTimers())

describe('installDirectoryRefreshLifecycle', () => {
  it('polls every catalog within thirty seconds and pauses while hidden', async () => {
    vi.useFakeTimers()
    const refreshWork = vi.fn().mockResolvedValue(undefined)
    const refreshDirectory = vi.fn().mockResolvedValue(undefined)
    const refreshAttention = vi.fn().mockResolvedValue(undefined)
    const refreshLibrary = vi.fn()

    const lifecycle = installDirectoryRefreshLifecycle({
      isReady: () => true,
      refreshWork,
      refreshDirectory,
      refreshAttention,
      refreshLibrary
    })

    vi.advanceTimersByTime(25_000)
    expect(refreshWork).toHaveBeenCalledOnce()
    expect(refreshDirectory).toHaveBeenCalledOnce()
    expect(refreshAttention).toHaveBeenCalledOnce()
    expect(refreshLibrary).toHaveBeenCalledOnce()
    await vi.runAllTicks()
    await Promise.resolve()

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    vi.advanceTimersByTime(30_000)
    expect(refreshDirectory).toHaveBeenCalledOnce()

    visibility.mockRestore()
    lifecycle.destroy()
    vi.advanceTimersByTime(50_000)
    expect(refreshDirectory).toHaveBeenCalledOnce()
  })

  it('coalesces foreground signals while a refresh is in flight', () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {finish = resolve})
    const refreshWork = vi.fn(() => pending)

    const lifecycle = installDirectoryRefreshLifecycle({
      isReady: () => true,
      refreshWork,
      refreshDirectory: vi.fn().mockResolvedValue(undefined),
      refreshAttention: vi.fn().mockResolvedValue(undefined),
      refreshLibrary: vi.fn()
    })

    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    expect(refreshWork).toHaveBeenCalledOnce()

    finish()
    lifecycle.destroy()
  })
})
