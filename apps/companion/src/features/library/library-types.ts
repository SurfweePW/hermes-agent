export type LibraryPreviewKind = 'markdown' | 'text' | 'image' | 'pdf' | 'html' | 'unsupported'

export interface LibraryCapabilities {
  version: number
  max_page_size: number
  max_chunk_size: number
  download_transport: 'authenticated_json_rpc_base64_chunks'
  transfer_consistency: 'signed_immutable_descriptor'
  html_preview: 'sanitized_static_document'
  relationship_filters: ['collection', 'project', 'topic', 'session', 'status']
  evidence_pin: 'explicit_owner_reviewed_latest'
}

export interface LibraryCollection {
  id: string
  name: string
  owner: string
  description?: string
  availability: string
}

export interface LibraryPreviewPolicy {
  kind: LibraryPreviewKind
  preview_available: boolean
  message?: string
  sandbox?: string
  scripts?: boolean
  network?: boolean
  content_security_policy?: string
}

export interface LibraryRelatedLink {
  kind: 'project' | 'topic' | 'session'
  id: string
  title?: string
  profile: string
  backend_namespace: string
}

export interface LibraryVersion {
  version_id: string
  title?: string
  filename: string
  size: number
  sha256: string
  mime_type: string
  ingested_at?: string
  reviewed: boolean
  availability: string
  preview: LibraryPreviewPolicy
  provenance?: unknown
  related_links?: LibraryRelatedLink[]
}

export interface LibraryItem {
  artifact_id: string
  profile: string
  collection: LibraryCollection
  filename: string
  version_id?: string
  size: number
  sha256: string
  mime_type: string
  availability: string
  reviewed: boolean
  version_count: number
  date: string | null
  preview: LibraryPreviewPolicy
  related_links?: LibraryRelatedLink[]
}

export interface LibraryCoverage {
  configured: boolean
  status: 'unconfigured' | 'complete' | 'partial'
  collections: Record<string, string>
}

export interface LibraryListOptions {
  profile?: string
  search?: string
  collection?: string
  type?: Exclude<LibraryPreviewKind, 'unsupported'> | 'unsupported'
  date_from?: string
  date_to?: string
  reviewed?: boolean
  limit?: number
  cursor?: string
  project?: string
  topic?: string
  session?: string
}

export interface LibraryListResult {
  items: LibraryItem[]
  collections: LibraryCollection[]
  has_more: boolean
  next_cursor: string | null
  total?: number
  as_of: string
  coverage: LibraryCoverage
  warnings: string[]
  profile: string
  backend_namespace: string
}

export interface LibraryDetail {
  artifact_id: string
  profile: string
  backend_namespace: string
  collection: LibraryCollection
  filename: string
  versions: LibraryVersion[]
  latest: Omit<LibraryVersion, 'version_id'> & { version_id?: string }
  as_of: string
}

export interface LibraryChunkOptions {
  profile?: string
  artifact_id: string
  version_id?: string
  latest?: boolean
  offset?: number
  chunk_size?: number
  descriptor?: string
}

export interface LibraryChunk {
  artifact_id: string
  version_id?: string | null
  available?: boolean
  preview?: LibraryPreviewPolicy
  data_base64?: string
  offset?: number
  next_offset?: number
  eof?: boolean
  size?: number
  sha256?: string
  filename?: string
  mime_type?: string
  sandbox?: string
  scripts?: boolean
  network?: boolean
  content_security_policy?: string
  descriptor?: string
}

export interface LibraryProfilesResult {
  items: { profile: string; configured: boolean }[]
  backend_namespace: string
  as_of: string
}

export interface LibraryPinOptions {
  profile: string
  artifact_id: string
  reviewed_descriptor: string
  provenance: Record<string, unknown> | string
  title?: string
}

export interface LibraryGateway {
  libraryCapabilities(): Promise<LibraryCapabilities>
  libraryProfiles(): Promise<LibraryProfilesResult>
  listLibrary(options: LibraryListOptions): Promise<LibraryListResult>
  getLibraryArtifact(artifactId: string, profile?: string): Promise<LibraryDetail>
  previewLibraryArtifact(options: LibraryChunkOptions): Promise<LibraryChunk>
  downloadLibraryArtifact(options: LibraryChunkOptions): Promise<LibraryChunk>
  pinReviewedLibraryArtifact(options: LibraryPinOptions): Promise<unknown>
}

const record = (value: unknown, method: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {throw new Error(`Malformed ${method} response.`)}

  return value as Record<string, unknown>
}

const string = (value: unknown, method: string) => {
  if (typeof value !== 'string') {throw new Error(`Malformed ${method} response.`)}

  return value
}

