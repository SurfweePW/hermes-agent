import { describe, expect, it, vi } from 'vitest'

import { createCapacitorGatewayTokenBridge } from './capacitor-token-bridge'

describe('Capacitor gateway token adapter', () => {
  it('conforms to the async bridge contract without retaining token state', async () => {
    const plugin = {
      get: vi.fn(async () => ({ value: 'native-token' })),
      set: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined)
    }

    const bridge = createCapacitorGatewayTokenBridge(plugin)

    await expect(bridge.get()).resolves.toBe('native-token')
    await bridge.set('replacement-token')
    await bridge.reset()

    expect(plugin.set).toHaveBeenCalledWith({ value: 'replacement-token' })
    expect(Object.keys(bridge).sort()).toEqual(['get', 'reset', 'set'])
    expect(JSON.stringify(bridge)).toBe('{}')
    expect(JSON.stringify(bridge)).not.toContain('native-token')
  })

  it('rejects invalid native responses and request values with generic errors', async () => {
    const plugin = {
      get: vi.fn(async () => ({ value: { leaked: true } })),
      set: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined)
    }

    const bridge = createCapacitorGatewayTokenBridge(plugin)

    await expect(bridge.get()).rejects.toThrow('Secure token storage unavailable.')
    await expect(bridge.set('')).rejects.toThrow('Secure token storage unavailable.')
    expect(plugin.set).not.toHaveBeenCalled()
  })
})
