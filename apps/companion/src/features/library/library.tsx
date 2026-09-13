import { useEffect, useMemo, useRef, useState } from 'react'

import { TechnicalDetails } from '../../components/technical-details'
import { libraryCopy } from '../../copy/library'

import type { LibraryChunk, LibraryDetail, LibraryGateway, LibraryItem, LibraryListOptions, LibraryListResult, LibraryPreviewKind, LibraryRelationshipContext } from './library-types'

interface LibraryProps {
  params: URLSearchParams
  onNavigate(params: URLSearchParams): void
  gateway: LibraryGateway
  refreshToken?: number
  relationshipContext?: LibraryRelationshipContext
}

type LoadedPreview = { selection: string; kind: LibraryPreviewKind; text?: string; objectUrl?: string; mimeType: string; descriptor?: string; versionId?: string | null }
type LoadedDetail = { selection: string; value: LibraryDetail }

const DISPLAY_TYPES = ['markdown', 'text', 'image', 'pdf', 'html', 'unsupported'] as const

function message(error: unknown): string {
  if (error instanceof Error && error.message) {return error.message}

  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {return error.message}

  return libraryCopy.errors.request
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {bytes[index] = binary.charCodeAt(index)}

  return bytes
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function sanitizedDownloadFilename(value: string | undefined): string {
  const supplied = value || 'artifact'
  const leaf = supplied.includes('\\') ? supplied.split('\\').at(-1) ?? supplied : supplied.split('/').at(-1) ?? supplied

  const sanitized = [...leaf]
    .map((character) => {
      const code = character.charCodeAt(0)

      return code <= 0x1f || code === 0x7f ? '_' : character
    })
    .join('')
    .replace(/[\\/:?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 240)

  return sanitized || 'artifact'
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value)
}

function safeUtf8(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)

    return text.includes('\u0000') ? null : text
  } catch {
    return null
  }
}

