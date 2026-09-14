import { readFileSync } from 'node:fs'

import { render } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(`${process.cwd()}/src/styles/app.css`, 'utf8')
const tokensCss = readFileSync(`${process.cwd()}/src/styles/tokens.css`, 'utf8')
const appSource = readFileSync(`${process.cwd()}/src/app.tsx`, 'utf8')

const channel = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
const luminance = (hex: string) => {
  const channels = hex.slice(1).match(/.{2}/g)?.map((value) => channel(Number.parseInt(value, 16) / 255)) ?? []

  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0)
}
const contrastRatio = (foreground: string, background: string) => {
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left)

  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05)
}
const token = (name: string) => tokensCss.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{6})`, 'i'))?.[1] ?? ''

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
  it('has no deleted legacy view selector or class in application sources', () => {
    const deletedClass = ['legacy', 'panel'].join('-')

    expect(appCss).not.toContain(deletedClass)
    expect(appSource).not.toContain(deletedClass)
  })
  it('defines the approved palette exactly', () => {
    for (const [name, value] of Object.entries(approvedTokens)) {
      expect(tokensCss).toMatch(new RegExp(`${name}\\s*:\\s*${value}`, 'i'))
    }
  })

  it('enforces 48px mobile button targets, including profile and send', () => {
    expect(appCss).toMatch(/@media\s*\(max-width:\s*780px\)[\s\S]*?button\s*\{[^}]*min-width:\s*48px[^}]*min-height:\s*48px/i)
    expect(appCss).toMatch(/\.menu-button\s*\{[^}]*width:\s*(?:44|48)px[^}]*height:\s*(?:44|48)px/i)
    expect(appCss).toMatch(/\.composer\s+button\s*\{[^}]*width:\s*48px[^}]*height:\s*48px/i)
  })

  it('uses the approved light-border and restrained-shadow grammar', () => {
    expect(appCss).toContain('border: 1px solid var(--line)')
    expect(tokensCss).not.toMatch(/4px 4px 0/)
  })

  it('uses a two-column shell and reflows tablet layouts without fixed minimum content width', () => {
    expect(appCss).toMatch(/\.app-shell\s*\{[^}]*grid-template-columns:\s*286px\s+minmax\(0,\s*1fr\)/i)
    expect(appCss).toMatch(/@media\s*\(max-width:\s*1180px\)\s*and\s*\(min-width:\s*781px\)[\s\S]*?\.app-shell\s*\{[^}]*grid-template-columns:\s*225px\s+minmax\(0,\s*1fr\)/i)
    expect(appCss).not.toMatch(/\.activity-rail\s*\{/i)
  })

  it('keeps desktop navigation and conversation scrolling independent', () => {
    expect(appCss).toMatch(/\.app-shell\s*\{[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/i)
    expect(appCss).toMatch(/\.left-rail\s*\{[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/i)
    expect(appCss).toMatch(/\.rail-roster\s*\{[^}]*flex:\s*1[^}]*overflow-y:\s*auto/i)
    expect(appCss).toMatch(/\.main-content--conversation\s*\{[^}]*overflow:\s*hidden/i)
    expect(appCss).toMatch(/\.message-list\s*\{[^}]*overflow-y:\s*auto/i)
  })

  it('accounts for mobile safe areas in shell, fixed chrome, and conversation height', () => {
    expect(appCss).toMatch(/\.app-shell\s*\{[^}]*padding:\s*calc\(58px\s*\+\s*env\(safe-area-inset-top\)\)\s+0\s+env\(safe-area-inset-bottom\)/i)
    expect(appCss).toMatch(/\.mobile-header\s*\{[^}]*height:\s*calc\(58px\s*\+\s*env\(safe-area-inset-top\)\)[^}]*padding-top:\s*calc\(5px\s*\+\s*env\(safe-area-inset-top\)\)/i)
    expect(appCss).toMatch(/\.main-content\s*\{[^}]*min-height:\s*calc\(100dvh\s*-\s*58px\s*-\s*env\(safe-area-inset-top\)\s*-\s*env\(safe-area-inset-bottom\)\)/i)
    expect(appCss).toMatch(/\.main-content--conversation\s*\{[^}]*height:\s*calc\(100dvh\s*-\s*58px\s*-\s*env\(safe-area-inset-top\)\s*-\s*env\(safe-area-inset-bottom\)\)[^}]*overflow:\s*hidden/i)
    expect(appCss).toMatch(/\.mobile-drawer\s*\{[^}]*width:\s*78%[^}]*max-width:\s*320px/i)
  })

  it('keeps 390px and 412px conversation layouts fluid without viewport-width children', () => {
    expect(appCss).toMatch(/@media\s*\(max-width:\s*780px\)[\s\S]*?\.chats-screen[^}]*width:\s*100%[^}]*padding:\s*24px\s+17px\s+28px/i)
    expect(appCss).toMatch(/\.chat-history-head\s*>\s*div\s*\{[^}]*min-width:\s*0/i)
    expect(appCss).toMatch(/@media\s*\(max-width:\s*780px\)[\s\S]*?\.chat-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/i)
    expect(appCss).toMatch(/@media\s*\(max-width:\s*780px\)[\s\S]*?\.chat-session-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+14px/i)
    expect(appCss).not.toMatch(/(?:width|min-width):\s*(?:390|412)px/i)
  })

  it('uses an accessible small-text alias while preserving the approved muted token', () => {
    expect(tokensCss).toMatch(/--muted-text\s*:\s*#62665e/i)
    expect(appCss).toMatch(/\.kicker,\s*\.label\s*\{[^}]*color:\s*var\(--muted-text\)/i)
    expect(appCss).toMatch(/\.session-row time\s*\{[^}]*color:\s*var\(--muted-text\)/i)
  })

  it('keeps every used muted-text background pairing at WCAG AA contrast', () => {
    for (const background of ['--paper', '--paper2', '--white']) {
      expect(contrastRatio(token('--muted-text'), token(background))).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('computes replacement focus rings for controls whose base rule clears outlines', () => {
    const style = document.createElement('style')
    style.textContent = `:root { --blue: #4d6dff; } ${appCss.replaceAll(':focus-visible', ':focus')}`
    document.head.append(style)
    const rendered = render(createElement('div', {},
      createElement('form', { className: 'quick-task' }, createElement('select', { 'aria-label': 'quick select' }), createElement('textarea', { 'aria-label': 'quick text' })),
      createElement('div', { className: 'composer' }, createElement('textarea', { 'aria-label': 'composer text' })),
      createElement('div', { className: 'search-box' }, createElement('input', { 'aria-label': 'search text' }))
    ))
    const controls = [...rendered.container.querySelectorAll<HTMLElement>('select, textarea, input')]

    for (const control of controls) {
      control.focus()
      const computed = getComputedStyle(control)

      expect(computed.outline, control.getAttribute('aria-label') ?? control.tagName).toContain('3px solid')
    }
    rendered.unmount()
    style.remove()
  })

  it('keeps technical identifiers fluid at 390px', () => {
    expect(appCss).toMatch(/\.technical-details__body[^}]*overflow-wrap:\s*anywhere/i)
    expect(appCss).toMatch(/\.technical-details__body pre[^}]*word-break:\s*break-word/i)
    expect(appCss).not.toMatch(/(?:width|min-width):\s*390px/i)
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
