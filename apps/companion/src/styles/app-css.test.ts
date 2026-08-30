import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const appCss = readFileSync(`${process.cwd()}/src/styles/app.css`, 'utf8')
const tokensCss = readFileSync(`${process.cwd()}/src/styles/tokens.css`, 'utf8')

const approvedTokens = {
  '--ink': '#141513',
  '--muted': '#6d7169',
  '--line': '#d9dbd3',
  '--paper': '#f2f1eb',
  '--paper2': '#e9e8e1',
  '--white': '#fbfaf5',
  '--signal': '#d8ff3e',
  '--signal-ink': '#293000',
  '--blue': '#4d6dff',
  '--amber': '#ffb23f',
  '--danger': '#db4c36',
  '--ok': '#14845b',
  '--deep': '#1b1d19'
}

describe('Signal House CSS contract', () => {
  it('defines the approved palette exactly', () => {
    for (const [name, value] of Object.entries(approvedTokens)) {
      expect(tokensCss).toMatch(new RegExp(`${name}\\s*:\\s*${value}`, 'i'))
    }
  })

  it('enforces 48px mobile button targets, including profile and send', () => {
    expect(appCss).toMatch(/@media\s*\(max-width:\s*780px\)[\s\S]*?button\s*\{[^}]*min-width:\s*48px[^}]*min-height:\s*48px/i)
    expect(appCss).toMatch(/\.mobile-header\s+\.avatar--user\s*\{[^}]*width:\s*48px[^}]*height:\s*48px/i)
    expect(appCss).toMatch(/\.composer\s+button\s*\{[^}]*width:\s*48px[^}]*height:\s*48px/i)
  })

  it('uses the approved light-border and restrained-shadow grammar', () => {
    expect(appCss).toContain('border: 1px solid var(--line)')
    expect(tokensCss).not.toMatch(/4px 4px 0/)
  })

  it('reflows tablet layouts without the activity rail or fixed minimum content width', () => {
    expect(appCss).toMatch(/@media\s*\(max-width:\s*1180px\)\s*and\s*\(min-width:\s*781px\)[\s\S]*?\.app-shell\s*\{[^}]*grid-template-columns:\s*225px\s+minmax\(0,\s*1fr\)/i)
    expect(appCss).toMatch(/@media\s*\(max-width:\s*1180px\)\s*and\s*\(min-width:\s*781px\)[\s\S]*?\.activity-rail\s*\{[^}]*display:\s*none/i)
  })

  it('accounts for mobile safe areas in shell, fixed chrome, and conversation height', () => {
    expect(appCss).toMatch(/\.app-shell\s*\{[^}]*padding:\s*calc\(68px\s*\+\s*env\(safe-area-inset-top\)\)[^;}]*calc\(78px\s*\+\s*env\(safe-area-inset-bottom\)\)/i)
    expect(appCss).toMatch(/\.mobile-header\s*\{[^}]*height:\s*calc\(68px\s*\+\s*env\(safe-area-inset-top\)\)[^}]*padding-top:\s*calc\(10px\s*\+\s*env\(safe-area-inset-top\)\)/i)
    expect(appCss).toMatch(/\.main-content\s*\{[^}]*min-height:\s*calc\(100dvh\s*-\s*146px\s*-\s*env\(safe-area-inset-top\)\s*-\s*env\(safe-area-inset-bottom\)\)/i)
    expect(appCss).toMatch(/\.conversation-screen\s*\{[^}]*height:\s*calc\(100dvh\s*-\s*146px\s*-\s*env\(safe-area-inset-top\)\s*-\s*env\(safe-area-inset-bottom\)\)/i)
  })

  it('uses an accessible small-text alias while preserving the approved muted token', () => {
    expect(tokensCss).toMatch(/--muted-text\s*:\s*#62665e/i)
    expect(appCss).toMatch(/\.kicker,\s*\.label\s*\{[^}]*color:\s*var\(--muted-text\)/i)
    expect(appCss).toMatch(/\.timeline time\s*\{[^}]*color:\s*var\(--muted-text\)/i)
  })

  it('uses accessible muted text for sidebar section titles', () => {
    expect(appCss).toMatch(/\.rail-section-title\s*\{[^}]*color:\s*#858a7d/i)
    expect(appCss).not.toMatch(/\.rail-section-title\s*\{[^}]*color:\s*#7f8378/i)
  })

  it('lays out connection setup fields as readable full-width controls', () => {
    expect(appCss).toMatch(/\.recovery-card\s+form\s*\{[^}]*display:\s*grid[^}]*gap:/i)
    expect(appCss).toMatch(/\.recovery-card\s+label\s*\{[^}]*display:\s*grid[^}]*gap:/i)
    expect(appCss).toMatch(/\.recovery-card\s+input\s*\{[^}]*width:\s*100%[^}]*min-height:\s*48px/i)
  })
})
