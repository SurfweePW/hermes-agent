import { createServer } from 'node:http'
import { type AddressInfo, isIP } from 'node:net'

import {
  buildNativeAuthorizeUrl, generatePkcePair, generateState, nativeRefreshUrl,
  type NativeTokenSet, nativeTokenUrl, parseTokenResponse, statusSupportsNativeFlow,
  tokenNeedsRefresh
} from '../../desktop/electron/native-oauth'

import { type GatewayTokenStore, SecureStorageError } from './secure-store'

export interface OwnerStatus { signedIn: boolean; baseUrl?: string }
interface OwnerSession { baseUrl: string; tokens: NativeTokenSet }
export class OwnerAuthError extends Error {}
const error = (code: string) => new OwnerAuthError(code)

/** Owner credentials may cross cleartext only to the literal loopback interface. */
export function ownerBaseUrl(input: string): string {
  try {
    if (typeof input !== 'string' || input.length > 2048 || input !== input.trim() || /[\\\s]/.test(input)) { throw 0 }
    const url = new URL(input)
    const host = url.hostname.replace(/^\[|\]$/g, '')

    const loopback = host === 'localhost' || host === '::1'
      || (isIP(host) === 4 && host.split('.')[0] === '127')

    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) { throw 0 }

    if (url.username || url.password || url.search || url.hash || !url.hostname) { throw 0 }
    // Reject ambiguous path normalization rather than allowing URL() to erase it.
    const rawPath = input.replace(/^[a-z]+:\/\/[^/]+/i, '')

    if (!/^[a-zA-Z0-9_\-/]*$/.test(rawPath) || rawPath.includes('//')) { throw 0 }

    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch { throw error('invalid-gateway-url') }
}

type JsonRequest = (url: string, body: unknown | undefined, signal: AbortSignal, bearer?: string) => Promise<unknown>

/** Node fetch uses no Electron/browser cookie jar; redirects never carry a bearer elsewhere. */
export const ownerJsonRequest: JsonRequest = async (url, body, signal, bearer) => {
  const timeout = AbortSignal.timeout(15_000)
  const combined = AbortSignal.any([signal, timeout])

  try {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', credentials: 'omit',
      signal: combined,
      headers: { 'Accept': 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })

    if (response.status === 401 || response.status === 403) { throw error('owner-auth-required') }

    if (!response.ok) { throw error('owner-auth-failed') }
    // Bound untrusted gateway responses, including streamed bodies without Content-Length.
    const reader = response.body?.getReader()

    if (!reader) { throw error('owner-auth-failed') }
    let size = 0
    const chunks: Uint8Array[] = []

    try {
      for (;;) {
        const item = await reader.read()

        if (item.done) { break }
        size += item.value.length

        if (size > 64 * 1024) { await reader.cancel(); throw error('owner-auth-failed') }
        chunks.push(item.value)
      }
    } finally { reader.releaseLock() }

    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (cause) {
    if (signal.aborted) { throw signal.reason }

    if (timeout.aborted) { throw error('owner-auth-timeout') }
    throw cause instanceof OwnerAuthError ? cause : error('owner-auth-failed')
  }
}

/** RFC8252 I/O wrapper; share desktop PKCE/token helpers, add abort and exact callback binding. */
export async function ownerBrowserLogin(baseUrl: string, openExternal: (url: string) => Promise<void>, request: JsonRequest, signal: AbortSignal): Promise<NativeTokenSet> {
  const { verifier, challenge } = generatePkcePair()
  const state = generateState()

  const code = await new Promise<string>((resolve, reject) => {
    let settled = false
    let redirectUri = ''

    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Content-Security-Policy', "default-src 'none'")

      if (!req.url?.startsWith('/callback?') || req.url.length > 8192) {
        res.writeHead(400); res.end('Invalid callback.');

 return
      }

      const callback = new URL(req.url, 'http://127.0.0.1')
      const expected = redirectUri ? new URL(redirectUri) : undefined

      if (settled || req.method !== 'GET' || req.headers.host !== expected?.host || callback.pathname !== '/callback'
        || !req.url?.startsWith('/callback?') || callback.searchParams.getAll('state').length !== 1
        || callback.searchParams.get('state') !== state) {
        res.writeHead(400); res.end('Invalid callback.');

 return
      }

      const codes = callback.searchParams.getAll('code')

      if (callback.searchParams.has('error') || codes.length !== 1 || !codes[0] || codes[0].length > 4096) {
        res.writeHead(400); res.end('Sign-in failed.'); finish(error('owner-auth-failed'));

 return
      }

      res.writeHead(200); res.end('Return to Hermes Companion to finish signing in. You may close this tab.')
      finish(undefined, codes[0])
    })

    server.requestTimeout = 5000
    server.headersTimeout = 5000

    const cleanup = () => {
      signal.removeEventListener('abort', abort)
      server.close()
      server.closeAllConnections()
    }

    const finish = (cause?: unknown, value?: string) => {
      if (settled) { return }
      settled = true
      cleanup()

      if (cause) { reject(cause) } else { resolve(value!) }
    }

    const abort = () => finish(signal.reason ?? error('owner-auth-cancelled'))
    signal.addEventListener('abort', abort, { once: true })

    if (signal.aborted) { abort();

 return }

    server.on('error', () => finish(error('owner-auth-failed')))
    server.listen(0, '127.0.0.1', () => {
      if (settled) { cleanup();

 return }

      const address = server.address() as AddressInfo
      redirectUri = `http://127.0.0.1:${address.port}/callback`
      void openExternal(buildNativeAuthorizeUrl(baseUrl, { challenge, state, redirectUri }))
        .catch(() => finish(error('owner-auth-failed')))
    })
  })

  signal.throwIfAborted()

  return checkedTokens(await request(nativeTokenUrl(baseUrl), { code, code_verifier: verifier }, signal))
}

