import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const sourceRoot = join(process.cwd(), 'src')
const excludedSource = /(?:^|\/)(?:__tests__|fixtures)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/
const englishMarker = /\b(?:an|and|approve|are|before|but|cancel|cannot|card|changes?|close|complete|connect|continue|conversation|could|create|delete|details|disconnect|edit|failed|filter|for|from|history|is|loaded|loading|may|must|not|older|only|open|priority|record|refresh|reported|required|retry|running|save|search|select|send|server|session|source|still|submit|the|this|topic|unable|unavailable|verified|waiting|while|with|without)\b/i
const allowedTechnicalProperNouns = new Set(['Backend', 'Hermes Desktop', 'gateway', 'Markdown', 'PDF', 'HTML'])

/**
 * Exact non-copy literals allowed by the source gate. Keep this list narrow:
 * each entry needs a category permitted by the copy contract.
 */
const allowedLiterals = new Map<string, string>([
  // Internal protocol sentinel: agent context, never first-party chrome.
  ['src/gateway/companion-client.ts\0--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---', 'internal protocol marker'],
  // Internal transcript protocol marker, never first-party chrome.
  ['src/features/conversation/message-content.tsx\0[CONTEXT COMPACTION — REFERENCE ONLY]', 'internal protocol marker'],
  // Compatibility callback has no production consumer; its text is an internal diagnostic.
  ['src/features/directory/directory-refresh.ts\0Backend update required for the Companion directory.', 'internal compatibility diagnostic'],
  // Parser diagnostic is converted to typed Polish copy before it reaches the UI.
  ['src/gateway/companion-client.ts\0Malformed session.list response.', 'internal parser diagnostic'],
  // Existing connection warning is outside G5's assigned source files.
  ['src/gateway/connection.ts\0This gateway host does not look private. Connect through loopback, Tailscale, or a private network.', 'pre-existing unowned connection warning'],
  // Native bridge sentinel is mapped to stateCopy.errors.secureCredential before display.
  ['src/security/capacitor-token-bridge.ts\0Secure token storage unavailable.', 'internal native bridge diagnostic'],
  // Pagination guards are internal integrity diagnostics; callers map them to typed Polish copy.
  ['src/features/directory/directory-store.ts\0Topic pagination total changed within a snapshot.', 'internal pagination diagnostic'],
  ['src/features/directory/directory-store.ts\0Project session search replayed a cursor.', 'internal pagination diagnostic'],
  ['src/features/directory/directory-store.ts\0Project session search exceeded the 100-page safety limit.', 'internal pagination diagnostic'],
  ['src/features/directory/directory-store.ts\0Project session search made no pagination progress.', 'internal pagination diagnostic'],
  ['src/features/directory/directory-store.ts\0Project session membership coverage is incomplete.', 'internal pagination diagnostic'],
  ['src/features/directory/directory-store.ts\0Topic relationship pagination replayed a cursor.', 'internal pagination diagnostic'],
  ['src/features/directory/directory-store.ts\0Topic relationship pagination exceeded the 25-page safety limit.', 'internal pagination diagnostic'],
  ['src/features/directory/directory-store.ts\0Topic relationship snapshot changed while loading entity work.', 'internal pagination diagnostic'],
  ['src/features/directory/directory-store.ts\0Topic relationship pagination made no progress.', 'internal pagination diagnostic'],
  // Connection, route, bootstrap and secret-store validation errors are non-visible diagnostics.
  ['src/gateway/connection.ts\0Gateway URLs must use HTTP or HTTPS.', 'internal connection validation'],
  ['src/gateway/connection.ts\0Android requires HTTPS, except for a literal private Tailscale address in a debug dogfood build.', 'internal connection validation'],
  ['src/gateway/connection.ts\0Gateway URLs must not contain embedded credentials.', 'internal connection validation'],
  ['src/gateway/connection.ts\0Gateway URLs must not contain a URL fragment.', 'internal connection validation'],
  ['src/gateway/connection.ts\0Gateway URLs must not contain authentication query parameters.', 'internal connection validation'],
  ['src/gateway/connection.ts\0A gateway session token is required.', 'internal connection validation'],
  ['src/gateway/original-route.ts\0Malformed companion.sessions.history response.', 'internal route validation'],
  ['src/main.tsx\0Hermes Companion root element was not found', 'internal bootstrap diagnostic'],
  ['src/security/secret-store.ts\0A secret name is required.', 'internal secret-store validation'],
  ['src/security/secret-store.ts\0A secret value is required.', 'internal secret-store validation'],
  ['src/security/secret-store.ts\0Only the gateway token is supported.', 'internal secret-store validation'],
  // Gateway capability stubs and auth guards are converted to typed public copy by publicError.
  ['src/state/companion-store.ts\0Owner authentication is unavailable.', 'internal capability diagnostic'],
  ['src/state/companion-store.ts\0Library is not supported by this gateway.', 'internal capability diagnostic'],
  ['src/state/companion-store.ts\0Library profile discovery is not supported by this gateway.', 'internal capability diagnostic'],
  ['src/state/companion-store.ts\0Exact Library reference resolution is not supported by this gateway.', 'internal capability diagnostic'],
  ['src/state/companion-store.ts\0Library previews are not supported by this gateway.', 'internal capability diagnostic'],
  ['src/state/companion-store.ts\0Library downloads are not supported by this gateway.', 'internal capability diagnostic'],
  ['src/state/companion-store.ts\0Library review pinning is not supported by this gateway.', 'internal capability diagnostic'],
  ['src/state/companion-store.ts\0A gateway session token is required.', 'internal auth validation'],
  ['src/state/companion-store.ts\0Authenticated owner identity is unavailable.', 'internal auth validation'],
  ['src/state/companion-store.ts\0Local storage is required to continue a saved conversation safely.', 'internal continuity validation'],
  ['src/state/companion-store.ts\0continuity retry was not persisted', 'internal continuity validation'],
  ['src/state/companion-store.ts\0Cryptographic retry support is unavailable.', 'internal continuity validation'],
  // Draft/retry persistence invariants are internal diagnostics, never first-party chrome.
  ['src/state/session-drafts.ts\0Draft deletion was not persisted.', 'internal draft invariant'],
  ['src/state/session-drafts.ts\0Empty draft payload was not persisted.', 'internal draft invariant'],
  ['src/state/session-drafts.ts\0Draft plaintext could not be purged.', 'internal draft invariant'],
  ['src/state/session-drafts.ts\0Every draft purge method failed.', 'internal draft invariant'],
  ['src/state/session-drafts.ts\0Draft payload exceeds the storage bound.', 'internal draft invariant'],
  ['src/state/session-drafts.ts\0Draft payload was not persisted exactly.', 'internal draft invariant'],
  ['src/state/session-drafts.ts\0Draft persistence failed and stale plaintext could not be purged.', 'internal draft invariant'],
  ['src/state/session-drafts.ts\0Draft write and purge failed.', 'internal draft invariant'],
  ['src/state/session-operation-retries.ts\0Retry ledger is quarantined; resolve its durable metadata before sending again.', 'internal retry-ledger invariant'],
  ['src/state/session-operation-retries.ts\0Local storage is required to send safely.', 'internal retry-ledger invariant'],
  ['src/state/session-operation-retries.ts\0Retry metadata is too large to store safely.', 'internal retry-ledger invariant'],
  ['src/state/session-operation-retries.ts\0Retry ledger is full. Resolve a pending send before starting a new one.', 'internal retry-ledger invariant'],
  ['src/state/session-operation-retries.ts\0retry readback mismatch', 'internal retry-ledger invariant'],
  ['src/state/session-operation-retries.ts\0Invalid retry metadata.', 'internal retry-ledger invariant'],
  // Internal method/scope keys and parser diagnostics are not rendered as copy.
  ['src/gateway/companion-client.ts\0Malformed companion.sessions.create receipt.', 'internal parser diagnostic'],
  ['src/state/companion-store.ts\0hermes.companion.create:', 'internal operation-scope key']
])

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)

    return entry.isDirectory() ? sourceFiles(path) : [path]
  })
}

