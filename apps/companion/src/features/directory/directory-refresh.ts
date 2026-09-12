export interface DirectoryRefreshLifecycleOptions {
  isReady(): boolean
  refreshWork(): Promise<unknown>
  refreshDirectory(): Promise<unknown>
  refreshAttention(): Promise<unknown>
  refreshLibrary(): void
  intervalMs?: number
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

/** Install one visible-only refresh loop for every persisted Companion catalog. */
export function installDirectoryRefreshLifecycle({
  isReady,
  refreshWork,
  refreshDirectory,
  refreshAttention,
  refreshLibrary,
  intervalMs = 30_000,
  onBackendUpdateRequired
}: DirectoryRefreshLifecycleOptions): { refresh(): Promise<RefreshResult>; isFresh(): boolean; destroy(): void } {
  let refreshInFlight: Promise<RefreshResult> | null = null
  let destroyed = false
  let lastDirectoryRefreshAt: number | null = null
  let updateNoticeSent = false

  const refresh = (): Promise<RefreshResult> => {
    if (destroyed || document.visibilityState === 'hidden' || !isReady()) {return Promise.resolve('skipped')}
    if (refreshInFlight) {return refreshInFlight}
    const operation = Promise.allSettled([
      refreshWork(),
      refreshDirectory(),
      refreshAttention(),
      Promise.resolve(refreshLibrary())
    ]).then((results): RefreshResult => {
      const directory = results[1]

      if (directory.status === 'fulfilled') {
        lastDirectoryRefreshAt = Date.now()
        updateNoticeSent = false
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
  const interval = window.setInterval(refresh, intervalMs)

  return {
    refresh,
    isFresh: () => lastDirectoryRefreshAt !== null && Date.now() - lastDirectoryRefreshAt <= intervalMs,
    destroy() {
      destroyed = true
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('online', refresh)
      window.removeEventListener('focus', refresh)
      window.clearInterval(interval)
    }
  }
}