const integer = (value: unknown, method: string) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {throw new Error(`Malformed ${method} response.`)}

  return value as number
}

const boolean = (value: unknown, method: string) => {
  if (typeof value !== 'boolean') {throw new Error(`Malformed ${method} response.`)}

  return value
}

const strings = (value: unknown, method: string) => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {throw new Error(`Malformed ${method} response.`)}

  return [...value] as string[]
}

const previewPolicy = (value: unknown, method: string): LibraryPreviewPolicy => {
  const raw = record(value, method)
  const kinds = new Set<LibraryPreviewKind>(['markdown', 'text', 'image', 'pdf', 'html', 'unsupported'])
  const kind = string(raw.kind, method) as LibraryPreviewKind

  if (!kinds.has(kind)) {throw new Error(`Malformed ${method} response.`)}
  const result: LibraryPreviewPolicy = { kind, preview_available: boolean(raw.preview_available, method) }

  if (typeof raw.message === 'string') {result.message = raw.message}

  if (typeof raw.sandbox === 'string') {result.sandbox = raw.sandbox}

  if (typeof raw.scripts === 'boolean') {result.scripts = raw.scripts}

  if (typeof raw.network === 'boolean') {result.network = raw.network}

  if (typeof raw.content_security_policy === 'string') {result.content_security_policy = raw.content_security_policy}

  return result
}

const collection = (value: unknown, method: string): LibraryCollection => {
  const raw = record(value, method)

  return { id: string(raw.id, method), name: string(raw.name, method), owner: string(raw.owner, method), availability: string(raw.availability, method), ...(typeof raw.description === 'string' ? { description: raw.description } : {}) }
}

const relatedLinks = (value: unknown, method: string): LibraryRelatedLink[] => {
  if (value === undefined) {return []}
  if (!Array.isArray(value)) {throw new Error(`Malformed ${method} response.`)}

  return value.map((entry) => {
    const raw = record(entry, method)
    const kind = string(raw.kind, method)

    if (!['project', 'topic', 'session'].includes(kind)) {throw new Error(`Malformed ${method} response.`)}

    return { kind: kind as LibraryRelatedLink['kind'], id: string(raw.id, method), profile: string(raw.profile, method), backend_namespace: string(raw.backend_namespace, method), ...(typeof raw.title === 'string' ? { title: raw.title } : {}) }
  })
}

const item = (value: unknown, method: string): LibraryItem => {
  const raw = record(value, method)
  const date = raw.date === null ? null : string(raw.date, method)

  return { artifact_id: string(raw.artifact_id, method), profile: string(raw.profile, method), collection: collection(raw.collection, method), filename: string(raw.filename, method), ...(typeof raw.version_id === 'string' ? { version_id: raw.version_id } : {}), size: integer(raw.size, method), sha256: string(raw.sha256, method), mime_type: string(raw.mime_type, method), availability: string(raw.availability, method), reviewed: boolean(raw.reviewed, method), version_count: integer(raw.version_count, method), date, preview: previewPolicy(raw.preview, method), related_links: relatedLinks(raw.related_links, method) }
}

const version = (value: unknown, method: string): LibraryVersion => {
  const raw = record(value, method)

  return { version_id: string(raw.version_id, method), filename: string(raw.filename, method), size: integer(raw.size, method), sha256: string(raw.sha256, method), mime_type: string(raw.mime_type, method), reviewed: boolean(raw.reviewed, method), availability: string(raw.availability, method), preview: previewPolicy(raw.preview, method), ...(Object.prototype.hasOwnProperty.call(raw, 'provenance') ? { provenance: raw.provenance } : {}), related_links: relatedLinks(raw.related_links, method) }
}

export function validateLibraryProfiles(value: unknown): LibraryProfilesResult {
  const method = 'companion.library.profiles'
  const raw = record(value, method)

  if (!Array.isArray(raw.items)) {throw new Error(`Malformed ${method} response.`)}

  return { items: raw.items.map((entry) => {const item = record(entry, method); return { profile: string(item.profile, method), configured: boolean(item.configured, method) }}), backend_namespace: string(raw.backend_namespace, method), as_of: string(raw.as_of, method) }
}

