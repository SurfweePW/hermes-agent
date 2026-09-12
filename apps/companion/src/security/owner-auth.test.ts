import { describe, expect, it, vi } from 'vitest'

import { createSecureOwnerSignOut } from './owner-auth'

describe('secure owner sign-out', () => {
  it('revokes transport and clears identity state even when remote sign-out fails', async () => {
    const bridge = { ownerSignOut: vi.fn().mockRejectedValue(new Error('offline')) }
    const revokeGatewayAccess = vi.fn().mockResolvedValue(undefined)
    const clearHistory = vi.fn(() => {throw new Error('local history failure')})
    const clearCache = vi.fn()
    const clearDrafts = vi.fn()
    const signOut = createSecureOwnerSignOut({
      bridge,
      baseUrl: 'https://gateway.ts.net',
      revokeGatewayAccess,
      clearHistory,
      clearCache,
      clearDrafts
    })

    await expect(signOut()).rejects.toThrow('owner-sign-out-incomplete')
    await expect(signOut()).rejects.toThrow('owner-sign-out-incomplete')

    expect(bridge.ownerSignOut).toHaveBeenCalledOnce()
    expect(revokeGatewayAccess).toHaveBeenCalledOnce()
    expect(clearHistory).toHaveBeenCalledOnce()
    expect(clearCache).toHaveBeenCalledOnce()
    expect(clearDrafts).toHaveBeenCalledOnce()
  })
})