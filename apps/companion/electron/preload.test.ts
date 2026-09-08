import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() }
}))

import { CHANNELS, createGatewayTokenBridge, createOriginalRouteBridge } from './preload'

describe('Companion preload bridge', () => {
  it('exposes only fixed gateway token methods over fixed asynchronous channels', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: 'saved-value' })
      .mockResolvedValue({ ok: true })

    const bridge = createGatewayTokenBridge({ invoke })

    expect(Object.keys(bridge)).toEqual(['get', 'set', 'reset'])
    await expect(bridge.get()).resolves.toBe('saved-value')
    await bridge.set('replacement-value')
    await bridge.reset()

    expect(invoke.mock.calls).toEqual([
      [CHANNELS.get],
      [CHANNELS.set, 'replacement-value'],
      [CHANNELS.reset]
    ])
    expect(JSON.stringify(bridge)).not.toContain('replacement-value')
  })

  it('rejects invalid native response shapes', async () => {
    const bridge = createGatewayTokenBridge({ invoke: async () => ({ value: 'bad' }) })
    await expect(bridge.get()).rejects.toThrow(/secure storage/i)
  })

  it('sends a fixed open-original request and rejects native denial', async () => {
    const input = {
      route: { verified: true as const, client: 'hermes-desktop' as const, platform: 'macos' as const, url: 'hermes://session/stored-1?profile=atlas' },
      profile: 'atlas', sessionId: 'stored-1'
    }

    const invoke = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'invalid-request' })
    const bridge = createOriginalRouteBridge({ invoke })

    await expect(bridge(input)).resolves.toBeUndefined()
    await expect(bridge(input)).rejects.toThrow('invalid-request')
    expect(invoke).toHaveBeenNthCalledWith(1, CHANNELS.openOriginalRoute, input)
  })
})
