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

type OriginalRouteInput = {
  route: { verified: true; client: 'hermes-desktop'; platform: 'macos'; url: string }
  profile: string
  sessionId: string
}

export function createOriginalRouteBridge(renderer: IpcRendererAdapter) {
  return async (input: OriginalRouteInput): Promise<void> => {
    let response: { ok?: unknown; error?: unknown } | null

    try {
      response = await renderer.invoke(CHANNELS.openOriginalRoute, input) as typeof response
    } catch {
      throw new Error('open-failed')
    }

    if (response?.ok !== true) {
      const allowed = new Set(['invalid-request', 'untrusted-renderer', 'unsupported-platform', 'open-failed'])
      throw new Error(typeof response?.error === 'string' && allowed.has(response.error) ? response.error : 'open-failed')
    }
  }
}

export function createOwnerBridge(renderer: IpcRendererAdapter) {
  const codes = new Set(['invalid-request', 'untrusted-renderer', 'invalid-gateway-url', 'owner-auth-setup-required',
    'owner-auth-required', 'owner-auth-cancelled', 'owner-auth-timeout', 'owner-auth-failed', 'secure-storage-unavailable'])

  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    let response: { ok?: unknown; error?: unknown; value?: unknown } | null

    try {
      response = await renderer.invoke(channel, ...args) as typeof response
    } catch {
      throw new Error('owner-auth-failed')
    }

    if (response?.ok !== true) {
      throw new Error(typeof response?.error === 'string' && codes.has(response.error) ? response.error : 'owner-auth-failed')
    }

    return response.value
  }

  const status = (value: unknown): { signedIn: boolean; baseUrl?: string } => {
    const result = value as { signedIn?: unknown; baseUrl?: unknown } | null

    if (typeof result?.signedIn !== 'boolean' || (result.signedIn && typeof result.baseUrl !== 'string')) {
      throw new Error('owner-auth-failed')
    }

    return result.signedIn ? { signedIn: true, baseUrl: result.baseUrl as string } : { signedIn: false }
  }

  const inputBaseUrl = (input: unknown): string => {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 1 || !Object.prototype.hasOwnProperty.call(input, 'baseUrl')) {
      throw new Error('invalid-request')
    }

    const baseUrl = (input as { baseUrl?: unknown }).baseUrl

    if (typeof baseUrl !== 'string') { throw new Error('invalid-request') }

    return baseUrl
  }

  return Object.freeze({
    async ownerSignIn(input: { baseUrl: string }) {
      return status(await invoke(CHANNELS.ownerSignIn, { baseUrl: inputBaseUrl(input) }))
    },
    async ownerStatus(input: { baseUrl: string }) {
      return status(await invoke(CHANNELS.ownerStatus, { baseUrl: inputBaseUrl(input) }))
    },
    async ownerSignOut(input: { baseUrl: string }): Promise<void> {
      await invoke(CHANNELS.ownerSignOut, { baseUrl: inputBaseUrl(input) })
    },
    async ownerWebSocketUrl(input: { baseUrl: string }): Promise<string> {
      const baseUrl = inputBaseUrl(input)
      const result = await invoke(CHANNELS.ownerWebSocketUrl, { baseUrl })

      if (typeof result !== 'string') { throw new Error('owner-auth-failed') }

      try {
        const url = new URL(result)
        const expected = new URL(baseUrl)
        expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:'
        expected.pathname = `${expected.pathname.replace(/\/+$/, '')}/api/ws`

        if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash
          || url.searchParams.size !== 1 || !/^[A-Za-z0-9_-]{16,4096}$/.test(url.searchParams.get('ticket') ?? '')) {
          throw new Error('owner-auth-failed')
        }
      } catch {
        throw new Error('owner-auth-failed')
      }

      return result
    }
  })
}

contextBridge.exposeInMainWorld('hermesCompanion', Object.freeze({
  gatewayToken: createGatewayTokenBridge(ipcRenderer),
  ...(process.platform === 'darwin' ? { openOriginalRoute: createOriginalRouteBridge(ipcRenderer) } : {}),
  ...createOwnerBridge(ipcRenderer)
}))
