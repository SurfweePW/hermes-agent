import { useSyncExternalStore } from 'react'

import type { CompanionSnapshot, CompanionStore } from './companion-store'

export function useCompanion(store: CompanionStore): CompanionSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