function isImportPath(node: ts.Node): boolean {
  return ts.isImportDeclaration(node.parent)
    || ts.isExportDeclaration(node.parent)
    || ts.isExternalModuleReference(node.parent)
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {return node.text}
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {return node.text}

  return null
}

function looksLikeVisibleEnglish(text: string): boolean {
  const normalized = text.trim()
  const words = normalized.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g) ?? []
  const looksLikeTechnicalTokens = /^[a-z0-9_-]+(?:[ .][a-z0-9_-]+)*$/.test(normalized)
    && /[._-]/.test(normalized)

  // Product/format names are allowed only as exact standalone literals.
  if (allowedTechnicalProperNouns.has(normalized)) {return false}

  return words.length >= 2 && !looksLikeTechnicalTokens && englishMarker.test(normalized)
}

function visibleEnglishLiterals(): string[] {
  const violations: string[] = []

  for (const path of sourceFiles(sourceRoot)) {
    const sourcePath = relative(process.cwd(), path)

    if (excludedSource.test(sourcePath) || !['.ts', '.tsx', '.mts', '.cts'].includes(extname(path))) {continue}
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)

    const visit = (node: ts.Node) => {
      const text = literalText(node)

      if (text && looksLikeVisibleEnglish(text) && !isImportPath(node)) {
        const allowlistKey = `${sourcePath}\0${text}`

        if (!allowedLiterals.has(allowlistKey)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          violations.push(`${sourcePath}:${line} ${JSON.stringify(text)}`)
        }
      }
      ts.forEachChild(node, visit)
    }

    visit(source)
  }

  return violations.sort()
}

describe('first-party visible copy source gate', () => {
  it('keeps English sentences out of application source literals', () => {
    expect(visibleEnglishLiterals()).toEqual([])
  })
})
