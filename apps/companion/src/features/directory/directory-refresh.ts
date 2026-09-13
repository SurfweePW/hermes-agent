export interface DirectoryRefreshLifecycleOptions {
  isReady(): boolean
  refreshWork(): Promise<unknown>
  refreshDirectory(): Promise<unknown>
  refreshAttention(): Promise<unknown>
  refreshLibrary(): void
  refreshVisible?(): Promise<unknown> | unknown
  shouldRefresh?(): boolean
  intervalMs?: number | (() => number)
  onRefreshed?(at: number): void
  onBackendUpdateRequired?(message: string): void
}

export class BackendUpdateRequiredError extends Error {
  readonly code = -32601

  constructor() {
    super('Backend update required for the Companion directory.')
    this.name = 'BackendUpdateRequiredError'
  }
}

type RefreshResult = 'refreshed' | 'skipped'

const updateRequired = (error: unknown): boolean => {
  if (error instanceof BackendUpdateRequiredError) { return true }
  if (typeof error === 'object' && error !== null && 'code' in error && Number(error.code) === -32601) { return true }

  return error instanceof Error && /method not found|unknown method|-32601/i.test(error.message)
}

/** Install one coalesced refresh loop for the currently visible Companion surface. */
export function installDirectoryRefreshLifecycle({
  isReady,
  refreshWork,
  refreshDirectory,
  refreshAttention,
  refreshLibrary,
  intervalMs = 30_000,
  refreshVisible,
  shouldRefresh = () => true,
  onRefreshed,
  onBackendUpdateRequired
}: DirectoryRefreshLifecycleOptions): { refresh(): Promise<RefreshResult>; reschedule(): void; isFresh(): boolean; destroy(): void } {
  let refreshInFlight: Promise<RefreshResult> | null = null
  let destroyed = false
  let lastDirectoryRefreshAt: number | null = null
  let updateNoticeSent = false

  const refresh = (): Promise<RefreshResult> => {
    if (destroyed || document.visibilityState === 'hidden' || !isReady() || !shouldRefresh()) {return Promise.resolve('skipped')}
    if (refreshInFlight) {return refreshInFlight}
    const operations = refreshVisible
      ? [Promise.resolve().then(refreshVisible)]
      : [refreshWork(), refreshDirectory(), refreshAttention(), Promise.resolve(refreshLibrary())]
    const operation = Promise.allSettled(operations).then((results): RefreshResult => {
      const directory = refreshVisible ? results[0] : results[1]

      if (directory.status === 'fulfilled') {
        lastDirectoryRefreshAt = Date.now()
        updateNoticeSent = false
        onRefreshed?.(lastDirectoryRefreshAt)
      } else if (updateRequired(directory.reason) && !updateNoticeSent) {
        updateNoticeSent = true
        onBackendUpdateRequired?.('Backend update required for the Companion directory.')
      }

      return 'refreshed'
    })
    const settled = operation.finally(() => {
      if (refreshInFlight === settled) {refreshInFlight = null}
    })
    refreshInFlight = settled

    return settled
  }

  document.addEventListener('visibilitychange', refresh)
  window.addEventListener('online', refresh)
  window.addEventListener('focus', refresh)
  let timer = 0
  const schedule = () => {
    if (destroyed) {return}
    window.clearTimeout(timer)
    const delay = typeof intervalMs === 'function' ? intervalMs() : intervalMs
    timer = window.setTimeout(() => {
      void refresh().finally(schedule)
    }, delay)
  }
  schedule()

  return {
    refresh,
    reschedule: schedule,
    isFresh: () => lastDirectoryRefreshAt !== null && Date.now() - lastDirectoryRefreshAt <= (typeof intervalMs === 'function' ? intervalMs() : intervalMs),
    destroy() {
      destroyed = true
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('online', refresh)
      window.removeEventListener('focus', refresh)
      window.clearTimeout(timer)
    }
  }
}
