import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { downloadOriginal, Library } from './library'
import { type LibraryChunk, type LibraryDetail, type LibraryGateway, type LibraryItem, type LibraryListOptions, type LibraryListResult, validateLibraryDetail, validateLibraryList, validateLibraryResolve } from './library-types'

const artifactId = `art_${'a'.repeat(64)}`
const versionId = `ver_${'b'.repeat(64)}`
const collection = { id: 'docs', name: 'Documents', owner: 'atlas', availability: 'available' }
const item: LibraryItem = { artifact_id: artifactId, profile: 'atlas', collection, filename: 'report.md', version_id: versionId, size: 8, sha256: 'c'.repeat(64), mime_type: 'text/markdown', availability: 'available', reviewed: true, version_count: 1, date: '2026-01-01T00:00:00Z', preview: { kind: 'markdown', preview_available: true } }
const complete = (items: LibraryItem[] = [item]): LibraryListResult => ({ items, collections: [collection], has_more: false, next_cursor: null, total: items.length, as_of: '2026-01-02T00:00:00Z', coverage: { configured: true, status: 'complete', collections: { docs: 'available' } }, warnings: [], profile: 'atlas', backend_namespace: 'test' })
const detail: LibraryDetail = { artifact_id: artifactId, profile: 'atlas', backend_namespace: 'test', collection, filename: item.filename, versions: [{ version_id: versionId, filename: item.filename, size: item.size, sha256: item.sha256, mime_type: item.mime_type, reviewed: true, availability: 'available', preview: item.preview, ingested_at: item.date!, provenance: { decision_id: 'd1' } }], latest: { version_id: versionId, filename: item.filename, size: item.size, sha256: item.sha256, mime_type: item.mime_type, reviewed: true, availability: 'available', preview: item.preview }, as_of: '2026-01-02T00:00:00Z' }

function encoded(value: string): string {return btoa(value)}

const capabilities = (maxChunkSize: number) => ({ version: 1 as const, max_page_size: 2, max_chunk_size: maxChunkSize, download_transport: 'authenticated_json_rpc_base64_chunks' as const, transfer_consistency: 'signed_immutable_descriptor' as const, html_preview: 'sanitized_static_document' as const, relationship_filters: ['collection', 'project', 'topic', 'session', 'status'] as ['collection', 'project', 'topic', 'session', 'status'], evidence_pin: 'explicit_owner_reviewed_latest' as const, reference_resolution: 'exact_collection_relative_path' as const })

function gateway(overrides: Partial<LibraryGateway> = {}): LibraryGateway {
  return {
    libraryCapabilities: vi.fn().mockResolvedValue(capabilities(8)),
    libraryProfiles: vi.fn().mockResolvedValue({ items: [{ profile: 'atlas', configured: true }], backend_namespace: 'test', as_of: '2026-01-02T00:00:00Z' }),
    resolveLibraryReference: vi.fn().mockResolvedValue({ available: true, artifact_id: artifactId, profile: 'atlas', backend_namespace: 'test' }),
    listLibrary: vi.fn().mockResolvedValue(complete()),
    getLibraryArtifact: vi.fn().mockResolvedValue(detail),
    previewLibraryArtifact: vi.fn().mockResolvedValue({ artifact_id: artifactId, version_id: versionId, data_base64: encoded('# report'), offset: 0, next_offset: 8, eof: true, size: 8, sha256: item.sha256, filename: item.filename, mime_type: item.mime_type, descriptor: 'signed-transfer', preview: item.preview }),
    downloadLibraryArtifact: vi.fn(),
    pinReviewedLibraryArtifact: vi.fn().mockResolvedValue({}),
    ...overrides
  }
}

afterEach(() => vi.restoreAllMocks())

