import { describe, expect, it, vi } from 'vitest'

import { hasOriginalRouteCapability, openOriginalRoute, validateOriginalRoute } from './original-route'

const route = {
  verified: true,
  client: 'hermes-desktop',
  platform: 'macos',
  url: 'hermes://session/stored-1?profile=atlas'
} as const

describe('validateOriginalRoute', () => {
  it('accepts the verified Desktop route bound to the requested identity', () => {
    expect(validateOriginalRoute(route, 'atlas', 'stored-1')).toEqual(route)
  })

  it.each([
    { ...route, verified: false },
    { ...route, client: 'browser' },
    { ...route, platform: 'android' },
    { ...route, url: 'https://attacker.invalid/session' },
    { ...route, url: 'hermes://session/other?profile=atlas' },
    { ...route, url: 'hermes://session/stored-1?profile=mentor' },
    { ...route, url: 'hermes://session/stored-1?profile=atlas&extra=true' },
    { ...route, url: 'hermes://session/stored-1?profile=atlas#fragment' }
  ])('rejects an unverified, unsupported, or identity-mismatched route', (candidate) => {
    expect(() => validateOriginalRoute(candidate, 'atlas', 'stored-1')).toThrow(/Malformed companion\.sessions\.history response/)
  })

  it('allows a history response to omit the optional route', () => {
    expect(validateOriginalRoute(undefined, 'atlas', 'stored-1')).toBeUndefined()
  })
})

describe('openOriginalRoute', () => {
  it('reports the capability only when the macOS Electron preload exposes it', () => {
    const original = window.hermesCompanion

    try {
      delete window.hermesCompanion
      expect(hasOriginalRouteCapability()).toBe(false)

      window.hermesCompanion = { gatewayToken: {} as never }
      expect(hasOriginalRouteCapability()).toBe(false)

      window.hermesCompanion = { gatewayToken: {} as never, openOriginalRoute: vi.fn() }
      expect(hasOriginalRouteCapability()).toBe(true)
    } finally {
      if (original) { window.hermesCompanion = original } else { delete window.hermesCompanion }
    }
  })

  it('uses only the Electron preload capability with the exact session identity', async () => {
    const original = window.hermesCompanion
    const open = vi.fn(async () => undefined)
    window.hermesCompanion = { gatewayToken: {} as never, openOriginalRoute: open }

    try {
      await openOriginalRoute(route, 'atlas', 'stored-1')
      expect(open).toHaveBeenCalledWith({ route, profile: 'atlas', sessionId: 'stored-1' })
    } finally {
      if (original) { window.hermesCompanion = original } else { delete window.hermesCompanion }
    }
  })

  it('fails explicitly instead of silently no-oping when the native capability is absent', async () => {
    const original = window.hermesCompanion
    delete window.hermesCompanion

    try {
      await expect(openOriginalRoute(route, 'atlas', 'stored-1')).rejects.toThrow('native-open-unavailable')
    } finally {
      if (original) { window.hermesCompanion = original }
    }
  })
})
