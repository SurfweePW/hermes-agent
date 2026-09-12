import { Capacitor, registerPlugin } from '@capacitor/core'

/** Native-only operations: no credential, ticket, or owner identity enters React. */
export interface OwnerAuthBridge {
  ownerSignIn(options: { baseUrl: string }): Promise<unknown>
  ownerStatus(options: { baseUrl: string }): Promise<unknown>
  ownerSignOut(options: { baseUrl: string }): Promise<unknown>
  ownerWebSocketUrl(options: { baseUrl: string }): Promise<string>
}

export interface SecureOwnerSignOutOptions {
  bridge: Pick<OwnerAuthBridge, 'ownerSignOut'>
  baseUrl: string
  revokeGatewayAccess(): void | Promise<void>
  clearHistory(): void | Promise<void>
  clearCache(): void | Promise<void>
  clearDrafts(): void | Promise<void>
}
const nativePlugin = registerPlugin<OwnerAuthBridge>('GatewayToken')

export function getOwnerAuthBridge(): OwnerAuthBridge | undefined {
  const bridge = typeof window === 'undefined' ? undefined : window.hermesCompanion

  if (bridge?.ownerSignIn && bridge.ownerStatus && bridge.ownerSignOut && bridge.ownerWebSocketUrl) {
    return {
      ownerSignIn: (options) => bridge.ownerSignIn!(options),
      ownerStatus: (options) => bridge.ownerStatus!(options),
      ownerSignOut: (options) => bridge.ownerSignOut!(options),
      ownerWebSocketUrl: (options) => bridge.ownerWebSocketUrl!(options)
    }
  }

  if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('GatewayToken')) {return undefined}

  return {
    ownerSignIn: (options) => nativePlugin.ownerSignIn(options),
    ownerStatus: (options) => nativePlugin.ownerStatus(options),
    ownerSignOut: (options) => nativePlugin.ownerSignOut(options),
    ownerWebSocketUrl: async (options) => {
      const result = await (nativePlugin.ownerWebSocketUrl(options) as unknown as Promise<{ value?: unknown }>)

      if (typeof result?.value !== 'string') {throw new Error('owner-auth-failed')}

      return result.value
    }
  }
}

/** App wiring must supply its existing history, cache, and draft reset hooks. */
export function createSecureOwnerSignOut(options: SecureOwnerSignOutOptions): () => Promise<void> {
  let operation: Promise<void> | null = null
  const invoke = (action: () => void | Promise<void>) => Promise.resolve().then(action)

  return () => {
    if (operation) { return operation }

    operation = (async () => {
      const results = await Promise.allSettled([
        invoke(options.revokeGatewayAccess),
        invoke(options.clearHistory),
        invoke(options.clearCache),
        invoke(options.clearDrafts),
        invoke(async () => { await options.bridge.ownerSignOut({ baseUrl: options.baseUrl }) })
      ])

      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('owner-sign-out-incomplete')
      }
    })()

    return operation
  }
}