describe('Library', () => {
  it('opens only the artifact returned by the exact full-reference resolver', async () => {
    const onNavigate = vi.fn()
    const reference = 'library:docs/nested/report.md'
    const resolveLibraryReference = vi.fn().mockResolvedValue({ available: true, artifact_id: artifactId, profile: 'atlas', backend_namespace: 'test' })
    const params = new URLSearchParams(`libraryProfile=atlas&libraryOpen=${encodeURIComponent(reference)}`)

    render(<Library gateway={gateway({ resolveLibraryReference })} onNavigate={onNavigate} params={params} />)

    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1))
    const next = onNavigate.mock.calls[0][0] as URLSearchParams
    expect(next.get('libraryArtifact')).toBe(artifactId)
    expect(next.has('libraryOpen')).toBe(false)
    expect(resolveLibraryReference).toHaveBeenCalledWith(reference, 'atlas')
  })

  it('reports an unavailable exact reference without basename fallback', async () => {
    const onNavigate = vi.fn()
    const listLibrary = vi.fn().mockResolvedValue(complete([item, { ...item, artifact_id: `art_${'f'.repeat(64)}` }]))
    render(<Library gateway={gateway({ listLibrary, resolveLibraryReference: vi.fn().mockResolvedValue({ available: false, profile: 'atlas', backend_namespace: 'test' }) })} onNavigate={onNavigate} params={new URLSearchParams('libraryProfile=atlas&libraryOpen=library%3Adocs%2Fmissing%2Freport.md')} />)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('unavailable'))
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('rejects path-bearing fields from exact resolver responses', () => {
    expect(() => validateLibraryResolve({ available: true, artifact_id: artifactId, profile: 'atlas', backend_namespace: 'test', relative_path: 'private/report.md' }, 'atlas')).toThrow(/path-bearing field/i)
  })

  it('refreshes explicitly and when the lifecycle refresh token changes', async () => {
    const listLibrary = vi.fn().mockResolvedValue(complete())
    const fake = gateway({ listLibrary })
    const view = render(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams()} refreshToken={0} />)
    await waitFor(() => expect(listLibrary).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Refresh Library' }))
    await waitFor(() => expect(listLibrary).toHaveBeenCalledTimes(2))
    view.rerender(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams()} refreshToken={1} />)
    await waitFor(() => expect(listLibrary).toHaveBeenCalledTimes(3))
  })

  it('reports an unconfigured backend without claiming the Library is empty', async () => {
    const fake = gateway({ listLibrary: vi.fn().mockResolvedValue({ ...complete([]), collections: [], coverage: { configured: false, status: 'unconfigured', collections: {} }, warnings: ['No Companion Library collections are configured for this profile; no roots were scanned.'] }) })
    render(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams()} />)

    expect(await screen.findByText('Library is not configured')).toBeTruthy()
    expect(screen.getByText(/no roots were scanned/i)).toBeTruthy()
    expect(screen.queryByText('The configured Library is empty.')).toBeNull()
  })

  it('queries every backend page with server-side search and canonical filters', async () => {
    const second = { ...item, artifact_id: `art_${'d'.repeat(64)}`, filename: 'report-2.md' }

    const listLibrary = vi.fn(async (options: LibraryListOptions) => options.cursor
      ? { ...complete([second]), total: 2 }
      : { ...complete([item]), total: 2, has_more: true, next_cursor: 'page-2' })

    const fake = gateway({ listLibrary })
    render(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams('libraryQ=report&libraryType=markdown&libraryCollection=docs&libraryStatus=reviewed')} />)

    expect(await screen.findByText('2 artifacts across all available pages.')).toBeTruthy()
    expect(screen.getByText('report-2.md')).toBeTruthy()
    expect(listLibrary).toHaveBeenNthCalledWith(1, expect.objectContaining({ search: 'report', type: 'markdown', collection: 'docs', reviewed: true, limit: 2 }))
    expect(listLibrary).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'page-2', search: 'report', limit: 2 }))
    expect(screen.getAllByText('Kolekcja: Documents · Profil: atlas')).toHaveLength(2)
    expect(screen.getAllByText('Wersja zatwierdzona · 8 B')).toHaveLength(2)
    expect(document.body.textContent).not.toContain(versionId)
    expect((screen.getByLabelText('Project') as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByLabelText('Topic') as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByLabelText('Session') as HTMLInputElement).disabled).toBe(false)
  })

  it('keeps detail routing while selecting a retained version', async () => {
    const navigate = vi.fn()
    render(<Library gateway={gateway()} onNavigate={navigate} params={new URLSearchParams(`libraryArtifact=${artifactId}&libraryProfile=atlas`)} />)
    await screen.findByText(item.filename)
    const technical = screen.getByText('Szczegóły techniczne').closest('details')
    expect(technical?.hasAttribute('open')).toBe(false)
    expect(technical?.querySelector('summary')?.getAttribute('aria-expanded')).toBe('false')
    expect(technical?.textContent).toContain(artifactId)
    expect(screen.queryByRole('option', { name: versionId })).toBeNull()
    expect(screen.getByRole('button', { name: 'Load safe preview' }).closest('details')).toBeNull()
    fireEvent.click(screen.getByText('Szczegóły techniczne'))
    expect(technical?.querySelector('summary')?.getAttribute('aria-expanded')).toBe('true')
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: versionId } })
    const next = navigate.mock.calls.at(-1)?.[0] as URLSearchParams
    expect(next.get('libraryArtifact')).toBe(artifactId)
    expect(next.get('libraryProfile')).toBe('atlas')
    expect(next.get('libraryVersion')).toBe(versionId)
  })

  it('does not fall back to Latest when a requested retained version is missing', async () => {
    const missingVersion = `ver_${'9'.repeat(64)}`
    const previewLibraryArtifact = vi.fn()
    const downloadLibraryArtifact = vi.fn()
    render(<Library gateway={gateway({ previewLibraryArtifact, downloadLibraryArtifact })} onNavigate={vi.fn()} params={new URLSearchParams(`libraryArtifact=${artifactId}&libraryProfile=atlas&libraryVersion=${missingVersion}`)} />)

    expect((await screen.findByRole('alert')).textContent).toContain(`Requested retained version ${missingVersion} is unavailable.`)
    expect(screen.getByText(missingVersion)).toBeTruthy()
    expect(screen.queryByText(/Latest live version/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Load safe preview' })).toBeNull()
    expect(previewLibraryArtifact).not.toHaveBeenCalled()
    expect(downloadLibraryArtifact).not.toHaveBeenCalled()
  })

  it('suppresses stale detail actions when history selects another profile artifact', async () => {
    const nextArtifactId = `art_${'e'.repeat(64)}`
    const nextItem = { ...item, artifact_id: nextArtifactId, profile: 'beta', filename: 'next-report.md' }
    const nextDetail = { ...detail, artifact_id: nextArtifactId, profile: 'beta', filename: nextItem.filename }
    let resolveNextDetail!: (value: LibraryDetail) => void
    const delayedNextDetail = new Promise<LibraryDetail>((resolve) => {resolveNextDetail = resolve})
    const getLibraryArtifact = vi.fn((id: string, requestedProfile?: string) => id === artifactId && requestedProfile === 'atlas' ? Promise.resolve(detail) : delayedNextDetail)
    const previewLibraryArtifact = vi.fn().mockResolvedValue({ artifact_id: artifactId, version_id: versionId, data_base64: encoded('stale preview'), offset: 0, next_offset: 13, eof: true, size: 13, sha256: item.sha256, filename: item.filename, mime_type: item.mime_type, descriptor: 'stale-transfer', preview: item.preview })
    const fake = gateway({ getLibraryArtifact, previewLibraryArtifact })
    const view = render(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams(`libraryArtifact=${artifactId}&libraryProfile=atlas`)} />)
    await screen.findByText(item.filename)

    view.rerender(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams(`libraryArtifact=${nextArtifactId}&libraryProfile=beta`)} />)
    const staleLoadAction = screen.queryByRole('button', { name: 'Load safe preview' })

    if (staleLoadAction) {fireEvent.click(staleLoadAction)}

    await waitFor(() => expect(getLibraryArtifact).toHaveBeenCalledWith(nextArtifactId, 'beta'))
    expect(staleLoadAction).toBeNull()
    expect(previewLibraryArtifact).not.toHaveBeenCalled()
    expect(screen.queryByText(item.filename)).toBeNull()
    expect(screen.queryByText('stale preview')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mark previewed version reviewed' })).toBeNull()

    resolveNextDetail(nextDetail)
    expect(await screen.findByText(nextItem.filename)).toBeTruthy()
  })

  it('suppresses a loaded preview during the render that changes the selected version', async () => {
    const fake = gateway()
    const previewVisibleAtCommit: boolean[] = []

    const Harness = ({ params }: { params: URLSearchParams }) => {
      useLayoutEffect(() => {
        previewVisibleAtCommit.push(screen.queryByText('# report') !== null)
      }, [params])

      return <Library gateway={fake} onNavigate={vi.fn()} params={params} />
    }

    const view = render(<Harness params={new URLSearchParams(`libraryArtifact=${artifactId}&libraryProfile=atlas`)} />)
    await screen.findByText(item.filename)
    fireEvent.click(screen.getByRole('button', { name: 'Load safe preview' }))
    expect(await screen.findByText('# report')).toBeTruthy()

    view.rerender(<Harness params={new URLSearchParams(`libraryArtifact=${artifactId}&libraryProfile=atlas&libraryVersion=${versionId}`)} />)

    expect(previewVisibleAtCommit.at(-1)).toBe(false)
    expect(screen.queryByText('# report')).toBeNull()
  })

  it('revokes each preview object URL exactly once when selection changes and on unmount', async () => {
    const retainedVersionId = `ver_${'d'.repeat(64)}`
    const imagePreview = { kind: 'image' as const, preview_available: true }
    const imageVersion = { ...detail.latest, version_id: retainedVersionId, mime_type: 'image/png', preview: imagePreview }
    const imageDetail = { ...detail, filename: 'preview.png', versions: [{ ...detail.versions[0], mime_type: 'image/png', preview: imagePreview }, imageVersion], latest: { ...detail.latest, mime_type: 'image/png', preview: imagePreview } }
    const previewLibraryArtifact = vi.fn(({ version_id }: { version_id?: string }) => Promise.resolve({ artifact_id: artifactId, version_id: version_id ?? versionId, data_base64: encoded('image'), offset: 0, next_offset: 5, eof: true, size: 5, sha256: item.sha256, filename: 'preview.png', mime_type: 'image/png', descriptor: version_id ? 'retained-transfer' : 'latest-transfer', preview: imagePreview }))
    const fake = gateway({ getLibraryArtifact: vi.fn().mockResolvedValue(imageDetail), previewLibraryArtifact })
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:latest').mockReturnValueOnce('blob:retained')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const view = render(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams(`libraryArtifact=${artifactId}&libraryProfile=atlas`)} />)
    await screen.findByText('preview.png')
    fireEvent.click(screen.getByRole('button', { name: 'Load safe preview' }))
    expect((await screen.findByAltText('Preview of preview.png')).getAttribute('src')).toBe('blob:latest')

    view.rerender(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams(`libraryArtifact=${artifactId}&libraryProfile=atlas&libraryVersion=${retainedVersionId}`)} />)
    expect(screen.queryByAltText('Preview of preview.png')).toBeNull()
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:latest'))
    expect(revokeObjectURL.mock.calls.filter(([url]) => url === 'blob:latest')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Load safe preview' }))
    expect((await screen.findByAltText('Preview of preview.png')).getAttribute('src')).toBe('blob:retained')
    view.unmount()

    expect(revokeObjectURL.mock.calls.filter(([url]) => url === 'blob:latest')).toHaveLength(1)
    expect(revokeObjectURL.mock.calls.filter(([url]) => url === 'blob:retained')).toHaveLength(1)
    createObjectURL.mockRestore()
    revokeObjectURL.mockRestore()
  })

  it('ignores a stale preview response after a version change', async () => {
    const retainedVersionId = `ver_${'d'.repeat(64)}`
    const retained = { ...detail.latest, version_id: retainedVersionId }
    const versionedDetail = { ...detail, versions: [...detail.versions, retained] }
    let resolveLatest!: (chunk: LibraryChunk) => void
    let resolveRetained!: (chunk: LibraryChunk) => void
    const latestResponse = new Promise<LibraryChunk>((resolve) => {resolveLatest = resolve})
    const retainedResponse = new Promise<LibraryChunk>((resolve) => {resolveRetained = resolve})
    const previewLibraryArtifact = vi.fn(({ version_id }: { version_id?: string }) => version_id ? retainedResponse : latestResponse)
    const fake = gateway({ getLibraryArtifact: vi.fn().mockResolvedValue(versionedDetail), previewLibraryArtifact })
    const view = render(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams(`libraryArtifact=${artifactId}&libraryProfile=atlas`)} />)
    await screen.findByText(item.filename)
    fireEvent.click(screen.getByRole('button', { name: 'Load safe preview' }))
    expect(await screen.findByRole('button', { name: 'Loading preview…' })).toBeTruthy()

    view.rerender(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams(`libraryArtifact=${artifactId}&libraryProfile=atlas&libraryVersion=${retainedVersionId}`)} />)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Load safe preview' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Load safe preview' }))
    resolveLatest({ artifact_id: artifactId, version_id: versionId, data_base64: encoded('stale'), offset: 0, next_offset: 5, eof: true, size: 5, sha256: item.sha256, filename: item.filename, mime_type: item.mime_type, descriptor: 'latest-transfer', preview: item.preview })

    await waitFor(() => expect(previewLibraryArtifact).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Loading preview…' })).toBeTruthy()
    expect(screen.queryByText('stale')).toBeNull()

    resolveRetained({ artifact_id: artifactId, version_id: retainedVersionId, data_base64: encoded('retained'), offset: 0, next_offset: 8, eof: true, size: 8, sha256: item.sha256, filename: item.filename, mime_type: item.mime_type, descriptor: 'retained-transfer', preview: item.preview })
    expect(await screen.findByText('retained')).toBeTruthy()
    expect(screen.queryByText('stale')).toBeNull()
  })

  it('pins only the exact descriptor returned by the safe preview', async () => {
    const pinReviewedLibraryArtifact = vi.fn().mockResolvedValue({})
    const fake = gateway({ pinReviewedLibraryArtifact })
    render(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams(`libraryArtifact=${artifactId}&libraryProfile=atlas`)} />)
    await screen.findByText(item.filename)
    fireEvent.click(screen.getByRole('button', { name: 'Load safe preview' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Mark previewed version reviewed' }))
    await waitFor(() => expect(pinReviewedLibraryArtifact).toHaveBeenCalledWith(expect.objectContaining({ profile: 'atlas', artifact_id: artifactId, reviewed_descriptor: 'signed-transfer' })))
  })

  it.each([
    ['project', 'libraryProject', { projects: [{ id: 'project-1', title: 'Launch plan', backend_namespace: 'test', profile: 'atlas' }], topics: [], sessions: [] }],
    ['topic', 'libraryTopic', { projects: [], topics: [{ id: 'topic-1', title: 'Launch topic', backend_namespace: 'test', profile: 'atlas' }], sessions: [] }],
    ['session', 'librarySession', { projects: [], topics: [], sessions: [{ id: 'session-1', title: 'Launch research', backend_namespace: 'test', profile: 'atlas', relationship: 'primary' as const }] }]
  ])('retains authorized source-native %s context when pinning a linked artifact', async (_kind, routeKey, relationships) => {
    const pinReviewedLibraryArtifact = vi.fn().mockResolvedValue({})
    const fake = gateway({ pinReviewedLibraryArtifact })
    const linkedId = relationships.projects[0]?.id ?? relationships.topics[0]?.id ?? relationships.sessions[0]?.id
    const params = new URLSearchParams(`libraryArtifact=${artifactId}&libraryProfile=atlas&${routeKey}=${linkedId}`)
    render(<Library gateway={fake} onNavigate={vi.fn()} params={params} relationshipContext={relationships} />)
    await screen.findByText(item.filename)
    fireEvent.click(screen.getByRole('button', { name: 'Load safe preview' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Mark previewed version reviewed' }))
    await waitFor(() => expect(pinReviewedLibraryArtifact).toHaveBeenCalledWith(expect.objectContaining({ relationships })))
  })

  it('omits relationship context from a general Library pin', async () => {
    const pinReviewedLibraryArtifact = vi.fn().mockResolvedValue({})
    const fake = gateway({ pinReviewedLibraryArtifact })
    render(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams(`libraryArtifact=${artifactId}&libraryProfile=atlas`)} />)
    await screen.findByText(item.filename)
    fireEvent.click(screen.getByRole('button', { name: 'Load safe preview' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Mark previewed version reviewed' }))
    await waitFor(() => expect(pinReviewedLibraryArtifact.mock.calls[0][0]).not.toHaveProperty('relationships'))
  })

  it('renders sanitized HTML only in an inert sandbox', async () => {
    const html = "<!doctype html><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'\"><p>safe</p>"
    const htmlItem = { ...item, filename: 'safe.html', mime_type: 'text/html', preview: { kind: 'html' as const, preview_available: true } }
    const htmlDetail = { ...detail, filename: htmlItem.filename, latest: { ...detail.latest, filename: htmlItem.filename, mime_type: 'text/html', preview: htmlItem.preview } }

    const fake = gateway({
      libraryCapabilities: vi.fn().mockResolvedValue(capabilities(1024)),
      listLibrary: vi.fn().mockResolvedValue(complete([htmlItem])),
      getLibraryArtifact: vi.fn().mockResolvedValue(htmlDetail),
      previewLibraryArtifact: vi.fn().mockResolvedValue({ artifact_id: artifactId, version_id: versionId, data_base64: encoded(html), offset: 0, next_offset: html.length, eof: true, size: html.length, sha256: item.sha256, filename: 'safe.html', mime_type: 'text/html', descriptor: 'signed-transfer', preview: htmlItem.preview, sandbox: '', scripts: false, network: false })
    })

    render(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams(`libraryArtifact=${artifactId}`)} />)
    await screen.findByText('safe.html')
    fireEvent.click(screen.getByRole('button', { name: 'Load safe preview' }))

    const frame = await screen.findByTitle('Static preview of safe.html')
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'")
    expect(document.body.textContent).not.toContain('safe</p>')
  })

  it('integrity-verifies PDF bytes before creating a sandboxed object URL and revokes it on unmount', async () => {
    const pdf = '%PDF-1.4\n%%EOF'
    const pdfPreview = { kind: 'pdf' as const, preview_available: true }
    const pdfDetail = { ...detail, filename: 'review copy.pdf', latest: { ...detail.latest, filename: 'review copy.pdf', size: pdf.length, sha256: '4f1949e95440af0ece666ebd5f399c1d77d22de639950784d349fa5feb47dca5', mime_type: 'application/pdf', preview: pdfPreview } }

    const fake = gateway({
      libraryCapabilities: vi.fn().mockResolvedValue(capabilities(64)),
      getLibraryArtifact: vi.fn().mockResolvedValue(pdfDetail),
      previewLibraryArtifact: vi.fn().mockResolvedValue({ artifact_id: artifactId, version_id: versionId, data_base64: encoded(pdf), offset: 0, next_offset: pdf.length, eof: true, size: pdf.length, sha256: pdfDetail.latest.sha256, filename: pdfDetail.filename, mime_type: 'application/pdf', descriptor: 'pdf-transfer', preview: pdfPreview })
    })

    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest')
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:verified-pdf')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const view = render(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams(`libraryArtifact=${artifactId}`)} />)

    await screen.findByText(pdfDetail.filename)
    fireEvent.click(screen.getByRole('button', { name: 'Load safe preview' }))

    const frame = await screen.findByTitle(`PDF preview of ${pdfDetail.filename}`)
    expect(frame.getAttribute('src')).toBe('blob:verified-pdf')
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(digest).toHaveBeenCalledOnce()
    expect(digest).toHaveBeenCalledWith('SHA-256', expect.any(ArrayBuffer))
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect((createObjectURL.mock.calls[0][0] as Blob).type).toBe('application/pdf')

    view.unmount()
    expect(revokeObjectURL.mock.calls.filter(([url]) => url === 'blob:verified-pdf')).toHaveLength(1)
  })

  it('renders JSON as an explicit inert plain-text fallback', async () => {
    const json = '{"script":"<img src=x onerror=alert(1)>"}'
    const jsonPreview = { kind: 'text' as const, preview_available: true }
    const jsonDetail = { ...detail, filename: 'receipt.json', latest: { ...detail.latest, filename: 'receipt.json', mime_type: 'application/json', preview: jsonPreview } }
    const fake = gateway({
      libraryCapabilities: vi.fn().mockResolvedValue(capabilities(1024)),
      getLibraryArtifact: vi.fn().mockResolvedValue(jsonDetail),
      previewLibraryArtifact: vi.fn().mockResolvedValue({ artifact_id: artifactId, version_id: versionId, data_base64: encoded(json), offset: 0, next_offset: json.length, eof: true, size: json.length, sha256: '7eb369fc33c1b63a59e05de5bbbea22f98099ec2feffc21dce39b8fbc3758bab', filename: 'receipt.json', mime_type: 'application/json', descriptor: 'signed-transfer', preview: jsonPreview })
    })

    render(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams(`libraryArtifact=${artifactId}`)} />)
    await screen.findByText('receipt.json')
    fireEvent.click(screen.getByRole('button', { name: 'Load safe preview' }))

    expect(await screen.findByText('JSON is shown as inert plain text; no embedded content is executed.')).toBeTruthy()
    expect(screen.getByText(json)).toBeTruthy()
    expect(document.querySelector('.library-preview img')).toBeNull()
  })

  it('rejects an HTML preview if the backend sandbox contract is not inert', async () => {
    const unsafeHtml = '<script>alert(1)</script>'
    const htmlDetail = { ...detail, filename: 'unsafe.html', latest: { ...detail.latest, filename: 'unsafe.html', mime_type: 'text/html', preview: { kind: 'html' as const, preview_available: true } } }
    const fake = gateway({ libraryCapabilities: vi.fn().mockResolvedValue(capabilities(1024)), getLibraryArtifact: vi.fn().mockResolvedValue(htmlDetail), previewLibraryArtifact: vi.fn().mockResolvedValue({ artifact_id: artifactId, data_base64: encoded(unsafeHtml), offset: 0, next_offset: unsafeHtml.length, eof: true, size: unsafeHtml.length, sha256: item.sha256, filename: 'unsafe.html', mime_type: 'text/html', descriptor: 'signed-transfer', preview: htmlDetail.latest.preview, sandbox: 'allow-scripts', scripts: true, network: false }) })
    render(<Library gateway={fake} onNavigate={vi.fn()} params={new URLSearchParams(`libraryArtifact=${artifactId}`)} />)
    await screen.findByText('unsafe.html')
    fireEvent.click(screen.getByRole('button', { name: 'Load safe preview' }))
    expect((await screen.findByRole('alert')).textContent).toContain('did not satisfy the static sandbox contract')
    expect(screen.queryByTitle(/Static preview/)).toBeNull()
  })

  it('assembles an authenticated original download from bounded base64 chunks', async () => {
    const payload = 'abcdefghij'
    const calls: number[] = []

    const fake = gateway({
      libraryCapabilities: vi.fn().mockResolvedValue(capabilities(4)),
      downloadLibraryArtifact: vi.fn(async ({ offset = 0, chunk_size = 4 }): Promise<LibraryChunk> => {
      calls.push(offset)
      const part = payload.slice(offset, offset + chunk_size)

      return { artifact_id: artifactId, version_id: versionId, data_base64: encoded(part), offset, next_offset: offset + part.length, eof: offset + part.length === payload.length, size: payload.length, sha256: '72399361da6a7754fec986dca5b7cbaf1c810a28ded4abaf56b2106d06cb78b0', filename: 'original.txt', mime_type: 'text/plain', descriptor: 'signed-transfer' }
    }) })

    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    await downloadOriginal(fake, artifactId)

    expect(calls).toEqual([0, 4, 8])
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:download')
  })

  it('sanitizes the response filename and derives MIME from verified bytes instead of trusting RPC metadata', async () => {
    const payload = '%PDF-1.4 safe'
    const fake = gateway({
      libraryCapabilities: vi.fn().mockResolvedValue(capabilities(64)),
      downloadLibraryArtifact: vi.fn().mockResolvedValue({ artifact_id: artifactId, version_id: versionId, data_base64: encoded(payload), offset: 0, next_offset: payload.length, eof: true, size: payload.length, sha256: '160a6c2fd11e5cac5cf602020bcd0ec1103e5ba0909a49007f20b71196bbaf58', filename: '..\\..\\evil\r\nContent-Type: text/html.pdf', mime_type: 'text/html', descriptor: 'signed-transfer' })
    })
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:safe-download')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    let downloadName = ''
    click.mockImplementation(function (this: HTMLAnchorElement) {downloadName = this.download})

    await downloadOriginal(fake, artifactId)

    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('application/pdf')
    expect(downloadName).toBe('evil__Content-Type_ text_html.pdf')
  })

  it.each([
    ['table.csv', 'a,b\n1,2\n', 'text/csv', '492d5ea496056f1a6a6592241032fab764c321596317930b4fa0e1e8bc3b7470'],
    ['bundle.zip', 'PK\x03\x04archive', 'application/octet-stream', 'dcc1841c1b0e90ad511c0379c285b5a0ee835538758f374d1025b2319b90c705'],
    ['disguised.pdf', '<html>unsafe</html>', 'application/octet-stream', 'fd9da466e93958cd71683e55b776e25fa51df05c45dff3b6bbdcf0312bb6384a'],
    ['disguised.png', 'not a png', 'application/octet-stream', '2aade9c49b9414c70f452b226271ef5066e2894cdd0557f54857819fb7bcc782']
  ])('uses a safe download MIME for %s', async (filename, payload, expectedMime, sha256) => {
    const fake = gateway({ libraryCapabilities: vi.fn().mockResolvedValue(capabilities(64)), downloadLibraryArtifact: vi.fn().mockResolvedValue({ artifact_id: artifactId, data_base64: encoded(payload), offset: 0, next_offset: payload.length, eof: true, size: payload.length, sha256, filename, mime_type: 'text/html', descriptor: 'signed-transfer' }) })
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:safe-mime')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    await downloadOriginal(fake, artifactId)

    expect((createObjectURL.mock.calls[0][0] as Blob).type).toBe(expectedMime)
  })

  it('refuses an original download whose bytes do not match the declared digest', async () => {
    const fake = gateway({
      libraryCapabilities: vi.fn().mockResolvedValue(capabilities(16)),
      downloadLibraryArtifact: vi.fn().mockResolvedValue({ artifact_id: artifactId, version_id: versionId, data_base64: encoded('tampered'), offset: 0, next_offset: 8, eof: true, size: 8, sha256: '0'.repeat(64), filename: 'original.txt', mime_type: 'text/plain', descriptor: 'signed-transfer' })
    })
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')
    createObjectURL.mockClear()

    await expect(downloadOriginal(fake, artifactId)).rejects.toThrow('failed integrity verification')
    expect(createObjectURL).not.toHaveBeenCalled()
    createObjectURL.mockRestore()
  })

  it('shows list errors and unsupported preview messages honestly', async () => {
    const failing = gateway({ listLibrary: vi.fn().mockRejectedValue(new Error('Owner authorization expired.')) })
    const { unmount } = render(<Library gateway={failing} onNavigate={vi.fn()} params={new URLSearchParams()} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Owner authorization expired.')
    unmount()

    const unsupportedDetail = { ...detail, latest: { ...detail.latest, preview: { kind: 'unsupported' as const, preview_available: false, message: 'No browser-safe preview exists.' } } }
    const unsupported = gateway({ getLibraryArtifact: vi.fn().mockResolvedValue(unsupportedDetail), previewLibraryArtifact: vi.fn().mockResolvedValue({ artifact_id: artifactId, available: false, preview: unsupportedDetail.latest.preview }) })
    render(<Library gateway={unsupported} onNavigate={vi.fn()} params={new URLSearchParams(`libraryArtifact=${artifactId}`)} />)
    await screen.findByText(item.filename)
    fireEvent.click(screen.getByRole('button', { name: 'Load safe preview' }))
    expect(await screen.findByText('No browser-safe preview exists.')).toBeTruthy()
  })

  it('falls back to canonical select values for untrusted URL enums', async () => {
    render(<Library gateway={gateway()} onNavigate={vi.fn()} params={new URLSearchParams('libraryType=forged&libraryDate=never&libraryStatus=hacked')} />)
    await waitFor(() => expect(screen.queryByText('Loading the complete Library…')).toBeNull())
    expect((screen.getByLabelText('Type') as HTMLSelectElement).value).toBe('all')
    expect((screen.getByLabelText('Date') as HTMLSelectElement).value).toBe('any')
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('all')
    expect(screen.queryByText('Filters active')).toBeNull()
  })

  it.each([
    ['relative_path', (raw: unknown) => validateLibraryList(raw), { ...complete(), items: [{ ...item, relative_path: 'private/report.md' }] }],
    ['absolutePath', (raw: unknown) => validateLibraryDetail(raw), { ...detail, absolutePath: '/Users/alice/private/report.md' }],
    ['file_url', (raw: unknown) => validateLibraryList(raw), { ...complete(), metadata: { file_url: 'file:///private/report.md' } }],
    ['uri', (raw: unknown) => validateLibraryDetail(raw), { ...detail, provenanceEnvelope: { uri: 'file:///private/report.md' } }],
    ['filepath', (raw: unknown) => validateLibraryList(raw), { ...complete(), metadata: { filepath: '/private/report.md' } }],
    ['source_file', (raw: unknown) => validateLibraryDetail(raw), { ...detail, metadata: { source_file: '/private/report.md' } }],
    ['canonical-file-path', (raw: unknown) => validateLibraryList(raw), { ...complete(), metadata: { 'canonical-file-path': '/private/report.md' } }],
    ['resourceUri', (raw: unknown) => validateLibraryDetail(raw), { ...detail, metadata: { resourceUri: 'file:///private/report.md' } }]
  ])('rejects unexpected %s path-bearing fields in an RPC response', (_kind, validate, raw) => {
    expect(() => validate(raw)).toThrow(/path-bearing field/i)
  })

  it('does not reject legitimate non-path metadata whose names merely contain similar text', () => {
    expect(() => validateLibraryList({ ...complete(), metadata: { filename: 'report.md', profile: 'atlas', file_size: 8, source_label: 'scanner', url_label: 'canonical source' } })).not.toThrow()
  })
})
