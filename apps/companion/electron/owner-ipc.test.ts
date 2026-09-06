// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ IpcMain: {}, IpcMainInvokeEvent: {}, WebContents: {} }))

import { CHANNELS } from './channels'
import { registerOwnerIpc } from './owner-ipc'

const baseUrl = 'http://127.0.0.1:8642'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function rig() {
  const handlers = new Map<string, Handler>()

  const owner = {
    ownerSignIn: vi.fn(async () => ({ signedIn: true, baseUrl })),
    ownerStatus: vi.fn(() => ({ signedIn: false })),
    ownerSignOut: vi.fn(),
    ownerWebSocketUrl: vi.fn(async () => 'ws://127.0.0.1:8642/api/ws?ticket=single_use_ticket_1')
  }

  const frame = { url: 'file:///app/dist/web/index.html' }
  const contents = { mainFrame: frame, isDestroyed: () => false }
  let target: { contents: typeof contents; url: string } | undefined = { contents, url: frame.url }

  registerOwnerIpc(owner as never, {
    handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }
  } as never, () => target as never)

  return {
    handlers,
    owner,
    contents,
    frame,
    event: { sender: contents, senderFrame: frame },
    setTarget: (value: typeof target) => { target = value }
  }
}

describe('owner IPC trust and payload validation', () => {
  it('binds all channels to the exact {baseUrl} API', async () => {
    const { handlers, owner, event } = rig()
    const input = { baseUrl }

    expect(await handlers.get(CHANNELS.ownerSignIn)!(event, input)).toEqual({
      ok: true, value: { signedIn: true, baseUrl }
    })
    expect(await handlers.get(CHANNELS.ownerStatus)!(event, input)).toEqual({
      ok: true, value: { signedIn: false }
    })
    expect(await handlers.get(CHANNELS.ownerSignOut)!(event, input)).toEqual({ ok: true, value: undefined })
    expect(await handlers.get(CHANNELS.ownerWebSocketUrl)!(event, input)).toEqual({
      ok: true, value: 'ws://127.0.0.1:8642/api/ws?ticket=single_use_ticket_1'
    })

    expect(owner.ownerSignIn).toHaveBeenCalledWith(input)
    expect(owner.ownerStatus).toHaveBeenCalledWith(input)
    expect(owner.ownerSignOut).toHaveBeenCalledWith(input)
    expect(owner.ownerWebSocketUrl).toHaveBeenCalledWith(input)
  })

  it('fails closed unless the sender is the current main window main frame at the trusted document', async () => {
    const cases = [
      () => { const r = rig(); r.setTarget(undefined);

 return r },
      () => { const r = rig();

 return { ...r, event: { sender: { mainFrame: r.frame }, senderFrame: r.frame } } },
      () => { const r = rig();

 return { ...r, event: { sender: r.contents, senderFrame: { url: r.frame.url } } } },
      () => { const r = rig(); r.frame.url = 'https://evil.example/';

 return r }
    ]

    for (const make of cases) {
      const { handlers, owner, event } = make()
      expect(await handlers.get(CHANNELS.ownerWebSocketUrl)!(event, { baseUrl })).toEqual({
        ok: false, error: 'untrusted-renderer'
      })
      expect(owner.ownerWebSocketUrl).not.toHaveBeenCalled()
    }
  })

  it('does not return an awaited capability after navigation replaces the trusted document', async () => {
    const r = rig()
    let release!: (value: string) => void
    r.owner.ownerWebSocketUrl.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = r.handlers.get(CHANNELS.ownerWebSocketUrl)!(r.event, { baseUrl })

    r.contents.mainFrame = { url: r.frame.url }
    release('ws://127.0.0.1:8642/api/ws?ticket=single_use_ticket_1')
    await expect(pending).resolves.toEqual({ ok: false, error: 'untrusted-renderer' })
  })

  it('rejects every malformed argument shape before invoking owner auth', async () => {
    const { handlers, owner, event } = rig()

    const malformed: unknown[][] = [[], [baseUrl], [null], [123], [{}], [{ baseUrl, extra: true }],
      [{ baseUrl }, 'extra'], [[{ baseUrl }]]]

    for (const channel of [CHANNELS.ownerSignIn, CHANNELS.ownerStatus, CHANNELS.ownerSignOut,
      CHANNELS.ownerWebSocketUrl]) {
      for (const args of malformed) {
        expect(await handlers.get(channel)!(event, ...args)).toEqual({ ok: false, error: 'invalid-request' })
      }
    }

    expect(owner.ownerSignIn).not.toHaveBeenCalled()
    expect(owner.ownerStatus).not.toHaveBeenCalled()
    expect(owner.ownerSignOut).not.toHaveBeenCalled()
    expect(owner.ownerWebSocketUrl).not.toHaveBeenCalled()
  })

  it('maps arbitrary failures to fixed error codes without leaking details', async () => {
    const r = rig()
    r.owner.ownerSignIn.mockRejectedValueOnce(new Error('refresh_token=hunter2 upstream detail'))
    const response = await r.handlers.get(CHANNELS.ownerSignIn)!(r.event, { baseUrl })

    expect(response).toEqual({ ok: false, error: 'owner-auth-failed' })
    expect(JSON.stringify(response)).not.toContain('hunter2')
  })
})
