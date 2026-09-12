import { afterEach, describe, expect, it, vi } from 'vitest'

import { BackendUpdateRequiredError, installDirectoryRefreshLifecycle } from './directory-refresh'

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

    vi.advanceTimersByTime(30_000)
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

  it('supports an awaited explicit refresh and records thirty-second freshness', async () => {
    vi.useFakeTimers()
    const refreshDirectory = vi.fn().mockResolvedValue(undefined)
    const lifecycle = installDirectoryRefreshLifecycle({
      isReady: () => true,
      refreshWork: vi.fn().mockResolvedValue(undefined),
      refreshDirectory,
      refreshAttention: vi.fn().mockResolvedValue(undefined),
      refreshLibrary: vi.fn()
    })

    await expect(lifecycle.refresh()).resolves.toBe('refreshed')
    expect(lifecycle.isFresh()).toBe(true)
    vi.advanceTimersByTime(30_001)
    expect(lifecycle.isFresh()).toBe(false)
    lifecycle.destroy()
  })

  it('reports an old backend once instead of treating it as an empty catalog', async () => {
    const onBackendUpdateRequired = vi.fn()
    const lifecycle = installDirectoryRefreshLifecycle({
      isReady: () => true,
      refreshWork: vi.fn().mockResolvedValue(undefined),
      refreshDirectory: vi.fn().mockRejectedValue(new BackendUpdateRequiredError()),
      refreshAttention: vi.fn().mockResolvedValue(undefined),
      refreshLibrary: vi.fn(),
      onBackendUpdateRequired
    })

    await lifecycle.refresh()
    await lifecycle.refresh()

    expect(onBackendUpdateRequired).toHaveBeenCalledOnce()
    expect(onBackendUpdateRequired).toHaveBeenCalledWith('Backend update required for the Companion directory.')
    lifecycle.destroy()
  })
})
