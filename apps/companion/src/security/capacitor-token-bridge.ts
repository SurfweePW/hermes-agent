import { Capacitor, registerPlugin } from '@capacitor/core'

import type { GatewayTokenBridge } from './secret-store'

interface GatewayTokenNativePlugin {
  get(): Promise<{ value?: unknown }>
  set(options: { value: string }): Promise<void>
  reset(): Promise<void>
}

const nativePlugin = registerPlugin<GatewayTokenNativePlugin>('GatewayToken')
const GENERIC_ERROR = 'Secure token storage unavailable.'
const MAX_TOKEN_LENGTH = 8192

function validToken(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TOKEN_LENGTH) { return false }

  for (const character of value) {
    const code = character.charCodeAt(0)

    if (code <= 31 || (code >= 127 && code <= 159)) { return false }
  }

  return true
}

export function createCapacitorGatewayTokenBridge(plugin: GatewayTokenNativePlugin): GatewayTokenBridge {
  return Object.freeze({
    async get(): Promise<string | undefined> {
      try {
        const result = await plugin.get()

        if (result.value === undefined) { return undefined }

        if (!validToken(result.value)) { throw new Error(GENERIC_ERROR) }

        return result.value
      } catch {
        throw new Error(GENERIC_ERROR)
      }
    },
    async set(value: string): Promise<void> {
      if (!validToken(value)) { throw new Error(GENERIC_ERROR) }

      try {
        await plugin.set({ value })
      } catch {
        throw new Error(GENERIC_ERROR)
      }
    },
    async reset(): Promise<void> {
      try {
        await plugin.reset()
      } catch {
        throw new Error(GENERIC_ERROR)
      }
    }
  })
}

export function capacitorGatewayTokenBridge(): GatewayTokenBridge | undefined {
  return Capacitor.getPlatform() === 'android'
    ? createCapacitorGatewayTokenBridge(nativePlugin)
    : undefined
}
