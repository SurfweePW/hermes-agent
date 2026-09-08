import type { CompanionOriginalRoute } from '../gateway/original-route'

import { capacitorGatewayTokenBridge } from './capacitor-token-bridge'
import type { OwnerAuthBridge } from './owner-auth'

export interface SessionSecretStore {
  readonly persistent: boolean
  set(name: string, value: string): void | Promise<void>
  get(name: string): string | undefined | Promise<string | undefined>
  delete(name: string): void | Promise<void>
  clear(): void | Promise<void>
}

export interface GatewayTokenBridge {
  get(): Promise<string | undefined>
  set(value: string): Promise<void>
  reset(): Promise<void>
}

export interface OriginalRouteBridge {
  openOriginalRoute(input: { route: CompanionOriginalRoute; profile: string; sessionId: string }): Promise<void>
}

declare global {
  interface Window {
    hermesCompanion?: Readonly<{ gatewayToken: GatewayTokenBridge } & Partial<OwnerAuthBridge & OriginalRouteBridge>>
  }
}

/** Creates an isolated, memory-only secret store for browser sessions. */
export function createSessionSecretStore(): SessionSecretStore {
  const secrets = new Map<string, string>()

  return Object.freeze({
    persistent: false,
    set(name: string, value: string): void {
      if (!name) { throw new Error('A secret name is required.') }

      if (!value) { throw new Error('A secret value is required.') }
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
    },
    toJSON(): Record<string, never> {
      return {}
    }
  })
}

function createNativeSecretStore(bridge: GatewayTokenBridge): SessionSecretStore {
  const assertGatewayToken = (name: string) => {
    if (name !== 'gateway-token') { throw new Error('Only the gateway token is supported.') }
  }

  return Object.freeze({
    persistent: true,
    async set(name: string, value: string): Promise<void> {
      assertGatewayToken(name)

      if (!value) { throw new Error('A secret value is required.') }
      await bridge.set(value)
    },
    async get(name: string): Promise<string | undefined> {
      assertGatewayToken(name)

      return bridge.get()
    },
    async delete(name: string): Promise<void> {
      assertGatewayToken(name)
      await bridge.reset()
    },
    // Store destruction clears ephemeral session state only. Persistent native
    // state is removed exclusively by the explicit delete/reset operation.
    clear(): void {},
    toString(): string {
      return '[NativeGatewayTokenStore]'
    },
    toJSON(): Record<string, never> {
      return {}
    }
  })
}

export function createDefaultSecretStore(): SessionSecretStore {
  const electronBridge = typeof window === 'undefined' ? undefined : window.hermesCompanion?.gatewayToken
  const bridge = electronBridge ?? capacitorGatewayTokenBridge()

  return bridge ? createNativeSecretStore(bridge) : createSessionSecretStore()
}
