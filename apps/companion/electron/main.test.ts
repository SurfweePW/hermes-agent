import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {}, BrowserWindow: vi.fn(), ipcMain: { handle: vi.fn() }, protocol: { registerSchemesAsPrivileged: vi.fn() }, safeStorage: {}
}))

import { CHANNELS } from './channels'
import {
  APP_ID,
  browserWindowOptions,
  DEVELOPMENT_USER_DATA_DIRECTORY,
  isTrustedRendererUrl,
  PRODUCT_NAME,
  PROTOCOL,
  registerGatewayTokenIpc,
  selectRendererTarget,
  USER_DATA_DIRECTORY,
  userDataDirectory
} from './main'

describe('Companion Electron shell', () => {
  it('has a distinct native identity', () => {
    expect(APP_ID).toBe('com.hermes.companion')
    expect(PRODUCT_NAME).toBe('Hermes Companion')
    expect(PROTOCOL).toBe('hermes-companion')
    expect(USER_DATA_DIRECTORY).toBe('Hermes Companion')
    expect(APP_ID).not.toBe('com.nousresearch.hermes')
    expect(PROTOCOL).not.toBe('hermes')
  })

  it('isolates development credentials from the packaged Keychain identity', () => {
    expect(userDataDirectory(true)).toBe(USER_DATA_DIRECTORY)
    expect(userDataDirectory(false)).toBe(DEVELOPMENT_USER_DATA_DIRECTORY)
    expect(DEVELOPMENT_USER_DATA_DIRECTORY).not.toBe(USER_DATA_DIRECTORY)
  })

  it('uses hardened renderer preferences', () => {
    const options = browserWindowOptions('/fixed/preload.js')
    expect(options.show).toBe(true)
    expect(options.webPreferences).toMatchObject({
      preload: '/fixed/preload.js',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false
    })
  })

  it('ignores a dev-server override in packaged mode and rejects remote development origins', () => {
    expect(selectRendererTarget({ directory: '/app/dist', isPackaged: true, developmentServer: 'http://localhost:5173' })).toEqual({
      kind: 'file', value: '/app/dist/web/index.html', trusted: 'file:///app/dist/web/index.html'
    })
    expect(selectRendererTarget({ directory: '/app/dist', isPackaged: false, developmentServer: 'https://evil.example' })).toEqual({
      kind: 'file', value: '/app/dist/web/index.html', trusted: 'file:///app/dist/web/index.html'
    })
    expect(selectRendererTarget({ directory: '/app/dist', isPackaged: false, developmentServer: 'http://127.0.0.1:5173' })).toEqual({
      kind: 'url', value: 'http://127.0.0.1:5173/', trusted: 'http://127.0.0.1:5173'
    })
    expect(selectRendererTarget({ directory: '/app/dist', isPackaged: false, developmentServer: 'http://[::1]:5173' }).kind).toBe('url')
  })

  it('allows only the exact packaged file or trusted loopback origin to navigate', () => {
    expect(isTrustedRendererUrl('file:///app/dist/index.html', 'file:///app/dist/index.html')).toBe(true)
    expect(isTrustedRendererUrl('file:///app/dist/index.html?view=work&section=sessions', 'file:///app/dist/index.html')).toBe(true)
    expect(isTrustedRendererUrl('file:///tmp/evil.html', 'file:///app/dist/index.html')).toBe(false)
    expect(isTrustedRendererUrl('file:///app/dist/index.html#untrusted', 'file:///app/dist/index.html')).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:5173/assets/main.js', 'http://localhost:5173')).toBe(true)
    expect(isTrustedRendererUrl('http://evil.example/', 'http://localhost:5173')).toBe(false)
  })

  it('fails closed before touching token storage for untrusted or non-top-level IPC senders', () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipc = { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) }) }
    const store = { get: vi.fn(() => 'secret'), set: vi.fn(), reset: vi.fn() }
    registerGatewayTokenIpc(store as never, 'http://localhost:5173', ipc as never)
    const mainFrame = { url: 'https://evil.example/' }
    const event = { senderFrame: mainFrame, sender: { mainFrame } }

    expect(handlers.get(CHANNELS.get)?.(event)).toEqual({ ok: false, error: 'untrusted-renderer' })
    expect(store.get).not.toHaveBeenCalled()

    const childFrame = { url: 'http://localhost:5173/' }
    handlers.get(CHANNELS.reset)?.({ senderFrame: childFrame, sender: { mainFrame: { url: childFrame.url } }, returnValue: undefined })
    expect(store.reset).not.toHaveBeenCalled()
  })

  it('allows exact trusted top-level senders and reports malformed payloads accurately', () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipc = { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) } }
    const store = { get: vi.fn(() => 'secret'), set: vi.fn(), reset: vi.fn() }
    registerGatewayTokenIpc(store as never, 'file:///app/dist/index.html', ipc as never)
    const frame = { url: 'file:///app/dist/index.html' }
    const event = { senderFrame: frame, sender: { mainFrame: frame } }

    expect(handlers.get(CHANNELS.get)?.(event)).toEqual({ ok: true, value: 'secret' })
    expect(store.get).toHaveBeenCalledOnce()

    frame.url = 'file:///app/dist/index.html?view=work&section=sessions'
    expect(handlers.get(CHANNELS.get)?.(event)).toEqual({ ok: true, value: 'secret' })

    expect(handlers.get(CHANNELS.set)?.(event, '')).toEqual({ ok: false, error: 'invalid-request' })
    expect(store.set).not.toHaveBeenCalled()
  })
})
