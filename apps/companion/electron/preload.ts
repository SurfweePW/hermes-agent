import { contextBridge, ipcRenderer } from 'electron'

export { CHANNELS } from './channels'
import { CHANNELS } from './channels'

type IpcRendererAdapter = Pick<typeof ipcRenderer, 'invoke'>
type NativeResponse = { ok: true; value?: string } | { ok: false; error: 'secure-storage-unavailable' | 'invalid-request' | 'untrusted-renderer' }

function parseResponse(response: unknown, expectsValue = false): string | undefined {
  if (!response || typeof response !== 'object' || !('ok' in response)) {
    throw new Error('Companion secure storage returned an invalid response.')
  }

  const candidate = response as Partial<NativeResponse>

  if (candidate.ok !== true) {
    const error = (candidate as { error?: unknown }).error

    if (error === 'invalid-request') { throw new Error('Companion secure storage rejected the request.') }

    if (error === 'untrusted-renderer') { throw new Error('Companion secure storage denied access.') }
    throw new Error('Companion secure storage is unavailable.')
  }

  if (expectsValue && candidate.value !== undefined && typeof candidate.value !== 'string') {
    throw new Error('Companion secure storage returned an invalid response.')
  }

  return candidate.value
}

export function createGatewayTokenBridge(renderer: IpcRendererAdapter) {
  return Object.freeze({
    async get(): Promise<string | undefined> {
      return parseResponse(await renderer.invoke(CHANNELS.get), true)
    },
    async set(token: string): Promise<void> {
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error('A gateway token is required.')
      }

      parseResponse(await renderer.invoke(CHANNELS.set, token))
    },
    async reset(): Promise<void> {
      parseResponse(await renderer.invoke(CHANNELS.reset))
    }
  })
}

contextBridge.exposeInMainWorld('hermesCompanion', Object.freeze({
  gatewayToken: createGatewayTokenBridge(ipcRenderer)
}))
