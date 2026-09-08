export interface DirectoryRefreshLifecycleOptions {
  isReady(): boolean
  refreshWork(): Promise<unknown>
  refreshDirectory(): Promise<unknown>
  refreshAttention(): Promise<unknown>
  refreshLibrary(): void
  intervalMs?: number
}

/** Install one visible-only refresh loop for every persisted Companion catalog. */
export function installDirectoryRefreshLifecycle({
  isReady,
  refreshWork,
  refreshDirectory,
  refreshAttention,
  refreshLibrary,
  intervalMs = 25_000
}: DirectoryRefreshLifecycleOptions): { refresh(): void; destroy(): void } {
  let refreshing = false
  let destroyed = false

  const refresh = () => {
    if (destroyed || refreshing || document.visibilityState === 'hidden' || !isReady()) {return}
    refreshing = true
    refreshLibrary()
    void Promise.allSettled([
      refreshWork(),
      refreshDirectory(),
      refreshAttention()
    ]).finally(() => {if (!destroyed) {refreshing = false}})
  }

  document.addEventListener('visibilitychange', refresh)
  window.addEventListener('online', refresh)
  window.addEventListener('focus', refresh)
  const interval = window.setInterval(refresh, intervalMs)

  return {
    refresh,
    destroy() {
      destroyed = true
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('online', refresh)
      window.removeEventListener('focus', refresh)
      window.clearInterval(interval)
    }
  }
}
