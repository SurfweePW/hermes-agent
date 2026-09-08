import { useEffect, useMemo, useRef, useState } from 'react'

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

  return 'The Library request failed. Try again.'
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

    if (chunk.offset !== offset || chunk.next_offset === undefined || chunk.eof === undefined || chunk.size === undefined || chunk.data_base64 === undefined || chunk.next_offset < offset || chunk.next_offset > chunk.size) {throw new Error('The Library returned an invalid content chunk.')}

    if (expectedSize === undefined) {expectedSize = chunk.size}

    if (chunk.size !== expectedSize) {throw new Error('The artifact changed while it was being transferred. Try again.')}

    if (!chunk.descriptor || (descriptor && chunk.descriptor !== descriptor)) {throw new Error('The artifact changed while it was being transferred. Try again.')}
    descriptor = chunk.descriptor
    const bytes = decodeBase64(chunk.data_base64)

    if (bytes.length !== chunk.next_offset - offset || bytes.length > maxChunkSize) {throw new Error('The Library returned an invalid content chunk.')}
    chunks.push(bytes)
    offset = chunk.next_offset

    if (chunk.eof) {
      if (offset !== expectedSize) {throw new Error('The Library returned an incomplete artifact.')}
      const combined = new Uint8Array(expectedSize)
      let target = 0

      for (const part of chunks) {combined.set(part, target); target += part.length}

      return { bytes: combined, first: first ?? chunk }
    }

    if (bytes.length === 0) {throw new Error('The Library transfer made no progress.')}
  }

  throw new Error('The Library transfer exceeded its safety limit.')
}

export async function downloadOriginal(gateway: LibraryGateway, artifactId: string, versionId?: string, profile?: string): Promise<void> {
  const capabilities = await gateway.libraryCapabilities()
  const { bytes, first } = await allChunks((offset, descriptor) => gateway.downloadLibraryArtifact({ ...(profile ? { profile } : {}), artifact_id: artifactId, ...(versionId ? { version_id: versionId, latest: false } : { latest: true }), offset, chunk_size: capabilities.max_chunk_size, ...(descriptor ? { descriptor } : {}) }), capabilities.max_chunk_size)
  const blob = new Blob([Uint8Array.from(bytes).buffer], { type: first.mime_type || 'application/octet-stream' })
  const url = URL.createObjectURL(blob)

  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = first.filename || 'artifact'
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
    if (!result.next_cursor || cursors.has(result.next_cursor)) {throw new Error('The Library returned an invalid pagination cursor.')}
    cursors.add(result.next_cursor)
    result = await gateway.listLibrary({ ...request, cursor: result.next_cursor })
    items.push(...result.items)
  }

  const unique = new Set(items.map((item) => item.artifact_id))

  if (unique.size !== items.length) {throw new Error('The Library returned duplicate artifacts across pages.')}

  if (result.coverage.status === 'complete' && result.total !== undefined && result.total !== items.length) {throw new Error('The Library returned an incomplete result set.')}

  return { ...result, items, has_more: false, next_cursor: null }
}

function formatDate(value: string | null | undefined): string {
  if (!value) {return 'Date unavailable'}
  const date = new Date(value)

  return Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date) : 'Date unavailable'
}