function safeDownloadMime(filename: string, bytes: Uint8Array): string {
  const extension = filename.split('.').at(-1)?.toLowerCase() ?? ''

  if (extension === 'pdf' && startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {return 'application/pdf'}

  if (extension === 'png' && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {return 'image/png'}

  if ((extension === 'jpg' || extension === 'jpeg') && startsWith(bytes, [0xff, 0xd8, 0xff])) {return 'image/jpeg'}

  if (extension === 'gif' && (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) {return 'image/gif'}

  if (extension === 'webp' && startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {return 'image/webp'}

  if (extension === 'avif' && startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4) && (startsWith(bytes, [0x61, 0x76, 0x69, 0x66], 8) || startsWith(bytes, [0x61, 0x76, 0x69, 0x73], 8))) {return 'image/avif'}

  const text = safeUtf8(bytes)

  if (text !== null && extension === 'csv') {return 'text/csv'}

  if (text !== null && ['txt', 'log', 'text'].includes(extension)) {return 'text/plain'}

  if (text !== null && ['md', 'markdown', 'mdown', 'mkd'].includes(extension)) {return 'text/markdown'}

  if (text !== null && extension === 'json') {
    try {
      JSON.parse(text)

      return 'application/json'
    } catch {
      return 'application/octet-stream'
    }
  }

  return 'application/octet-stream'
}

async function verifySha256(bytes: Uint8Array, expected: string | undefined): Promise<void> {
  if (!expected || !/^[0-9a-f]{64}$/i.test(expected) || !globalThis.crypto?.subtle) {
    throw new Error(libraryCopy.errors.integrityUnavailable)
  }

  const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  const actual = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')

  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(libraryCopy.errors.integrityFailed)
  }
}

async function allChunks(
  request: (offset: number, descriptor?: string) => Promise<LibraryChunk>,
  maxChunkSize: number
): Promise<{ bytes: Uint8Array; first: LibraryChunk }> {
  const chunks: Uint8Array[] = []
  let offset = 0
  let first: LibraryChunk | null = null
  let expectedSize: number | undefined
  let descriptor: string | undefined

  for (let count = 0; count < 100_000; count += 1) {
    const chunk = await request(offset, descriptor)

    if (!first) {first = chunk}

    if (chunk.available === false) {return { bytes: new Uint8Array(), first: chunk }}

    if (chunk.offset !== offset || chunk.next_offset === undefined || chunk.eof === undefined || chunk.size === undefined || chunk.data_base64 === undefined || chunk.next_offset < offset || chunk.next_offset > chunk.size) {throw new Error(libraryCopy.errors.invalidChunk)}

    if (expectedSize === undefined) {expectedSize = chunk.size}

    if (chunk.size !== expectedSize) {throw new Error(libraryCopy.errors.changed)}

    if (!chunk.descriptor || (descriptor && chunk.descriptor !== descriptor)) {throw new Error(libraryCopy.errors.changed)}
    descriptor = chunk.descriptor
    const bytes = decodeBase64(chunk.data_base64)

    if (bytes.length !== chunk.next_offset - offset || bytes.length > maxChunkSize) {throw new Error(libraryCopy.errors.invalidChunk)}
    chunks.push(bytes)
    offset = chunk.next_offset

    if (chunk.eof) {
      if (offset !== expectedSize) {throw new Error(libraryCopy.errors.incompleteArtifact)}
      const combined = new Uint8Array(expectedSize)
      let target = 0

      for (const part of chunks) {combined.set(part, target); target += part.length}

      return { bytes: combined, first: first ?? chunk }
    }

    if (bytes.length === 0) {throw new Error(libraryCopy.errors.noProgress)}
  }

  throw new Error(libraryCopy.errors.transferLimit)
}

export async function downloadOriginal(gateway: LibraryGateway, artifactId: string, versionId?: string, profile?: string): Promise<void> {
  const capabilities = await gateway.libraryCapabilities()
  const { bytes, first } = await allChunks((offset, descriptor) => gateway.downloadLibraryArtifact({ ...(profile ? { profile } : {}), artifact_id: artifactId, ...(versionId ? { version_id: versionId, latest: false } : { latest: true }), offset, chunk_size: capabilities.max_chunk_size, ...(descriptor ? { descriptor } : {}) }), capabilities.max_chunk_size)
  await verifySha256(bytes, first.sha256)
  const filename = sanitizedDownloadFilename(first.filename)
  const blob = new Blob([Uint8Array.from(bytes).buffer], { type: safeDownloadMime(filename, bytes) })
  const url = URL.createObjectURL(blob)

  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.rel = 'noopener'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}

function dateRange(value: string): Pick<LibraryListOptions, 'date_from' | 'date_to'> {
  if (value !== 'week' && value !== 'month') {return {}}
  const now = new Date()
  const start = new Date(now)
  start.setUTCDate(start.getUTCDate() - (value === 'week' ? 7 : 30))

  return { date_from: start.toISOString(), date_to: now.toISOString() }
}

async function completeList(gateway: LibraryGateway, options: LibraryListOptions): Promise<LibraryListResult> {
  const capabilities = await gateway.libraryCapabilities()
  const request = { ...options, limit: capabilities.max_page_size }
  let result = await gateway.listLibrary(request)
  const items = [...result.items]
  const cursors = new Set<string>()

  while (result.has_more) {
    if (!result.next_cursor || cursors.has(result.next_cursor)) {throw new Error(libraryCopy.errors.invalidCursor)}
    cursors.add(result.next_cursor)
    result = await gateway.listLibrary({ ...request, cursor: result.next_cursor })
    items.push(...result.items)
  }

  const unique = new Set(items.map((item) => item.artifact_id))

  if (unique.size !== items.length) {throw new Error(libraryCopy.errors.duplicateArtifacts)}

  if (result.coverage.status === 'complete' && result.total !== undefined && result.total !== items.length) {throw new Error(libraryCopy.errors.incompleteResults)}

  return { ...result, items, has_more: false, next_cursor: null }
}

function formatDate(value: string | null | undefined): string {
  if (!value) {return libraryCopy.common.dateUnavailable}
  const date = new Date(value)

  return Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium' }).format(date) : libraryCopy.common.dateUnavailable
}

function formatBytes(size: number): string {
  if (size < 1024) {return `${size} B`}

  if (size < 1024 * 1024) {return `${(size / 1024).toFixed(1)} KB`}

  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function selectedDetailVersion(detail: LibraryDetail, versionId: string) {
  return versionId ? detail.versions.find((entry) => entry.version_id === versionId) : detail.latest
}

export function Library({ params, onNavigate, gateway, refreshToken = 0, relationshipContext }: LibraryProps) {
  const query = params.get('libraryQ') ?? ''
  const rawType = params.get('libraryType')
  const rawDate = params.get('libraryDate')
  const rawStatus = params.get('libraryStatus')
  const type = rawType && DISPLAY_TYPES.includes(rawType as typeof DISPLAY_TYPES[number]) ? rawType : 'all'
  const date = rawDate && ['any', 'week', 'month'].includes(rawDate) ? rawDate : 'any'
  const status = rawStatus && ['all', 'reviewed', 'live'].includes(rawStatus) ? rawStatus : 'all'
  const collection = params.get('libraryCollection') ?? ''
  const profile = params.get('libraryProfile') ?? ''
  const project = params.get('libraryProject') ?? ''
  const topic = params.get('libraryTopic') ?? ''
  const session = params.get('librarySession') ?? ''
  const selectedId = params.get('libraryArtifact')
  const openReference = params.get('libraryOpen') ?? ''
  const selectedVersion = params.get('libraryVersion') ?? ''
  const [result, setResult] = useState<LibraryListResult | null>(null)
  const [profiles, setProfiles] = useState<{ profile: string; configured: boolean }[]>([])
  const [loadedDetail, setLoadedDetail] = useState<LoadedDetail | null>(null)
  const [preview, setPreview] = useState<LoadedPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [pinning, setPinning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const returnFocus = useRef<string | null>(null)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const previewRequest = useRef(0)
  const openedReference = useRef<string | null>(null)
  const detailSelection = `${profile}\u0000${selectedId ?? ''}`
  const detailSelectionRef = useRef(detailSelection)
  detailSelectionRef.current = detailSelection
  const detail = loadedDetail?.selection === detailSelection ? loadedDetail.value : null
  const previewSelection = `${profile}\u0000${selectedId ?? ''}\u0000${selectedVersion}`
  const previewSelectionRef = useRef(previewSelection)
  previewSelectionRef.current = previewSelection
  const displayedPreview = preview?.selection === previewSelection ? preview : null
  const jsonPlainTextFallback = displayedPreview?.kind === 'text' && ['application/json', 'text/json'].includes(displayedPreview.mimeType.split(';', 1)[0].trim().toLowerCase())
  const requestedRelationshipCount = [project, topic, session].filter(Boolean).length


  const linkedRelationship = requestedRelationshipCount === 1 && (project
    ? relationshipContext?.projects.some((item) => item.id === project && item.profile === profile)
    : topic
      ? relationshipContext?.topics.some((item) => item.id === topic && item.profile === profile)
      : relationshipContext?.sessions.some((item) => item.id === session && item.profile === profile))

  const relationshipUnavailable = requestedRelationshipCount > 0 && !linkedRelationship

  const options = useMemo<LibraryListOptions>(() => ({ ...(query.trim() ? { search: query.trim() } : {}), ...(collection ? { collection } : {}), ...(project ? { project } : {}), ...(topic ? { topic } : {}), ...(session ? { session } : {}), ...(type !== 'all' ? { type: type as LibraryPreviewKind } : {}), ...dateRange(date), ...(status === 'reviewed' ? { reviewed: true } : status === 'live' ? { reviewed: false } : {}) }), [collection, date, project, query, session, status, topic, type])
  useEffect(() => {
    let active = true

    void gateway.libraryProfiles()
      .then((value) => {
        if (active) {setProfiles(value.items)}
      })
      .catch((cause) => {
        if (active) {setError(message(cause))}
      })

    return () => {active = false}
  }, [gateway, refreshToken, retry])
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    const selectedProfiles = profile ? [profile] : profiles.filter((entry) => entry.configured).map((entry) => entry.profile)

    if (!selectedProfiles.length && profiles.length) {
      setResult(null)
      setLoading(false)

      return () => {active = false}
    }

    void Promise.all(selectedProfiles.map((name) => completeList(gateway, { ...options, profile: name }))).then((results) => {
      if (!active) {return}

      if (results.length === 1) {
        setResult(results[0])

        return
      }

      const items = results.flatMap((entry) => entry.items)
      const collections = [...new Map(results.flatMap((entry) => entry.collections).map((entry) => [entry.id, entry])).values()]
      const complete = results.every((entry) => entry.coverage.status === 'complete')
      setResult({ items, collections, has_more: false, next_cursor: null, ...(complete ? { total: items.length } : {}), as_of: results.map((entry) => entry.as_of).sort().at(-1) ?? '', coverage: { configured: results.some((entry) => entry.coverage.configured), status: complete ? 'complete' : 'partial', collections: Object.assign({}, ...results.map((entry) => entry.coverage.collections)) }, warnings: results.flatMap((entry) => entry.warnings), profile: '*', backend_namespace: results[0]?.backend_namespace ?? '' })
    }).catch((cause) => {if (active) {setResult(null); setError(message(cause))}}).finally(() => {if (active) {setLoading(false)}})

    return () => {active = false}
  }, [gateway, options, profile, profiles, refreshToken, retry])

  useEffect(() => {
    let active = true

    if (!openReference || selectedId || openedReference.current === openReference) {return () => {active = false}}
    openedReference.current = openReference
    setReferenceError(null)
    void gateway.resolveLibraryReference(openReference, profile || undefined).then((resolved) => {
      if (!active) {return}
      if (!resolved.available || !resolved.artifact_id) {
        setReferenceError(libraryCopy.errors.unavailableReference)

        return
      }
      const next = new URLSearchParams(params)
      next.delete('libraryOpen')
      next.set('libraryArtifact', resolved.artifact_id)
      next.set('libraryProfile', resolved.profile)
      onNavigate(next)
    }).catch(() => {if (active) {setReferenceError(libraryCopy.errors.unavailableReference)}})

    return () => {active = false}
  }, [gateway, onNavigate, openReference, params, profile, selectedId])

  useEffect(() => {
    let active = true

    if (!selectedId) {
      setLoadedDetail(null)
      setPreview(null)
      setDetailError(null)
      const focusId = returnFocus.current

      if (focusId) {queueMicrotask(() => rows.current.get(focusId)?.focus())}

      return () => {active = false}
    }

    setDetailLoading(true)
    setDetailError(null)
    setPreview(null)
    const requestSelection = detailSelection
    void gateway.getLibraryArtifact(selectedId, profile || undefined).then((next) => {if (active) {setLoadedDetail({ selection: requestSelection, value: next })}}).catch((cause) => {if (active) {setLoadedDetail(null); setDetailError(message(cause))}}).finally(() => {if (active) {setDetailLoading(false)}})

    return () => {active = false}
  }, [detailSelection, gateway, profile, selectedId])

  useEffect(() => {
    previewRequest.current += 1
    setPreview(null)
    setPreviewLoading(false)
    setDetailError(null)

    return () => {previewRequest.current += 1}
  }, [profile, selectedId, selectedVersion])

  useEffect(() => () => {if (preview?.objectUrl) {URL.revokeObjectURL(preview.objectUrl)}}, [preview])

  const update = (key: string, value: string, empty: string) => {
    const next = new URLSearchParams(params)

    if (value === empty) {next.delete(key)} else {next.set(key, value)}
    next.delete('libraryArtifact')
    next.delete('libraryVersion')
    onNavigate(next)
  }

  const open = (item: LibraryItem) => {
    returnFocus.current = item.artifact_id
    const next = new URLSearchParams(params)
    next.set('libraryArtifact', item.artifact_id)
    next.set('libraryProfile', item.profile)

    if (item.reviewed && item.version_id) {next.set('libraryVersion', item.version_id)} else {next.delete('libraryVersion')}
    onNavigate(next)
  }

  const close = () => {
    const next = new URLSearchParams(params)
    next.delete('libraryArtifact')
    next.delete('libraryVersion')
    onNavigate(next)
  }

  const selectVersion = (value: string) => {
    const next = new URLSearchParams(params)

    if (value) {next.set('libraryVersion', value)} else {next.delete('libraryVersion')}
    onNavigate(next)
  }

  const loadPreview = async () => {
    if (!detail) {return}
    const versionId = selectedVersion || undefined
    const requestId = ++previewRequest.current
    const requestSelection = previewSelection
    const isCurrentRequest = () => previewRequest.current === requestId && previewSelectionRef.current === requestSelection
    setPreview(null)
    setPreviewLoading(true)
    setDetailError(null)

    try {
      const capabilities = await gateway.libraryCapabilities()
      const transferred = await allChunks((offset, descriptor) => gateway.previewLibraryArtifact({ profile: detail.profile, artifact_id: detail.artifact_id, ...(versionId ? { version_id: versionId, latest: false } : { latest: true }), offset, chunk_size: capabilities.max_chunk_size, ...(descriptor ? { descriptor } : {}) }), capabilities.max_chunk_size)

      if (!isCurrentRequest()) {return}
      const policy = transferred.first.preview
      const reviewedSource = { selection: requestSelection, descriptor: transferred.first.descriptor, versionId: transferred.first.version_id }

      if (transferred.first.available === false || !policy?.preview_available) {
        setPreview({ kind: 'unsupported', text: policy?.message || libraryCopy.errors.safePreviewUnavailable, mimeType: 'text/plain', ...reviewedSource })
      } else if (policy.kind === 'html') {
        if (transferred.first.sandbox !== '' || transferred.first.scripts !== false || transferred.first.network !== false) {throw new Error(libraryCopy.errors.unsafeHtml)}
        setPreview({ kind: 'html', text: decodeText(transferred.bytes), mimeType: transferred.first.mime_type || 'text/html', ...reviewedSource })
      } else if (policy.kind === 'markdown' || policy.kind === 'text') {
        setPreview({ kind: policy.kind, text: decodeText(transferred.bytes), mimeType: transferred.first.mime_type || 'text/plain', ...reviewedSource })
      } else if (policy.kind === 'pdf') {
        await verifySha256(transferred.bytes, transferred.first.sha256)

        if (safeDownloadMime(transferred.first.filename ?? '', transferred.bytes) !== 'application/pdf') {throw new Error(libraryCopy.errors.invalidPdf)}
        setPreview({ kind: 'pdf', objectUrl: URL.createObjectURL(new Blob([Uint8Array.from(transferred.bytes).buffer], { type: 'application/pdf' })), mimeType: 'application/pdf', ...reviewedSource })
      } else if (policy.kind === 'image') {
        setPreview({ kind: 'image', objectUrl: URL.createObjectURL(new Blob([Uint8Array.from(transferred.bytes).buffer], { type: transferred.first.mime_type })), mimeType: transferred.first.mime_type || 'application/octet-stream', ...reviewedSource })
      } else {
        setPreview({ kind: 'unsupported', text: policy.message || libraryCopy.errors.safePreviewUnavailable, mimeType: 'text/plain', ...reviewedSource })
      }
    } catch (cause) {
      if (isCurrentRequest()) {setDetailError(message(cause))}
    } finally {
      if (isCurrentRequest()) {setPreviewLoading(false)}
    }
  }

  const pinReviewed = async () => {
    if (!detail || !displayedPreview?.descriptor || selectedVersion) {return}

    if (relationshipUnavailable) {
      setDetailError(libraryCopy.errors.relationship)

      return
    }

    setPinning(true); setDetailError(null)

    try {
      await gateway.pinReviewedLibraryArtifact({ profile: detail.profile, artifact_id: detail.artifact_id, reviewed_descriptor: displayedPreview.descriptor, provenance: { reviewed_via: 'companion_safe_preview', reviewed_version: displayedPreview.versionId ?? 'latest' }, ...(linkedRelationship && relationshipContext ? { relationships: relationshipContext } : {}) })
      setPreview(null)
      setRetry((value) => value + 1)
      const refreshed = await gateway.getLibraryArtifact(detail.artifact_id, detail.profile)

      if (detailSelectionRef.current === detailSelection) {setLoadedDetail({ selection: detailSelection, value: refreshed })}
    } catch (cause) {setDetailError(message(cause))} finally {setPinning(false)}
  }

  if (selectedId) {
    const selected = detail ? selectedDetailVersion(detail, selectedVersion) : undefined

    return <section aria-labelledby="library-detail-title" className="library-screen library-detail"><button onClick={close} type="button">{libraryCopy.detail.back}</button>{detailLoading && <p role="status">{libraryCopy.detail.loading}</p>}{relationshipUnavailable && !detailError && <div role="alert">{libraryCopy.errors.relationship}</div>}{detailError && <div role="alert">{detailError}<button onClick={() => close()} type="button">{libraryCopy.detail.return}</button></div>}{detail && !selected && selectedVersion && <><p className="kicker">{detail.collection.name}</p><h2 id="library-detail-title">{detail.filename}</h2><div role="alert">{libraryCopy.detail.missingVersion(selectedVersion)}</div></>}{detail && selected && <><p className="kicker">{detail.collection.name}</p><h2 id="library-detail-title">{detail.filename}</h2><p>{libraryCopy.detail.canonical} · {selected.mime_type} · {formatBytes(selected.size)}</p><dl><div><dt>{libraryCopy.detail.availability}</dt><dd>{selected.availability}</dd></div></dl><TechnicalDetails><dl><div><dt>{libraryCopy.detail.backend}</dt><dd>{detail.backend_namespace}</dd></div><div><dt>{libraryCopy.detail.artifactId}</dt><dd>{detail.artifact_id}</dd></div><div><dt>{libraryCopy.detail.version}</dt><dd>{selectedVersion || selected.version_id || libraryCopy.common.latest}</dd></div><div><dt>{libraryCopy.detail.origin}</dt><dd>{selected.reviewed ? libraryCopy.common.reviewedVersion : libraryCopy.common.currentCollection}</dd></div></dl>{selectedVersion && <section aria-label={libraryCopy.detail.versionOrigin}><pre>{JSON.stringify(selected.provenance ?? libraryCopy.detail.noData, null, 2)}</pre></section>}</TechnicalDetails><label>{libraryCopy.detail.versionLabel}<select aria-label={libraryCopy.detail.versionLabel} onChange={(event) => selectVersion(event.target.value)} value={selectedVersion}><option value="">{libraryCopy.common.latest}</option>{detail.versions.map((version, index) => <option key={version.version_id} value={version.version_id}>{version.ingested_at ? `${formatDate(version.ingested_at)} · ` : ''}Wersja zachowana {detail.versions.length - index}</option>)}</select></label><div className="library-actions"><button disabled={previewLoading} onClick={() => void loadPreview()} type="button">{previewLoading ? libraryCopy.detail.loadingPreview : libraryCopy.detail.loadPreview}</button><button disabled={downloading} onClick={() => {setDownloading(true); setDetailError(null); void downloadOriginal(gateway, detail.artifact_id, selectedVersion || undefined, detail.profile).catch((cause) => setDetailError(message(cause))).finally(() => setDownloading(false))}} type="button">{downloading ? libraryCopy.detail.downloading : libraryCopy.detail.download}</button>{displayedPreview?.descriptor && !selectedVersion && <button disabled={pinning || relationshipUnavailable} onClick={() => void pinReviewed()} type="button">{pinning ? libraryCopy.detail.markingReviewed : libraryCopy.detail.markReviewed}</button>}</div>{displayedPreview && <section aria-label={libraryCopy.detail.preview} className="library-preview">{jsonPlainTextFallback && <p role="note">{libraryCopy.detail.jsonFallback}</p>}{displayedPreview.kind === 'html' && <iframe sandbox="" srcDoc={displayedPreview.text} title={libraryCopy.detail.staticTitle(detail.filename)} />}{(displayedPreview.kind === 'markdown' || displayedPreview.kind === 'text' || displayedPreview.kind === 'unsupported') && <pre>{displayedPreview.text}</pre>}{displayedPreview.kind === 'image' && displayedPreview.objectUrl && <img alt={libraryCopy.detail.imageAlt(detail.filename)} src={displayedPreview.objectUrl} />}{displayedPreview.kind === 'pdf' && displayedPreview.objectUrl && <iframe sandbox="" src={displayedPreview.objectUrl} title={libraryCopy.detail.pdfTitle(detail.filename)} />}</section>}</>}</section>
  }

  const filtered = Boolean(query || type !== 'all' || date !== 'any' || collection || profile || project || topic || session || status !== 'all')

  return <section aria-labelledby="library-title" className="library-screen"><div className="directory-heading"><div><p className="kicker">{libraryCopy.chrome.kicker}</p><h2 id="library-title">{libraryCopy.chrome.title}</h2><p className="screen-lede">{libraryCopy.chrome.lede}</p></div><button className="button" disabled={loading} onClick={() => setRetry((value) => value + 1)} type="button">{libraryCopy.chrome.refresh}</button></div><div className="directory-filters"><label className="directory-search">{libraryCopy.filters.search}<input aria-label={libraryCopy.filters.search} onChange={(event) => update('libraryQ', event.target.value, '')} type="search" value={query} /></label><label>{libraryCopy.filters.type}<select aria-label={libraryCopy.filters.type} onChange={(event) => update('libraryType', event.target.value, 'all')} value={type}><option value="all">{libraryCopy.filters.allTypes}</option>{DISPLAY_TYPES.map((kind) => <option key={kind} value={kind}>{kind === 'unsupported' ? libraryCopy.filters.unsupportedPreview : libraryCopy.filters.typeLabels[kind]}</option>)}</select></label><label>{libraryCopy.filters.date}<select aria-label={libraryCopy.filters.date} onChange={(event) => update('libraryDate', event.target.value, 'any')} value={date}><option value="any">{libraryCopy.filters.anyDate}</option><option value="week">{libraryCopy.filters.last7Days}</option><option value="month">{libraryCopy.filters.last30Days}</option></select></label><label>{libraryCopy.filters.collection}<select aria-label={libraryCopy.filters.collection} onChange={(event) => update('libraryCollection', event.target.value, '')} value={collection}><option value="">{libraryCopy.filters.allCollections}</option>{result?.collections.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><label>{libraryCopy.filters.status}<select aria-label={libraryCopy.filters.status} onChange={(event) => update('libraryStatus', event.target.value, 'all')} value={status}><option value="all">{libraryCopy.filters.allStatuses}</option><option value="reviewed">{libraryCopy.filters.reviewed}</option><option value="live">{libraryCopy.filters.live}</option></select></label><label>{libraryCopy.filters.profile}<select aria-label={libraryCopy.filters.profile} onChange={(event) => update('libraryProfile', event.target.value, '')} value={profile}><option value="">{libraryCopy.filters.allAuthorizedProfiles}</option>{profiles.map((entry) => <option key={entry.profile} value={entry.profile}>{entry.profile}{entry.configured ? '' : ` (${libraryCopy.filters.unconfigured})`}</option>)}</select></label><label>{libraryCopy.filters.projectId}<input aria-label={libraryCopy.filters.project} onChange={(event) => update('libraryProject', event.target.value, '')} value={project} /></label><label>{libraryCopy.filters.topicId}<input aria-label={libraryCopy.filters.topic} onChange={(event) => update('libraryTopic', event.target.value, '')} value={topic} /></label><label>{libraryCopy.filters.sessionId}<input aria-label={libraryCopy.filters.session} onChange={(event) => update('librarySession', event.target.value, '')} value={session} /></label></div>{filtered && <div className="filter-chips"><span>{libraryCopy.filters.active}</span><button onClick={() => {const next = new URLSearchParams(params);

 for (const key of ['libraryQ', 'libraryType', 'libraryDate', 'libraryCollection', 'libraryProfile', 'libraryProject', 'libraryTopic', 'librarySession', 'libraryStatus']) {next.delete(key)}; onNavigate(next)}} type="button">{libraryCopy.filters.clear}</button></div>}{referenceError && <div className="library-boundary" role="alert">{referenceError}</div>}{loading && <p role="status">{libraryCopy.list.loading}</p>}{error && <div className="library-boundary" role="alert"><strong>{libraryCopy.list.unavailable}</strong><p>{error}</p><button onClick={() => setRetry((value) => value + 1)} type="button">{libraryCopy.list.retry}</button></div>}{!loading && result?.coverage.status === 'unconfigured' && <div className="library-boundary" role="status"><strong>{libraryCopy.list.unconfigured}</strong><p>{result.warnings.join(' ') || libraryCopy.list.noCollections}</p></div>}{!loading && result?.coverage.status === 'partial' && <div className="library-boundary" role="status"><strong>{libraryCopy.list.partial}</strong><p>{result.warnings.join(' ') || libraryCopy.list.partialFallback}</p></div>}{!loading && result && result.coverage.status !== 'unconfigured' && result.items.length === 0 && <div className="search-empty"><h3>{libraryCopy.list.noArtifacts}</h3><p>{filtered ? libraryCopy.list.noMatches : libraryCopy.list.empty}</p></div>}{result && result.items.length > 0 && <><p role="status">{result.coverage.status === 'complete' ? libraryCopy.list.completeCount(result.items.length) : libraryCopy.list.partialCount(result.items.length)}</p><ul className="library-list">{result.items.map((item) => <li key={item.artifact_id}><button onClick={() => open(item)} ref={(node) => {if (node) {rows.current.set(item.artifact_id, node)} else {rows.current.delete(item.artifact_id)}}} type="button"><strong>{item.filename}</strong><span>{libraryCopy.list.collection} {item.collection.name} · {libraryCopy.list.profile} {item.profile}</span><span>{libraryCopy.list.type} {item.mime_type} · {libraryCopy.list.updated} {formatDate(item.date)}</span><span>{item.reviewed ? libraryCopy.common.reviewedVersion : libraryCopy.list.currentVersion} · {formatBytes(item.size)}</span></button></li>)}</ul></>}</section>
}
