import { describe, expect, it } from 'vitest'

import {
  buildGatewayWebSocketUrl,
  isAllowedAndroidGatewayTransport,
  parseGatewayBaseUrl,
  persistGatewayBaseUrl,
  redactGatewayUrl,
  serializeGatewayConnection
} from './connection'

describe('gateway connection configuration', () => {
  it('limits Android dogfood HTTP to literal Tailscale CGNAT addresses', () => {
    expect(isAllowedAndroidGatewayTransport(new URL('http://100.64.0.1:8642'))).toBe(true)
    expect(isAllowedAndroidGatewayTransport(new URL('http://100.127.255.254:8642'))).toBe(true)
    expect(isAllowedAndroidGatewayTransport(new URL('http://100.128.0.1:8642'))).toBe(false)
    expect(isAllowedAndroidGatewayTransport(new URL('http://192.168.1.5:8642'))).toBe(false)
    expect(isAllowedAndroidGatewayTransport(new URL('http://host.tailnet.ts.net:8642'))).toBe(false)
    expect(isAllowedAndroidGatewayTransport(new URL('https://host.tailnet.ts.net'))).toBe(true)
  })

  it.each([
    ['http://100.96.12.4:8642', 'ws://100.96.12.4:8642/api/ws?token=static-token'],
    ['https://mac-mini.tailnet.ts.net', 'wss://mac-mini.tailnet.ts.net/api/ws?token=static-token'],
    ['https://mac-mini.tailnet.ts.net/api/ws', 'wss://mac-mini.tailnet.ts.net/api/ws?token=static-token'],
    ['https://mac-mini.tailnet.ts.net/api/ws/', 'wss://mac-mini.tailnet.ts.net/api/ws?token=static-token'],
    [' https://mac-mini.tailnet.ts.net/base/ ', 'wss://mac-mini.tailnet.ts.net/base/api/ws?token=static-token']
  ])('builds the exact Hermes WebSocket URL from %s', (baseUrl, expected) => {
    expect(buildGatewayWebSocketUrl({ baseUrl, token: 'static-token' })).toBe(expected)
  })

  it.each([
    'http://localhost:8642',
    'http://127.0.0.1:8642',
    'http://[::1]:8642',
    'http://100.64.0.1:8642',
    'http://100.127.255.254:8642',
    'http://10.2.3.4:8642',
    'http://172.31.2.3:8642',
    'http://192.168.1.20:8642',
    'http://[fd7a:115c:a1e0::1]:8642',
    'https://atlass-mac-mini.tail9db2f4.ts.net'
  ])('recognizes private-looking endpoint %s', (baseUrl) => {
    expect(parseGatewayBaseUrl(baseUrl).warnings).toEqual([])
  })

  it.each(['https://gateway.example.com', 'https://fcorp.example.com'])(
    'warns, but does not block, public-looking host %s',
    (baseUrl) => {
      const result = parseGatewayBaseUrl(baseUrl)

      expect(result.baseUrl).toBe(baseUrl)
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toMatch(/does not look private/i)
    }
  )

  it.each([
    ['', /valid HTTP/i],
    ['not a URL', /valid HTTP/i],
    ['ftp://100.96.12.4', /HTTP or HTTPS/i],
    ['https://user:pass@mac-mini.ts.net', /credentials/i],
    ['https://mac-mini.ts.net/?token=secret', /authentication query/i],
    ['https://mac-mini.ts.net/?ticket=secret', /authentication query/i],
    ['https://mac-mini.ts.net/#token=secret', /fragment/i]
  ])('rejects unsafe or invalid URL %s without reflecting it', (baseUrl, message) => {
    expect(() => parseGatewayBaseUrl(baseUrl)).toThrow(message)

    try {
      parseGatewayBaseUrl(baseUrl)
    } catch (error) {
      expect(String(error)).not.toContain('secret')
      expect(String(error)).not.toContain('user:pass')
    }
  })

  it('strips non-auth query parameters from a configured base URL', () => {
    expect(parseGatewayBaseUrl('https://mac-mini.ts.net/base?mode=test').baseUrl).toBe(
      'https://mac-mini.ts.net/base'
    )
  })

  it('serializes only the normalized base URL and never the token', () => {
    const serialized = serializeGatewayConnection({
      baseUrl: ' https://mac-mini.ts.net/api/ws ',
      token: 'never-serialize-me'
    })

    expect(serialized).toEqual({ baseUrl: 'https://mac-mini.ts.net/api/ws' })
    expect(JSON.stringify(serialized)).not.toContain('never-serialize-me')
  })

  it('persists only the base URL', () => {
    const writes: Array<[string, string]> = []
    const storage = { setItem: (key: string, value: string) => writes.push([key, value]) }

    persistGatewayBaseUrl(storage, {
      baseUrl: ' https://mac-mini.ts.net ',
      token: 'never-persist-me'
    })

    expect(writes).toEqual([['hermes.companion.gatewayBaseUrl', 'https://mac-mini.ts.net']])
    expect(JSON.stringify(writes)).not.toContain('never-persist-me')
  })

  it('redacts token and ticket diagnostics without changing other parameters', () => {
    const diagnostic = redactGatewayUrl(
      'wss://mac-mini.ts.net/api/ws?mode=live&token=very-secret&ticket=also-secret'
    )

    expect(diagnostic).toBe(
      'wss://mac-mini.ts.net/api/ws?mode=live&token=%5BREDACTED%5D&ticket=%5BREDACTED%5D'
    )
    expect(diagnostic).not.toContain('very-secret')
    expect(diagnostic).not.toContain('also-secret')
  })

  it('removes URL userinfo while redacting authentication query parameters', () => {
    const diagnostic = redactGatewayUrl(
      'wss://operator:super-secret@example.com/api/ws?token=session-secret'
    )

    expect(diagnostic).toBe('wss://example.com/api/ws?token=%5BREDACTED%5D')
    expect(diagnostic).not.toContain('operator')
    expect(diagnostic).not.toContain('super-secret')
    expect(diagnostic).not.toContain('session-secret')
  })
})