function formatBytes(size: number): string {
  if (size < 1024) {return `${size} B`}

  if (size < 1024 * 1024) {return `${(size / 1024).toFixed(1)} KB`}

  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function selectedDetailVersion(detail: LibraryDetail, versionId: string) {
  return versionId ? detail.versions.find((entry) => entry.version_id === versionId) ?? detail.latest : detail.latest
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
  const returnFocus = useRef<string | null>(null)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const previewRequest = useRef(0)
  const detailSelection = `${profile}\u0000${selectedId ?? ''}`
  const detailSelectionRef = useRef(detailSelection)
  detailSelectionRef.current = detailSelection
  const detail = loadedDetail?.selection === detailSelection ? loadedDetail.value : null
  const previewSelection = `${profile}\u0000${selectedId ?? ''}\u0000${selectedVersion}`
  const previewSelectionRef = useRef(previewSelection)
  previewSelectionRef.current = previewSelection
  const displayedPreview = preview?.selection === previewSelection ? preview : null
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
        setPreview({ kind: 'unsupported', text: policy?.message || 'A safe preview is not available for this artifact.', mimeType: 'text/plain', ...reviewedSource })
      } else if (policy.kind === 'html') {
        if (transferred.first.sandbox !== '' || transferred.first.scripts !== false || transferred.first.network !== false) {throw new Error('The HTML preview did not satisfy the static sandbox contract.')}
        setPreview({ kind: 'html', text: decodeText(transferred.bytes), mimeType: transferred.first.mime_type || 'text/html', ...reviewedSource })
      } else if (policy.kind === 'markdown' || policy.kind === 'text') {
        setPreview({ kind: policy.kind, text: decodeText(transferred.bytes), mimeType: transferred.first.mime_type || 'text/plain', ...reviewedSource })
      } else if (policy.kind === 'image' || policy.kind === 'pdf') {
        setPreview({ kind: policy.kind, objectUrl: URL.createObjectURL(new Blob([Uint8Array.from(transferred.bytes).buffer], { type: transferred.first.mime_type })), mimeType: transferred.first.mime_type || 'application/octet-stream', ...reviewedSource })
      } else {
        setPreview({ kind: 'unsupported', text: policy.message || 'A safe preview is not available for this artifact.', mimeType: 'text/plain', ...reviewedSource })
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
      setDetailError('The requested Library relationship could not be verified. Pinning is disabled.')

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
    return <section aria-labelledby="library-detail-title" className="library-screen library-detail"><button onClick={close} type="button">← Back to Library</button>{detailLoading && <p role="status">Loading artifact details…</p>}{relationshipUnavailable && !detailError && <div role="alert">The requested Library relationship could not be verified. Pinning is disabled.</div>}{detailError && <div role="alert">{detailError}<button onClick={() => close()} type="button">Return to Library</button></div>}{detail && <><p className="kicker">{detail.collection.name}</p><h2 id="library-detail-title">{detail.filename}</h2><p>Canonical Library artifact · {selectedDetailVersion(detail, selectedVersion).mime_type} · {formatBytes(selectedDetailVersion(detail, selectedVersion).size)}</p><dl><div><dt>Version</dt><dd>{selectedVersion || selectedDetailVersion(detail, selectedVersion).version_id || 'Latest live version'}</dd></div><div><dt>Provenance</dt><dd>{selectedDetailVersion(detail, selectedVersion).reviewed ? 'Reviewed retained artifact' : 'Current configured collection'}</dd></div><div><dt>Availability</dt><dd>{selectedDetailVersion(detail, selectedVersion).availability}</dd></div></dl><label>Version<select aria-label="Version" onChange={(event) => selectVersion(event.target.value)} value={selectedVersion}><option value="">Latest</option>{detail.versions.map((version) => <option key={version.version_id} value={version.version_id}>{version.ingested_at ? `${formatDate(version.ingested_at)} · ` : ''}{version.version_id}</option>)}</select></label>{selectedVersion && <section aria-label="Version provenance"><h3>Provenance</h3><pre>{JSON.stringify(detail.versions.find((entry) => entry.version_id === selectedVersion)?.provenance ?? 'No provenance recorded.', null, 2)}</pre></section>}<div className="library-actions"><button disabled={previewLoading} onClick={() => void loadPreview()} type="button">{previewLoading ? 'Loading preview…' : 'Load safe preview'}</button><button disabled={downloading} onClick={() => {setDownloading(true); setDetailError(null); void downloadOriginal(gateway, detail.artifact_id, selectedVersion || undefined, detail.profile).catch((cause) => setDetailError(message(cause))).finally(() => setDownloading(false))}} type="button">{downloading ? 'Downloading original…' : 'Download original'}</button>{displayedPreview?.descriptor && !selectedVersion && <button disabled={pinning || relationshipUnavailable} onClick={() => void pinReviewed()} type="button">{pinning ? 'Saving reviewed version…' : 'Mark previewed version reviewed'}</button>}</div>{displayedPreview && <section aria-label="Artifact preview" className="library-preview">{displayedPreview.kind === 'html' && <iframe sandbox="" srcDoc={displayedPreview.text} title={`Static preview of ${detail.filename}`} />}{(displayedPreview.kind === 'markdown' || displayedPreview.kind === 'text' || displayedPreview.kind === 'unsupported') && <pre>{displayedPreview.text}</pre>}{displayedPreview.kind === 'image' && displayedPreview.objectUrl && <img alt={`Preview of ${detail.filename}`} src={displayedPreview.objectUrl} />}{displayedPreview.kind === 'pdf' && displayedPreview.objectUrl && <iframe sandbox="" src={displayedPreview.objectUrl} title={`PDF preview of ${detail.filename}`} />}</section>}</>}</section>
  }

  const filtered = Boolean(query || type !== 'all' || date !== 'any' || collection || profile || project || topic || session || status !== 'all')

  return <section aria-labelledby="library-title" className="library-screen"><div className="directory-heading"><div><p className="kicker">Authorized deliverables</p><h2 id="library-title">Library</h2><p className="screen-lede">Search configured canonical output collections. Device paths and arbitrary file browsing are not exposed.</p></div><button className="button" disabled={loading} onClick={() => setRetry((value) => value + 1)} type="button">Refresh Library</button></div><div className="directory-filters"><label className="directory-search">Search titles and metadata<input aria-label="Search titles and metadata" onChange={(event) => update('libraryQ', event.target.value, '')} type="search" value={query} /></label><label>Type<select aria-label="Type" onChange={(event) => update('libraryType', event.target.value, 'all')} value={type}><option value="all">All types</option>{DISPLAY_TYPES.map((kind) => <option key={kind} value={kind}>{kind === 'unsupported' ? 'Unsupported preview' : kind[0].toUpperCase() + kind.slice(1)}</option>)}</select></label><label>Date<select aria-label="Date" onChange={(event) => update('libraryDate', event.target.value, 'any')} value={date}><option value="any">Any date</option><option value="week">Last 7 days</option><option value="month">Last 30 days</option></select></label><label>Collection<select aria-label="Collection" onChange={(event) => update('libraryCollection', event.target.value, '')} value={collection}><option value="">All collections</option>{result?.collections.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><label>Status<select aria-label="Status" onChange={(event) => update('libraryStatus', event.target.value, 'all')} value={status}><option value="all">All statuses</option><option value="reviewed">Reviewed</option><option value="live">Current/live</option></select></label><label>Profile<select aria-label="Profile" onChange={(event) => update('libraryProfile', event.target.value, '')} value={profile}><option value="">All authorized profiles</option>{profiles.map((entry) => <option key={entry.profile} value={entry.profile}>{entry.profile}{entry.configured ? '' : ' (unconfigured)'}</option>)}</select></label><label>Project ID<input aria-label="Project" onChange={(event) => update('libraryProject', event.target.value, '')} value={project} /></label><label>Topic ID<input aria-label="Topic" onChange={(event) => update('libraryTopic', event.target.value, '')} value={topic} /></label><label>Session ID<input aria-label="Session" onChange={(event) => update('librarySession', event.target.value, '')} value={session} /></label></div>{filtered && <div className="filter-chips"><span>Filters active</span><button onClick={() => {const next = new URLSearchParams(params);

 for (const key of ['libraryQ', 'libraryType', 'libraryDate', 'libraryCollection', 'libraryProfile', 'libraryProject', 'libraryTopic', 'librarySession', 'libraryStatus']) {next.delete(key)}; onNavigate(next)}} type="button">Clear filters</button></div>}{loading && <p role="status">Loading the complete Library…</p>}{error && <div className="library-boundary" role="alert"><strong>Library unavailable</strong><p>{error}</p><button onClick={() => setRetry((value) => value + 1)} type="button">Try again</button></div>}{!loading && result?.coverage.status === 'unconfigured' && <div className="library-boundary" role="status"><strong>Library is not configured</strong><p>{result.warnings.join(' ') || 'No authorized collections are configured for this profile.'}</p></div>}{!loading && result?.coverage.status === 'partial' && <div className="library-boundary" role="status"><strong>Library coverage is partial</strong><p>{result.warnings.join(' ') || 'One or more configured collections are unavailable. Results are incomplete.'}</p></div>}{!loading && result && result.coverage.status !== 'unconfigured' && result.items.length === 0 && <div className="search-empty"><h3>No artifacts found</h3><p>{filtered ? 'No artifacts match these filters in the available collections.' : 'The configured Library is empty.'}</p></div>}{result && result.items.length > 0 && <><p role="status">{result.coverage.status === 'complete' ? `${result.items.length} artifacts across all available pages.` : `${result.items.length} artifacts found in available collections; this is not a complete total.`}</p><ul className="library-list">{result.items.map((item) => <li key={item.artifact_id}><button onClick={() => open(item)} ref={(node) => {if (node) {rows.current.set(item.artifact_id, node)} else {rows.current.delete(item.artifact_id)}}} type="button"><strong>{item.filename}</strong><span>{item.collection.name} · {item.preview.kind} · {formatDate(item.date)}</span><span>{item.reviewed ? 'Reviewed provenance' : 'Live collection provenance'} · {item.version_count ? `${item.version_count} retained ${item.version_count === 1 ? 'version' : 'versions'}` : 'No retained versions'} · {formatBytes(item.size)}</span></button></li>)}</ul></>}</section>
}