export function validateLibraryCapabilities(value: unknown): LibraryCapabilities {
  const method = 'companion.library.capabilities'
  const raw = record(value, method)
  const relationshipFilters = ['collection', 'project', 'topic', 'session', 'status'] as const

  if (raw.version !== 1 || raw.download_transport !== 'authenticated_json_rpc_base64_chunks' || raw.transfer_consistency !== 'signed_immutable_descriptor' || raw.html_preview !== 'sanitized_static_document' || raw.evidence_pin !== 'explicit_owner_reviewed_latest' || !Array.isArray(raw.relationship_filters) || raw.relationship_filters.length !== relationshipFilters.length || !raw.relationship_filters.every((entry, index) => entry === relationshipFilters[index])) {throw new Error(`Unsupported ${method} response.`)}

  return { version: 1, max_page_size: integer(raw.max_page_size, method), max_chunk_size: integer(raw.max_chunk_size, method), download_transport: raw.download_transport, transfer_consistency: raw.transfer_consistency, html_preview: raw.html_preview, relationship_filters: ['collection', 'project', 'topic', 'session', 'status'], evidence_pin: raw.evidence_pin }
}

export function validateLibraryList(value: unknown): LibraryListResult {
  const method = 'companion.library.list'
  const raw = record(value, method)
  const coverageRaw = record(raw.coverage, method)

  if (!Array.isArray(raw.items) || !Array.isArray(raw.collections) || typeof raw.has_more !== 'boolean' || (raw.next_cursor !== null && typeof raw.next_cursor !== 'string') || (raw.has_more && !raw.next_cursor)) {throw new Error(`Malformed ${method} response.`)}
  const status = coverageRaw.status

  if (status !== 'unconfigured' && status !== 'complete' && status !== 'partial') {throw new Error(`Malformed ${method} response.`)}
  const coverageCollections = record(coverageRaw.collections, method)

  if (!Object.values(coverageCollections).every((entry) => typeof entry === 'string')) {throw new Error(`Malformed ${method} response.`)}

  return { items: raw.items.map((entry) => item(entry, method)), collections: raw.collections.map((entry) => collection(entry, method)), has_more: raw.has_more, next_cursor: raw.next_cursor as string | null, ...(raw.total === undefined ? {} : { total: integer(raw.total, method) }), as_of: string(raw.as_of, method), coverage: { configured: boolean(coverageRaw.configured, method), status, collections: coverageCollections as Record<string, string> }, warnings: strings(raw.warnings, method), profile: string(raw.profile, method), backend_namespace: string(raw.backend_namespace, method) }
}

export function validateLibraryDetail(value: unknown): LibraryDetail {
  const method = 'companion.library.get'
  const raw = record(value, method)

  if (!Array.isArray(raw.versions)) {throw new Error(`Malformed ${method} response.`)}
  const latestRaw = record(raw.latest, method)

  const latest = latestRaw.availability === 'unavailable'
    ? { filename: '', size: 0, sha256: '', mime_type: 'application/octet-stream', reviewed: false, availability: 'unavailable', preview: { kind: 'unsupported' as const, preview_available: false } }
    : version({ ...latestRaw, version_id: typeof latestRaw.version_id === 'string' ? latestRaw.version_id : 'latest' }, method)

  return { artifact_id: string(raw.artifact_id, method), profile: string(raw.profile, method), backend_namespace: string(raw.backend_namespace, method), collection: collection(raw.collection, method), filename: string(raw.filename, method), versions: raw.versions.map((entry) => version(entry, method)), latest, as_of: string(raw.as_of, method) }
}

export function validateLibraryChunk(value: unknown, method: 'companion.library.preview' | 'companion.library.download'): LibraryChunk {
  const raw = record(value, method)
  const result: LibraryChunk = { artifact_id: string(raw.artifact_id, method), ...(raw.version_id === null || typeof raw.version_id === 'string' ? { version_id: raw.version_id as string | null } : {}) }

  if (raw.available === false) {
    result.available = false
    result.preview = previewPolicy(raw.preview, method)

    return result
  }

  result.data_base64 = string(raw.data_base64, method)
  result.offset = integer(raw.offset, method)
  result.next_offset = integer(raw.next_offset, method)
  result.eof = boolean(raw.eof, method)
  result.size = integer(raw.size, method)
  result.sha256 = string(raw.sha256, method)
  result.filename = string(raw.filename, method)
  result.mime_type = string(raw.mime_type, method)
  result.descriptor = string(raw.descriptor, method)

  if (method.endsWith('preview')) {
    result.preview = previewPolicy(raw.preview, method)

    if (typeof raw.sandbox === 'string') {result.sandbox = raw.sandbox}

    if (typeof raw.scripts === 'boolean') {result.scripts = raw.scripts}

    if (typeof raw.network === 'boolean') {result.network = raw.network}

    if (typeof raw.content_security_policy === 'string') {result.content_security_policy = raw.content_security_policy}
  }

  return result
}
