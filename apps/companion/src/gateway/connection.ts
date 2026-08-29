import { buildHermesWebSocketUrl } from '@hermes/shared'

export const GATEWAY_BASE_URL_STORAGE_KEY = 'hermes.companion.gatewayBaseUrl'

const AUTH_QUERY_PARAMETERS = new Set(['token', 'ticket'])

const PUBLIC_HOST_WARNING =
  'This gateway host does not look private. Connect through loopback, Tailscale, or a private network.'

export interface GatewayConnectionInput {
  baseUrl: string
  token: string
}

export interface GatewayBaseUrlConfiguration {
  baseUrl: string
  warnings: string[]
}

export interface BaseUrlStorage {
  setItem(key: string, value: string): void
}

function invalidUrl(message = 'Enter a valid HTTP(S) gateway URL.'): Error {
  return new Error(message)
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.')

  if (parts.length !== 4) {
    return null
  }

  const octets = parts.map(Number)

  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null
}

function isPrivateIpv4(octets: number[]): boolean {
  const [first, second] = octets

  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127)
  )
}

function isPrivateLookingHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname).toLowerCase().replace(/\.$/, '')
  const ipv4 = parseIpv4(host)

  if (ipv4) {
    return isPrivateIpv4(ipv4)
  }

  if (host === '::1' || (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd')))) {
    return true
  }

  return host === 'localhost' || host.endsWith('.localhost') || host === 'ts.net' || host.endsWith('.ts.net')
}

function normalizedPathname(pathname: string): string {
  if (pathname === '/') {
    return ''
  }

  return pathname.replace(/\/+$/, '')
}

export function parseGatewayBaseUrl(input: string): GatewayBaseUrlConfiguration {
  const candidate = input.trim()

  if (!candidate) {
    throw invalidUrl()
  }

  let url: URL

  try {
    url = new URL(candidate)
  } catch {
    throw invalidUrl()
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidUrl('Gateway URLs must use HTTP or HTTPS.')
  }

  if (!url.hostname) {
    throw invalidUrl()
  }

  if (url.username || url.password) {
    throw invalidUrl('Gateway URLs must not contain embedded credentials.')
  }

  if (url.hash) {
    throw invalidUrl('Gateway URLs must not contain a URL fragment.')
  }

  for (const name of url.searchParams.keys()) {
    if (AUTH_QUERY_PARAMETERS.has(name.toLowerCase())) {
      throw invalidUrl('Gateway URLs must not contain authentication query parameters.')
    }
  }

  const baseUrl = `${url.protocol}//${url.host}${normalizedPathname(url.pathname)}`
  const warnings = isPrivateLookingHost(url.hostname) ? [] : [PUBLIC_HOST_WARNING]

  return { baseUrl, warnings }
}

function splitEndpointPath(pathname: string): { basePath: string; path: string } {
  const normalized = normalizedPathname(pathname)

  if (normalized.toLowerCase().endsWith('/api/ws')) {
    return { basePath: normalized.slice(0, -'/api/ws'.length), path: '/api/ws' }
  }

  return { basePath: normalized, path: '/api/ws' }
}

export function buildGatewayWebSocketUrl(input: GatewayConnectionInput): string {
  if (!input.token) {
    throw new Error('A gateway session token is required.')
  }

  const configuration = parseGatewayBaseUrl(input.baseUrl)
  const url = new URL(configuration.baseUrl)
  const endpoint = splitEndpointPath(url.pathname)

  return buildHermesWebSocketUrl({
    protocol: url.protocol,
    host: url.host,
    basePath: endpoint.basePath,
    path: endpoint.path,
    authParam: ['token', input.token]
  })
}

export function serializeGatewayConnection(input: GatewayConnectionInput): { baseUrl: string } {
  return { baseUrl: parseGatewayBaseUrl(input.baseUrl).baseUrl }
}

export function persistGatewayBaseUrl(storage: BaseUrlStorage, input: GatewayConnectionInput): void {
  storage.setItem(GATEWAY_BASE_URL_STORAGE_KEY, serializeGatewayConnection(input).baseUrl)
}

export function redactGatewayUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''

    for (const name of [...url.searchParams.keys()]) {
      if (AUTH_QUERY_PARAMETERS.has(name.toLowerCase())) {
        url.searchParams.set(name, '[REDACTED]')
      }
    }

    return url.toString()
  } catch {
    return value.replace(/([?&](?:token|ticket)=)[^&#]*/gi, '$1[REDACTED]')
  }
}
