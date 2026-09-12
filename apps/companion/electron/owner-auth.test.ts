// @vitest-environment node
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { OwnerAuth, ownerBaseUrl, ownerBrowserLogin, ownerJsonRequest } from './owner-auth'
import { GatewayTokenStore } from './secure-store'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) { await cleanup() } })

const tokens = () => ({ access_token: 'native-access-secret', refresh_token: 'native-refresh-secret',
  expires_at: Date.now() / 1000 + 3600, provider: 'basic', user_id: 'owner' })

function storage() {
  const directory = mkdtempSync(join(tmpdir(), 'companion-owner-test-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const key = randomBytes(32)

  const safe = { isEncryptionAvailable: () => true,
    encryptString: (text: string) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])

      return Buffer.concat([iv, cipher.getAuthTag(), data])
    },
    decryptString: (data: Buffer) => {
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
      cipher.setAuthTag(data.subarray(12, 28))

      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8')
    } }

  return { owner: new GatewayTokenStore(directory, safe, 'owner-session.encrypted'), legacy: new GatewayTokenStore(directory, safe) }
}

async function gateway() {
  const calls: { path: string; authorization?: string; body: Record<string, string> }[] = []
  let challenge = ''
  let redeemed = false
  let native = true
  let ticketIndex = 0

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []

    for await (const chunk of req) { chunks.push(Buffer.from(chunk)) }
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, string>
    calls.push({ path: req.url!, authorization: req.headers.authorization, body })
    res.setHeader('Content-Type', 'application/json')

    if (req.url === '/prefix/api/status') { res.end(JSON.stringify({ auth_flows: native ? ['native_pkce'] : [] }));

 return }

    if (req.url === '/prefix/auth/native/token') {
      const actual = createHash('sha256').update(body.code_verifier).digest('base64url')

      if (redeemed || body.code !== 'one-use-code' || actual !== challenge) { res.writeHead(400); res.end('{}');

 return }

      redeemed = true
      res.end(JSON.stringify(tokens()));

 return
    }

    if (req.url === '/prefix/auth/native/refresh') { res.end(JSON.stringify(tokens()));

 return }

    if (req.url === '/prefix/api/auth/ws-ticket' && req.headers.authorization === `Bearer ${tokens().access_token}`) {
      res.end(JSON.stringify({ ticket: `single_use_ticket_${++ticketIndex}` }));

 return
    }

    res.writeHead(401); res.end('{}')
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/prefix`
  let callback = ''

  const open = vi.fn(async (authorize: string) => {
    const url = new URL(authorize)
    expect(url.pathname).toBe('/prefix/auth/native/authorize')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    challenge = url.searchParams.get('code_challenge')!
    const redirect = url.searchParams.get('redirect_uri')!
    expect(new URL(redirect).hostname).toBe('127.0.0.1')

    // Wrong path/state/duplicates must not consume this attempt.
    for (const candidate of [redirect + '?code=bad&state=wrong', redirect.replace('/callback', '/other') + '?code=bad',
      redirect + `?code=bad&state=${url.searchParams.get('state')}&state=duplicate`]) {
      expect((await fetch(candidate)).status).toBe(400)
    }

    callback = `${redirect}?code=one-use-code&state=${url.searchParams.get('state')}`
    expect((await fetch(callback)).status).toBe(200)
  })

  return { baseUrl, open, calls, callback: () => callback, disable: () => { native = false } }
}

describe('owner gateway URL policy', () => {
  it.each(['http://127.0.0.1:8642', 'http://localhost:8642', 'http://[::1]',
    'https://10.1.2.3/prefix', 'https://172.16.0.1', 'https://192.168.1.2',
    'https://100.64.0.1', 'https://[fd12::1]', 'https://gateway.example/prefix'])('accepts %s', url => {
    expect(ownerBaseUrl(url + '/')).toBe(url)
  })
  it.each(['http://example.com', 'http://example.local', 'http://10.1.2.3/prefix', 'http://172.16.0.1',
    'http://192.168.1.2', 'http://100.64.0.1', 'http://192.168.1.1.example.com', 'http://172.32.0.1',
    'http://100.128.0.1', 'http://[fd12::1]', 'http://[2001:db8::1]', 'https://user:pass@example.com',
    'https://example.com?q=token',
    'https://example.com#x', 'https://example.com/a/../b', 'https://example.com/%2e%2e', 'file:///secret',
    'wss://example.com', ' https://example.com', 'https://example.com\\other'])('rejects %s', url => {
    expect(() => ownerBaseUrl(url)).toThrow('invalid-gateway-url')
  })
})

describe('native owner login, real loopback and HTTP path', () => {
  it('redeems PKCE once, encrypts separate credentials, returns only status and fresh tickets', async () => {
    const g = await gateway()
    const s = storage()
    s.legacy.set('legacy-agent-token')
    const auth = new OwnerAuth(s.owner, g.open)
    cleanups.push(() => auth.cancel())
    const status = await auth.ownerSignIn({ baseUrl: g.baseUrl })
    expect(status).toMatchObject({ signedIn: true, baseUrl: g.baseUrl })
    expect(status.ownerScope).toMatch(/^[a-f0-9]{64}$/)
    await expect(fetch(g.callback())).rejects.toThrow() // listener has been torn down, no replay
    expect(g.calls.filter(c => c.path.endsWith('/token'))).toHaveLength(1)
    expect(readFileSync(s.owner.filePath).toString()).not.toContain('native-access-secret')
    expect(readFileSync(s.owner.filePath).toString()).not.toContain('native-refresh-secret')
    expect(s.legacy.get()).toBe('legacy-agent-token')
    const restored = new OwnerAuth(s.owner, g.open)
    const first = await restored.ownerWebSocketUrl({ baseUrl: g.baseUrl })
    const second = await restored.ownerWebSocketUrl({ baseUrl: g.baseUrl })
    expect(first).not.toEqual(second)
    expect(first).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/prefix\/api\/ws\?ticket=single_use_ticket_\d+$/)
    expect(first).not.toContain('native-access-secret')
    expect(first).not.toContain('native-refresh-secret')
    await expect(restored.ownerWebSocketUrl({ baseUrl: 'https://other.example' })).rejects.toThrow('owner-auth-required')
    expect(g.open).toHaveBeenCalledOnce()
    restored.ownerSignOut({ baseUrl: g.baseUrl })
    expect(restored.ownerStatus({ baseUrl: g.baseUrl })).toEqual({ signedIn: false })
    expect(s.legacy.get()).toBe('legacy-agent-token')
    await expect(restored.ownerWebSocketUrl({ baseUrl: g.baseUrl })).rejects.toThrow('owner-auth-required')
  })

  it('replaces stale owner storage without decrypting it before browser launch', async () => {
    let replacementPrepared = false

    const store = {
      get: vi.fn(() => { throw new Error('stale encrypted owner session') }),
      set: vi.fn(),
      reset: vi.fn(),
      prepareReplacement: vi.fn(() => { replacementPrepared = true })
    }

    const request = vi.fn(async (url: string) => {
      if (url.endsWith('/api/status')) { return { auth_flows: ['native_pkce'] } }

      if (url.endsWith('/auth/native/token')) { return tokens() }

      return { ticket: 'single_use_ticket_1' }
    })

    const auth = new OwnerAuth(store, async input => {
      expect(replacementPrepared).toBe(true)
      const url = new URL(input)
      await fetch(`${url.searchParams.get('redirect_uri')}?code=ok&state=${url.searchParams.get('state')}`)
    }, request)

    await expect(auth.ownerSignIn({ baseUrl: 'http://127.0.0.1:8642' })).resolves.toEqual({
      signedIn: true,
      baseUrl: 'http://127.0.0.1:8642',
      ownerScope: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(store.prepareReplacement).toHaveBeenCalledOnce()
    expect(store.get).not.toHaveBeenCalled()
    expect(store.set).toHaveBeenCalledOnce()
  })

  it('shows an explicit setup gate without opening a browser or storing anything', async () => {
    const g = await gateway(); g.disable()
    const s = storage(); const auth = new OwnerAuth(s.owner, g.open)
    await expect(auth.ownerSignIn({ baseUrl: g.baseUrl })).rejects.toThrow('owner-auth-setup-required')
    expect(g.open).not.toHaveBeenCalled()
    expect(s.owner.get()).toBeUndefined()
  })

  it('cancels pending browser login on sign-out and closes its listener', async () => {
    const s = storage()
    let opened!: (value: string) => void
    const opening = new Promise<string>(resolve => { opened = resolve })
    const auth = new OwnerAuth(s.owner, async url => { opened(url) }, async () => ({ auth_flows: ['native_pkce'] }))
    const pending = auth.ownerSignIn({ baseUrl: 'http://127.0.0.1:8642' })
    const rejected = expect(pending).rejects.toThrow('owner-auth-cancelled')
    const url = new URL(await opening)
    auth.ownerSignOut({ baseUrl: 'http://127.0.0.1:8642' })
    await rejected
    await expect(fetch(url.searchParams.get('redirect_uri')!)).rejects.toThrow()
    expect(s.owner.get()).toBeUndefined()
  })

  it('times out and cleans up without writing credentials', async () => {
    const s = storage(); const open = vi.fn(async (_url: string) => {})
    const auth = new OwnerAuth(s.owner, open, async () => ({ auth_flows: ['native_pkce'] }), 30)
    await expect(auth.ownerSignIn({ baseUrl: 'http://127.0.0.1:8642' })).rejects.toThrow('owner-auth-timeout')
    const redirect = new URL(open.mock.calls[0][0] as unknown as string).searchParams.get('redirect_uri')!
    await expect(fetch(redirect)).rejects.toThrow()
    expect(s.owner.get()).toBeUndefined()
  })

  it('does not persist if sign-out races an in-flight token redemption', async () => {
    const s = storage()
    let release!: (value: unknown) => void
    let started!: () => void
    const redeemStarted = new Promise<void>(resolve => { started = resolve })

    const request = vi.fn(async (url: string) => {
      if (url.endsWith('/status')) { return { auth_flows: ['native_pkce'] } }

      if (url.endsWith('/token')) { started();

 return new Promise(resolve => { release = resolve }) }

      return { ticket: 'single_use_ticket_1' }
    })

    const auth = new OwnerAuth(s.owner, async input => {
      const url = new URL(input)
      await fetch(`${url.searchParams.get('redirect_uri')}?code=ok&state=${url.searchParams.get('state')}`)
    }, request)

    const pending = auth.ownerSignIn({ baseUrl: 'http://127.0.0.1:8642' })
    const rejected = expect(pending).rejects.toThrow('owner-auth-cancelled')
    await redeemStarted
    auth.ownerSignOut({ baseUrl: 'http://127.0.0.1:8642' }); release(tokens())
    await rejected
    expect(s.owner.get()).toBeUndefined()
  })

  it('serializes refresh rotation across simultaneous reconnect attempts', async () => {
    const g = await gateway(); const s = storage()
    s.owner.set(JSON.stringify({ baseUrl: g.baseUrl, tokens: { accessToken: 'expired', refreshToken: 'refresh',
      expiresAt: 1, provider: 'basic', userId: 'owner' } }))
    const auth = new OwnerAuth(s.owner, g.open)
    const tickets = await Promise.all([auth.ownerWebSocketUrl({ baseUrl: g.baseUrl }), auth.ownerWebSocketUrl({ baseUrl: g.baseUrl })])
    expect(tickets[0]).not.toEqual(tickets[1])
    expect(g.calls.filter(call => call.path.endsWith('/refresh'))).toHaveLength(1)
    expect(g.open).not.toHaveBeenCalled()
  })

  it('fails closed on corrupt store and allows explicit reset', async () => {
    const s = storage(); s.owner.set('not-json')
    const open = vi.fn(async () => {})
    const auth = new OwnerAuth(s.owner, open)
    expect(() => auth.ownerStatus({ baseUrl: 'http://127.0.0.1:8642' })).toThrow(/secure storage/i)
    auth.ownerSignOut({ baseUrl: 'http://127.0.0.1:8642' })
    expect(auth.ownerStatus({ baseUrl: 'http://127.0.0.1:8642' })).toEqual({ signedIn: false })
    expect(open).not.toHaveBeenCalled()
  })

  it('never persists tokens when ticket authentication fails or encrypted write fails', async () => {
    for (const storageFails of [false, true]) {
      const store = { get: () => undefined, reset: vi.fn(), set: vi.fn(() => { throw new Error('storage failure') }) }

      const request = vi.fn(async (url: string) => {
        if (url.endsWith('/status')) { return { auth_flows: ['native_pkce'] } }

        if (url.endsWith('/token')) { return tokens() }

        if (!storageFails) { throw new Error('sensitive upstream error') }

        return { ticket: 'single_use_ticket_1' }
      })

      const auth = new OwnerAuth(store, async input => {
        const url = new URL(input)
        await fetch(`${url.searchParams.get('redirect_uri')}?code=ok&state=${url.searchParams.get('state')}`)
      }, request)

      await expect(auth.ownerSignIn({ baseUrl: 'http://127.0.0.1:8642' })).rejects.toThrow()
      expect(store.set).toHaveBeenCalledTimes(storageFails ? 1 : 0)
    }
  })

  it('tears down the callback listener on browser launch failure', async () => {
    let redirect = ''
    await expect(ownerBrowserLogin('http://127.0.0.1:8642', async url => {
      redirect = new URL(url).searchParams.get('redirect_uri')!
      throw new Error('browser failed')
    }, vi.fn(), new AbortController().signal)).rejects.toThrow('owner-auth-failed')
    await expect(fetch(redirect)).rejects.toThrow()
  })

  it('does not follow HTTP redirects with credentials', async () => {
    let received = 0
    const server = createServer((_req, res) => { received++; res.writeHead(302, { Location: '/leak' }); res.end() })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/redirect`
    await expect(ownerJsonRequest(url, {}, new AbortController().signal, 'secret')).rejects.toThrow('owner-auth-failed')
    expect(received).toBe(1)
  })
})
