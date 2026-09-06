import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { app, BrowserWindow, type BrowserWindowConstructorOptions, ipcMain, type IpcMainInvokeEvent, protocol, safeStorage, shell } from 'electron'

import { CHANNELS } from './channels'
import { OwnerAuth } from './owner-auth'
import { registerOwnerIpc } from './owner-ipc'
import { GatewayTokenStore } from './secure-store'

export const APP_ID = 'com.hermes.companion'
export const PRODUCT_NAME = 'Hermes Companion'
export const PROTOCOL = 'hermes-companion'
export const USER_DATA_DIRECTORY = 'Hermes Companion'
export const DEVELOPMENT_USER_DATA_DIRECTORY = 'Hermes Companion Development'

export function userDataDirectory(isPackaged: boolean): string {
  return isPackaged ? USER_DATA_DIRECTORY : DEVELOPMENT_USER_DATA_DIRECTORY
}

protocol.registerSchemesAsPrivileged([{
  scheme: PROTOCOL,
  privileges: { secure: true, standard: true }
}])

export function browserWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    width: 1220,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    show: true,
    title: PRODUCT_NAME,
    backgroundColor: '#f5f3ed',
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      webSecurity: true
    }
  }
}

function isNoPayload(payload: unknown[]): boolean {
  return payload.length === 0
}

type GatewayTokenIpc = Pick<typeof ipcMain, 'handle'>

export interface RendererTarget {
  kind: 'file' | 'url'
  value: string
  trusted: string
}

export function selectRendererTarget({ directory, isPackaged, developmentServer }: {
  directory: string
  isPackaged: boolean
  developmentServer?: string
}): RendererTarget {
  const file = join(directory, 'web', 'index.html')
  const bundled = { kind: 'file' as const, value: file, trusted: pathToFileURL(file).href }

  if (isPackaged || !developmentServer) { return bundled }

  try {
    const url = new URL(developmentServer)
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    const rootOnly = url.pathname === '/' && !url.search && !url.hash

    if (url.protocol !== 'http:' || !loopback || !rootOnly || url.username || url.password) { return bundled }

    return { kind: 'url', value: `${url.origin}/`, trusted: url.origin }
  } catch {
    return bundled
  }
}

export function isTrustedRendererUrl(candidate: string, trustedRenderer: string): boolean {
  try {
    const frameUrl = new URL(candidate)

    return trustedRenderer.startsWith('http://')
      ? frameUrl.origin === trustedRenderer
      : frameUrl.href === trustedRenderer
  } catch {
    return false
  }
}

function isTrustedSender(event: IpcMainInvokeEvent, trustedRenderer: string): boolean {
  const frame = event.senderFrame

  return Boolean(
    frame
    && frame === event.sender.mainFrame
    && typeof frame.url === 'string'
    && isTrustedRendererUrl(frame.url, trustedRenderer)
  )
}

function fail(error: 'invalid-request' | 'untrusted-renderer') {
  return { ok: false as const, error }
}

function respond(operation: () => string | undefined | void) {
  try {
    const value = operation()

    return value === undefined ? { ok: true as const } : { ok: true as const, value }
  } catch {
    return { ok: false as const, error: 'secure-storage-unavailable' as const }
  }
}

export function registerGatewayTokenIpc(store: GatewayTokenStore, trustedRenderer: string, ipc: GatewayTokenIpc = ipcMain): void {
  ipc.handle(CHANNELS.get, (event, ...payload) => {
    if (!isTrustedSender(event, trustedRenderer)) { return fail('untrusted-renderer') }

    if (!isNoPayload(payload)) { return fail('invalid-request') }

    return respond(() => store.get())
  })
  ipc.handle(CHANNELS.set, (event, ...payload) => {
    if (!isTrustedSender(event, trustedRenderer)) { return fail('untrusted-renderer') }

    if (payload.length !== 1 || typeof payload[0] !== 'string' || payload[0].length === 0) {
      return fail('invalid-request')
    }

    return respond(() => store.set(payload[0]))
  })
  ipc.handle(CHANNELS.reset, (event, ...payload) => {
    if (!isTrustedSender(event, trustedRenderer)) { return fail('untrusted-renderer') }

    if (!isNoPayload(payload)) { return fail('invalid-request') }

    return respond(() => store.reset())
  })
}

export function createCompanionWindow(target?: RendererTarget): BrowserWindow {
  const directory = dirname(fileURLToPath(import.meta.url))
  const window = new BrowserWindow(browserWindowOptions(join(directory, 'electron-preload.cjs')))

  const rendererTarget = target ?? selectRendererTarget({
    directory,
    isPackaged: app.isPackaged,
    developmentServer: process.env.HERMES_COMPANION_DEV_SERVER
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererTarget.trusted)) { event.preventDefault() }
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())

  if (rendererTarget.kind === 'url') {
    void window.loadURL(rendererTarget.value)
  } else {
    void window.loadFile(rendererTarget.value)
  }

  return window
}

if (app?.whenReady) {
  app.setName(PRODUCT_NAME)
  // A source/dev build has a different Electron code identity from the
  // packaged Companion. Never let it decrypt the packaged app's Keychain
  // ciphertext: macOS can otherwise stack password prompts on every reload.
  app.setPath('userData', join(app.getPath('appData'), userDataDirectory(app.isPackaged)))

  void app.whenReady().then(() => {
    const directory = dirname(fileURLToPath(import.meta.url))

    const rendererTarget = selectRendererTarget({
      directory,
      isPackaged: app.isPackaged,
      developmentServer: process.env.HERMES_COMPANION_DEV_SERVER
    })

    app.setAsDefaultProtocolClient(PROTOCOL)
    registerGatewayTokenIpc(new GatewayTokenStore(app.getPath('userData'), safeStorage), rendererTarget.trusted)

    const owner = new OwnerAuth(new GatewayTokenStore(app.getPath('userData'), safeStorage, 'owner-session.encrypted'),
      (url) => shell.openExternal(url))

    let ownerWindow: BrowserWindow | undefined

    const openWindow = () => {
      const window = createCompanionWindow(rendererTarget)
      ownerWindow = window
      window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) { owner.cancel() }
      })
      window.webContents.on('render-process-gone', () => owner.cancel())
      window.on('closed', () => {
        owner.cancel()

        if (ownerWindow === window) { ownerWindow = undefined }
      })
    }

    registerOwnerIpc(owner, ipcMain, () => ownerWindow && !ownerWindow.isDestroyed()
      ? { contents: ownerWindow.webContents, url: rendererTarget.kind === 'url' ? rendererTarget.value : rendererTarget.trusted }
      : undefined)
    app.on('before-quit', () => owner.cancel())
    openWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) { openWindow() }
    })
  })

  app.on('window-all-closed', () => app.quit())
}
