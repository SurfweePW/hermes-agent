import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('production content security policy', () => {
  it('locks executable and embedding sources while allowing configurable private gateways', () => {
    const html = readFileSync(`${process.cwd()}/index.html`, 'utf8')
    const policy = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1]

    expect(policy).toBeTruthy()
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("style-src 'self'")
    expect(policy).toContain('connect-src http: https: ws: wss:')
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("frame-src 'none'")
    expect(policy).toContain("base-uri 'none'")
    expect(policy).toContain("form-action 'none'")
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*/i)
  })
})