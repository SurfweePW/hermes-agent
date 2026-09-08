export interface CompanionOriginalRoute {
  verified: true
  client: 'hermes-desktop'
  platform: 'macos'
  url: string
}

const malformed = (): never => {
  throw new Error('Malformed companion.sessions.history response.')
}

/** Accept only the native Desktop route bound to the requested session identity. */
export function validateOriginalRoute(
  value: unknown,
  profile: string,
  sessionId: string
): CompanionOriginalRoute | undefined {
  if (value === undefined || value === null) {return undefined}

  if (typeof value !== 'object' || Array.isArray(value)) {return malformed()}
  const candidate = value as Record<string, unknown>

  if (candidate.verified !== true
    || candidate.client !== 'hermes-desktop'
    || candidate.platform !== 'macos'
    || typeof candidate.url !== 'string') {return malformed()}

  let url: URL

  try {url = new URL(candidate.url)} catch {return malformed()}

  const expectedPath = `/${encodeURIComponent(sessionId)}`

  if (url.protocol !== 'hermes:'
    || url.hostname !== 'session'
    || url.pathname !== expectedPath
    || url.username
    || url.password
    || url.hash
    || url.searchParams.size !== 1
    || url.searchParams.get('profile') !== profile) {return malformed()}

  return {
    verified: true,
    client: 'hermes-desktop',
    platform: 'macos',
    url: candidate.url
  }
}

/** Ask the macOS Electron host to open the route; browser and Android never fall back to navigation. */
export function hasOriginalRouteCapability(): boolean {
  return typeof window !== 'undefined' && typeof window.hermesCompanion?.openOriginalRoute === 'function'
}

export async function openOriginalRoute(route: CompanionOriginalRoute, profile: string, sessionId: string): Promise<void> {
  const opener = typeof window === 'undefined' ? undefined : window.hermesCompanion?.openOriginalRoute

  if (!opener) { throw new Error('native-open-unavailable') }
  await opener({ route, profile, sessionId })
}
