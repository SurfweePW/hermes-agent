export interface SessionSecretStore {
  set(name: string, value: string): void
  get(name: string): string | undefined
  delete(name: string): void
  clear(): void
}

/**
 * Creates an isolated, memory-only secret store for the current app session.
 *
 * The closure intentionally keeps secret values out of the returned object's
 * enumerable properties. Native shells can replace this implementation with a
 * protected platform store when one is available.
 */
export function createSessionSecretStore(): SessionSecretStore {
  const secrets = new Map<string, string>()

  return Object.freeze({
    set(name: string, value: string): void {
      if (!name) {
        throw new Error('A secret name is required.')
      }

      if (!value) {
        throw new Error('A secret value is required.')
      }

      secrets.set(name, value)
    },
    get(name: string): string | undefined {
      return secrets.get(name)
    },
    delete(name: string): void {
      secrets.delete(name)
    },
    clear(): void {
      secrets.clear()
    },
    toString(): string {
      return '[SessionSecretStore]'
    }
  })
}
