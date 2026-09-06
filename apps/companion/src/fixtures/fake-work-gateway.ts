import type { LibraryChunkOptions, LibraryListOptions } from '../features/library/library-types'
import type { WorkCard, WorkCommentParams, WorkDecisionParams, WorkDetail } from '../gateway/work-types'

import { FakeCompanionGateway } from './fake-gateway'

/** Synthetic visual QA only. Never selected by the real gateway or auth path. */
export class FakeWorkGateway extends FakeCompanionGateway {
  private readonly libraryBytes = new TextEncoder().encode('# Synthetic campaign brief\n\nFixture preview only.')
  private work = new Map<string, WorkDetail>(['review', 'snoozed', 'pending', 'idea', 'closed'].map((id) => {
    const item: WorkCard = {
      id: `fixture-${id}`, profile: 'atlas', source_key: `synthetic:${id}`,
      title: `[SYNTHETIC QA] ${id === 'review' ? 'Prepare a sample campaign brief' : id === 'snoozed' ? 'Snoozed sample proposal' : id === 'pending' ? 'Approved sample awaiting tracker' : id === 'idea' ? 'Explore a sample idea' : 'Closed sample proposal'}`,
      brief: 'Fixture data only — no real customer, publication, spending or execution.\nReview a deliberately long sample brief on desktop and phone. Prepare two draft alternatives and compare the evidence before any separate external authorization.',
      state: id === 'pending' ? 'in_progress' : id === 'idea' ? 'ideas' : id === 'closed' ? 'declined' : 'needs_me',
      evidence: ['Synthetic evidence note; not a production source.', 'https://example.org/synthetic-research'],
      next_action: 'Review this synthetic revision', owner: 'Synthetic reviewer', revision: 2, version: 3,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
      snoozed_until: id === 'snoozed' ? '2099-12-01T12:00:00Z' : null,
      attention_due: id === 'review', attention_key: `synthetic:${id}:2`,
      approval: id === 'pending' ? { revision: 2, scope: 'preparation_only', decision_id: 'synthetic-approved' } : null,
      preparation_status: id === 'pending' ? 'approved_task_linking_pending' : 'not_authorized', handoff_key: id === 'pending' ? 'synthetic-handoff' : null, execution_link: null, tracker_evidence: null, completion_evidence: null
    }

    return [item.id, { item, comments: [{ id: `synthetic-comment-${id}`, card_id: item.id, revision: 1, actor: 'agent', text: 'Synthetic discussion: which audience should the draft address?', created_at: item.created_at }], decisions: [{ id: `synthetic-decision-${id}`, card_id: item.id, revision: 1, action: 'request_changes', actor: 'Synthetic human', reason: 'Synthetic earlier review: narrow the scope.', snoozed_until: null, created_at: item.created_at, scope: 'none' }], tracker_status_history: [] }]
  }))