function checkedTokens(body: unknown): NativeTokenSet {
  const candidate = body as Record<string, unknown> | null

  if (!candidate || typeof candidate.access_token !== 'string' || !candidate.access_token
    || typeof candidate.refresh_token !== 'string' || typeof candidate.provider !== 'string'
    || typeof candidate.user_id !== 'string' || !candidate.user_id
    || typeof candidate.expires_at !== 'number' || !Number.isFinite(candidate.expires_at)
    || /[\r\n]/.test(candidate.access_token)) { throw error('owner-auth-failed') }

  return parseTokenResponse(candidate)
}

export function ownerErrorCode(cause: unknown): string {
  if (cause instanceof SecureStorageError) { return 'secure-storage-unavailable' }

  return cause instanceof OwnerAuthError ? cause.message : 'owner-auth-failed'
}

export class OwnerAuth {
  private lifetime = new AbortController()
  private pending?: AbortController
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly store: Pick<GatewayTokenStore, 'get' | 'set' | 'reset'>,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly request: JsonRequest = ownerJsonRequest,
    private readonly loginTimeoutMs = 5 * 60_000) {}

  private load(): OwnerSession | undefined {
    const raw = this.store.get()

    if (!raw) { return undefined }

    try {
      const saved = JSON.parse(raw) as OwnerSession
      const tokens = saved.tokens

      return { baseUrl: ownerBaseUrl(saved.baseUrl), tokens: checkedTokens({ access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken, expires_at: tokens.expiresAt, provider: tokens.provider, user_id: tokens.userId }) }
    } catch { throw new SecureStorageError() }
  }

  ownerStatus(input: { baseUrl: string }): OwnerStatus {
    const baseUrl = ownerBaseUrl(input.baseUrl)
    const session = this.load()

    return session?.baseUrl === baseUrl ? { signedIn: true, baseUrl: session.baseUrl } : { signedIn: false }
  }

  cancel(): void {
    this.pending?.abort(error('owner-auth-cancelled'))
    this.lifetime.abort(error('owner-auth-cancelled'))
    this.lifetime = new AbortController()
  }

  ownerSignOut(input: { baseUrl: string }): void {
    const baseUrl = ownerBaseUrl(input.baseUrl)
    this.cancel()

    try {
      const session = this.load()

      if (!session || session.baseUrl === baseUrl) { this.store.reset() }
    } catch (cause) {
      // Sign-out is also the recovery path for unreadable encrypted state.
      if (!(cause instanceof SecureStorageError)) { throw cause }
      this.store.reset()
    }
  }

  async ownerSignIn(input: { baseUrl: string }): Promise<OwnerStatus> {
    const baseUrl = ownerBaseUrl(input.baseUrl)
    this.cancel()
    const pending = new AbortController()
    this.pending = pending
    const timer = setTimeout(() => pending.abort(error('owner-auth-timeout')), this.loginTimeoutMs)
    const signal = AbortSignal.any([pending.signal, this.lifetime.signal])

    try {
      // Fail closed on corrupt/unavailable encryption before opening a browser.
      this.load()
      const status = await this.request(`${baseUrl}/api/status`, undefined, signal)
      signal.throwIfAborted()

      if (!statusSupportsNativeFlow(status)) { throw error('owner-auth-setup-required') }
      const tokens = await ownerBrowserLogin(baseUrl, this.openExternal, this.request, signal)
      signal.throwIfAborted()
      await this.ticket({ baseUrl, tokens }, signal)
      signal.throwIfAborted()
      this.store.set(JSON.stringify({ baseUrl, tokens }))

      return { signedIn: true, baseUrl }
    } finally {
      clearTimeout(timer)

      if (this.pending === pending) { this.pending = undefined }
    }
  }

  private async ticket(session: OwnerSession, signal: AbortSignal): Promise<string> {
    const result = await this.request(`${session.baseUrl}/api/auth/ws-ticket`, {}, signal, session.tokens.accessToken)
    signal.throwIfAborted()
    const ticket = (result as { ticket?: unknown } | null)?.ticket

    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{16,4096}$/.test(ticket)) { throw error('owner-auth-failed') }

    return ticket
  }

  ownerWebSocketUrl(input: { baseUrl: string }): Promise<string> {
    const baseUrl = ownerBaseUrl(input.baseUrl)
    const signal = this.lifetime.signal

    // Rotating refresh tokens must never be redeemed concurrently.
    const operation = this.queue.catch(() => undefined).then(async () => {
      signal.throwIfAborted()

      if (this.pending) { throw error('owner-auth-required') }
      const session = this.load()

      if (!session || session.baseUrl !== baseUrl) { throw error('owner-auth-required') }

      if (tokenNeedsRefresh(session.tokens, Date.now() / 1000)) {
        if (!session.tokens.refreshToken) { throw error('owner-auth-required') }
        session.tokens = checkedTokens(await this.request(nativeRefreshUrl(baseUrl), {
          refresh_token: session.tokens.refreshToken, provider: session.tokens.provider
        }, signal))
        signal.throwIfAborted()
        // Persist a rotated refresh token immediately; keeping the consumed token loses the session.
        this.store.set(JSON.stringify(session))
      }

      const ticket = await this.ticket(session, signal)
      const url = new URL(baseUrl)
      const path = url.pathname.replace(/\/+$/, '')
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.pathname = `${path}/api/ws`
      url.search = new URLSearchParams({ ticket }).toString()

      return url.toString()
    })

    this.queue = operation

    return operation
  }
}
