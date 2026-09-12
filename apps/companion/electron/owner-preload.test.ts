// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() }
}))

import { CHANNELS, createGatewayTokenBridge, createOwnerBridge } from './preload'

const input = { baseUrl: 'http://127.0.0.1:8642/prefix' }
const socketUrl = 'ws://127.0.0.1:8642/prefix/api/ws?ticket=single_use_ticket_1'
const ownerScope = 'a'.repeat(64)

describe('Companion owner preload bridge', () => {
  it('exposes exactly the fixed minimal surface', () => {
    const bridge = createOwnerBridge({ invoke: vi.fn() })
    expect(Object.keys(bridge).sort()).toEqual([
      'ownerSignIn', 'ownerSignOut', 'ownerStatus', 'ownerWebSocketUrl'
    ])
  })

  it('uses only exact {baseUrl} requests and returns status or a one-use WebSocket URL', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { signedIn: true, baseUrl: input.baseUrl, ownerScope, ignored: 'secret' } })
      .mockResolvedValueOnce({ ok: true, value: { signedIn: false } })
      .mockResolvedValueOnce({ ok: true, value: socketUrl })
      .mockResolvedValueOnce({ ok: true })

    const bridge = createOwnerBridge({ invoke })

    expect(await bridge.ownerSignIn(input)).toEqual({ signedIn: true, baseUrl: input.baseUrl, ownerScope })
    expect(await bridge.ownerStatus(input)).toEqual({ signedIn: false })
    expect(await bridge.ownerWebSocketUrl(input)).toBe(socketUrl)
    await expect(bridge.ownerSignOut(input)).resolves.toBeUndefined()
    expect(invoke.mock.calls).toEqual([
      [CHANNELS.ownerSignIn, input],
      [CHANNELS.ownerStatus, input],
      [CHANNELS.ownerWebSocketUrl, input],
      [CHANNELS.ownerSignOut, input]
    ])
    expect(JSON.stringify(bridge)).not.toMatch(/access_token|refresh_token/)
  })

  it('rejects malformed request shapes client-side without invoking IPC', async () => {
    const invoke = vi.fn()
    const bridge = createOwnerBridge({ invoke })

    const malformed = [undefined, null, 'https://gateway.example', 123, {}, { baseUrl: 123 },
      { baseUrl: input.baseUrl, extra: true }, [input]]

    for (const value of malformed) {
      await expect(bridge.ownerSignIn(value as never)).rejects.toThrow('invalid-request')
      await expect(bridge.ownerStatus(value as never)).rejects.toThrow('invalid-request')
      await expect(bridge.ownerSignOut(value as never)).rejects.toThrow('invalid-request')
      await expect(bridge.ownerWebSocketUrl(value as never)).rejects.toThrow('invalid-request')
    }

    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([
    'not a url',
    'https://127.0.0.1:8642/prefix/api/ws?ticket=single_use_ticket_1',
    'ws://evil.example/prefix/api/ws?ticket=single_use_ticket_1',
    'ws://127.0.0.1:8642/wrong?ticket=single_use_ticket_1',
    'ws://user:secret@127.0.0.1:8642/prefix/api/ws?ticket=single_use_ticket_1',
    'ws://127.0.0.1:8642/prefix/api/ws?ticket=short',
    'ws://127.0.0.1:8642/prefix/api/ws?ticket=single_use_ticket_1&token=secret',
    'ws://127.0.0.1:8642/prefix/api/ws?ticket=single_use_ticket_1#secret'
  ])('rejects malformed or non-matching WebSocket capability URL %s', async value => {
    const bridge = createOwnerBridge({ invoke: vi.fn().mockResolvedValue({ ok: true, value }) })
    await expect(bridge.ownerWebSocketUrl(input)).rejects.toThrow('owner-auth-failed')
  })

  it('returns only known native errors and hides malformed responses and invoke failures', async () => {
    for (const response of [
      { ok: false, error: 'upstream trace secret' },
      { ok: true, value: 'nonsense' },
      null
    ]) {
      const bridge = createOwnerBridge({ invoke: vi.fn().mockResolvedValue(response) })
      await expect(bridge.ownerStatus(input)).rejects.toThrow('owner-auth-failed')
    }

    const rejected = createOwnerBridge({ invoke: vi.fn().mockRejectedValue(new Error('ipc secret')) })
    await expect(rejected.ownerStatus(input)).rejects.toThrow('owner-auth-failed')

    const known = createOwnerBridge({ invoke: vi.fn().mockResolvedValue({ ok: false, error: 'owner-auth-setup-required' }) })
    await expect(known.ownerSignIn(input)).rejects.toThrow('owner-auth-setup-required')
  })

  it('keeps the legacy gateway token bridge intact', () => {
    expect(Object.keys(createGatewayTokenBridge({ invoke: vi.fn() }))).toEqual(['get', 'set', 'reset'])
  })
})