  async workCapabilities(_profile: string) { return { can_decide: true, reason: 'SYNTHETIC QA ONLY — simulated human; no real authorization.' } }
  async libraryCapabilities() { return { version: 1 as const, max_page_size: 500, max_chunk_size: 65_536, download_transport: 'authenticated_json_rpc_base64_chunks' as const, transfer_consistency: 'signed_immutable_descriptor' as const, html_preview: 'sanitized_static_document' as const, relationship_filters: ['collection', 'project', 'topic', 'session', 'status'] as ['collection', 'project', 'topic', 'session', 'status'], evidence_pin: 'explicit_owner_reviewed_latest' as const } }
  async libraryProfiles() { return { items: [{ profile: 'atlas', configured: true }], backend_namespace: 'fixture-mac-mini', as_of: '2026-01-04T00:00:00Z' } }
  async listLibrary(options: LibraryListOptions = {}) {
    const candidate = { artifact_id: `art_${'a'.repeat(64)}`, profile: 'atlas', collection: { id: 'synthetic', name: '[SYNTHETIC QA] Outputs', owner: 'atlas', availability: 'available' }, filename: 'synthetic-campaign-brief.md', version_id: `ver_${'b'.repeat(64)}`, size: this.libraryBytes.length, sha256: 'c'.repeat(64), mime_type: 'text/markdown', availability: 'available', reviewed: true, version_count: 1, date: '2026-01-02T00:00:00Z', preview: { kind: 'markdown' as const, preview_available: true } }
    const items = (!options.search || candidate.filename.includes(options.search)) && (!options.collection || options.collection === 'synthetic') && (!options.type || options.type === 'markdown') && (options.reviewed === undefined || options.reviewed) ? [candidate] : []

    return structuredClone({ items, collections: [candidate.collection], has_more: false, next_cursor: null, total: items.length, as_of: '2026-01-04T00:00:00Z', coverage: { configured: true, status: 'complete' as const, collections: { synthetic: 'available' } }, warnings: ['Synthetic QA source.'], profile: 'atlas', backend_namespace: 'fixture-mac-mini' })
  }
  async getLibraryArtifact(artifactId: string) {
    const listed = await this.listLibrary()

    if (artifactId !== listed.items[0]?.artifact_id) {throw { code: 4404 }}
    const item = listed.items[0]
    const version = { version_id: item.version_id!, filename: item.filename, size: item.size, sha256: item.sha256, mime_type: item.mime_type, ingested_at: item.date!, reviewed: true, availability: 'available', preview: item.preview, provenance: { source: 'Synthetic fixture' } }

    return structuredClone({ artifact_id: item.artifact_id, profile: item.profile, backend_namespace: 'fixture-mac-mini', collection: item.collection, filename: item.filename, versions: [version], latest: version, as_of: '2026-01-04T00:00:00Z' })
  }
  async previewLibraryArtifact(options: LibraryChunkOptions) { return this.libraryChunk(options, true) }
  async downloadLibraryArtifact(options: LibraryChunkOptions) { return this.libraryChunk(options, false) }
  async pinReviewedLibraryArtifact() { return { ok: true } }
  async listCompanionSessions({ profile }: { profile: string; limit?: number; cursor?: string }) {
    const sessions = profile === 'atlas' ? [{ id: 'synthetic-session-1', title: '[SYNTHETIC QA] Desktop research session', profile, source: 'fixture-mac-mini', origin: 'desktop', opened_in: ['desktop'], archived: false, hidden: false, started_at: '2026-01-01T00:00:00Z', last_active: '2026-01-02T00:00:00Z', status: 'completed', project: { id: 'synthetic-project-1', title: '[SYNTHETIC QA] Companion project', profile }, linked_work_count: 1, message_count: 3 }, { id: 'synthetic-session-empty', title: '[SYNTHETIC QA] Unlinked saved session', profile, source: 'fixture-mac-mini', origin: null, opened_in: [], archived: false, hidden: false, started_at: '2026-01-03T00:00:00Z', last_active: '2026-01-03T00:00:00Z', status: null, project: null, linked_work_count: 0, message_count: 0 }] : []

    return structuredClone({ sessions, has_more: false, next_cursor: null, coverage: { complete: true, freshness: '2026-01-04T00:00:00Z', message: 'Synthetic QA source.' } })
  }
  async getCompanionSessionHistory(profile: string, id: string) {
    return structuredClone({ session_id: id, profile, source: 'fixture-mac-mini', entries: [{ id: 'synthetic-message-user', kind: 'message' as const, role: 'user' as const, content: 'Synthetic request for read-only QA.', label: null, occurred_at: '2026-01-01T00:00:00Z' }, { id: 'synthetic-internal', kind: 'internal' as const, role: null, content: '', label: 'Internal event', occurred_at: '2026-01-01T00:01:00Z' }, { id: 'synthetic-message-assistant', kind: 'message' as const, role: 'assistant' as const, content: 'Synthetic response for read-only QA.', label: null, occurred_at: '2026-01-01T00:02:00Z' }], linked_work: id === 'synthetic-session-1' ? [{ id: 'fixture-review', title: '[SYNTHETIC QA] Prepare a sample campaign brief', status: 'needs_me' }] : [], linked_work_available: true, has_more: false, next_cursor: null, coverage: { complete: true, freshness: '2026-01-04T00:00:00Z', message: null } })
  }
  async listCompanionProjects({ profile }: { profile: string; limit?: number; cursor?: string }) {
    const projects = profile === 'atlas' ? [{ id: 'synthetic-project-1', title: '[SYNTHETIC QA] Companion project', profile, source: 'fixture-mac-mini', type: 'desktop_project' as const, archived: false, last_active: '2026-01-02T00:00:00Z', session_count: 1, linked_work_count: 1, freshness: '2026-01-04T00:00:00Z' }, { id: 'synthetic-project-empty', title: '[SYNTHETIC QA] Empty Desktop project', profile, source: 'fixture-mac-mini', type: 'desktop_project' as const, archived: false, last_active: null, session_count: 0, linked_work_count: 0, freshness: '2026-01-04T00:00:00Z' }] : []

    return structuredClone({ projects, has_more: false, next_cursor: null, coverage: { complete: true, freshness: '2026-01-04T00:00:00Z', message: 'Synthetic QA source.' } })
  }
  async getCompanionProject(profile: string, id: string, _cursor?: string) {
    const projects = (await this.listCompanionProjects({ profile })).projects
    const project = projects.find((item) => item.id === id)

    if (!project) {throw { code: 4404 }}
    const sessions = id === 'synthetic-project-1' ? (await this.listCompanionSessions({ profile })).sessions.slice(0, 1) : []

    return structuredClone({ project, sessions, topics: [], needs_me: [], work: [], organization_available: false, membership_has_more: false, membership_next_cursor: null, coverage: { complete: true, freshness: '2026-01-04T00:00:00Z', message: null } })
  }
  async listWork(profile: string) { return structuredClone({ items: [...this.work.values()].filter(({ item }) => item.profile === profile).map(({ item }) => item) }) }
  async getWork(profile: string, id: string) { return structuredClone(this.lookup(profile, id)) }
  async commentWork(params: WorkCommentParams) {
    const detail = this.lookup(params.profile, params.id)
    const comment = { id: params.idempotency_key, card_id: params.id, revision: detail.item.revision, actor: 'human' as const, text: params.text, created_at: new Date().toISOString() }
    detail.comments.push(comment)

    return structuredClone({ comment })
  }
  async decideWork(params: WorkDecisionParams) {
    const detail = this.lookup(params.profile, params.id)
    const item = detail.item

    if (item.version !== params.expected_version || item.revision !== params.revision || !item.attention_due) {throw { code: 4409 }}
    const decision = { id: params.idempotency_key, card_id: item.id, revision: item.revision, action: params.action, actor: 'Synthetic human', reason: params.reason ?? '', snoozed_until: params.snoozed_until ?? null, created_at: new Date().toISOString(), scope: params.action === 'approve_preparation' ? 'preparation_only' as const : 'none' as const }
    detail.decisions.push(decision)
    item.version += 1
    item.attention_due = false
    item.state = params.action === 'approve_preparation' ? 'in_progress' : params.action === 'decline' ? 'declined' : params.action === 'request_changes' ? 'ideas' : 'needs_me'
    item.snoozed_until = decision.snoozed_until

    if (params.action === 'approve_preparation') {
      item.approval = { revision: item.revision, scope: 'preparation_only', decision_id: decision.id }
      item.preparation_status = 'approved_task_linking_pending'
      item.handoff_key = 'synthetic-handoff'
    }

    return structuredClone({ item, decision })
  }
  private lookup(profile: string, id: string): WorkDetail {
    const detail = this.work.get(id)

    if (!detail || detail.item.profile !== profile) {throw { code: 4404 }}

    return detail
  }
  private async libraryChunk(options: LibraryChunkOptions, preview: boolean) {
    const detail = await this.getLibraryArtifact(options.artifact_id)
    const offset = options.offset ?? 0
    const end = Math.min(offset + (options.chunk_size ?? 65_536), this.libraryBytes.length)
    let binary = ''

    for (const byte of this.libraryBytes.slice(offset, end)) {binary += String.fromCharCode(byte)}

    return { artifact_id: detail.artifact_id, version_id: detail.latest.version_id, data_base64: btoa(binary), offset, next_offset: end, eof: end === this.libraryBytes.length, size: this.libraryBytes.length, sha256: detail.latest.sha256, filename: detail.filename, mime_type: detail.latest.mime_type, descriptor: 'synthetic-signed-transfer', ...(preview ? { preview: detail.latest.preview } : {}) }
  }
}
export const createFakeWorkGateway = () => new FakeWorkGateway()
