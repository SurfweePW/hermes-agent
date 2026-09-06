import { describe, expect, it } from 'vitest'

import {
  validateCompanionProjectDetail,
  validateCompanionProjectList,
  validateCompanionSessionHistory,
  validateCompanionSessionList
} from './companion-client'

const identity = { profile: 'atlas', backend_namespace: 'desktop-db', root_id: 'session-1' }

const project = {
  id: 'project-1', name: 'Project one', kind: 'desktop_project', archived: false,
  profile: 'atlas', backend_namespace: 'desktop-db', session_count: 1, last_active: 1
}

function page<T extends Record<string, unknown>>(extra: T) {
  return { has_more: false, next_cursor: null, as_of: '2026-09-06T10:00:00Z', warnings: [], ...extra }
}

describe('Companion directory response validation', () => {
  it('validates session list identity and rejects malformed rows', () => {
    const raw = page({
      profile: 'atlas', backend_namespace: 'desktop-db', coverage: 'complete',
      items: [{ identity, root_id: 'session-1', title: 'Saved session', origin: 'desktop', archived: false, hidden: false, started_at: 1, last_active: 2, message_count: 3 }]
    })

    expect(validateCompanionSessionList(raw, 'atlas').sessions[0]).toMatchObject({ id: 'session-1', source: 'desktop-db' })
    expect(() => validateCompanionSessionList({ ...raw, items: [{ ...raw.items[0], identity: { ...identity, backend_namespace: 'forged' } }] }, 'atlas')).toThrow(/Malformed/)
  })

  it('requires authoritative history namespace and classifies compression summaries', () => {
    const raw = page({
      identity,
      coverage: 'bounded', warnings: ['History is bounded.'],
      items: [{ kind: 'message', row_id: 1, timestamp: 1, role: 'assistant', text: '[CONTEXT SUMMARY]: retained context' }]
    })

    expect(validateCompanionSessionHistory(raw, 'atlas', 'session-1', 'desktop-db').entries[0]).toMatchObject({ kind: 'compression', label: 'Compression summary' })
    expect(validateCompanionSessionHistory(raw, 'atlas', 'session-1', 'desktop-db').coverage).toMatchObject({ complete: false, message: 'History is bounded.' })
    expect(() => validateCompanionSessionHistory(raw, 'atlas', 'session-1', 'forged')).toThrow(/Malformed/)
  })

  it('validates project list and detail pagination shapes directly', () => {
    const list = page({
      profile: 'atlas', backend_namespace: 'desktop-db', coverage: { named_projects: 'complete', membership: 'complete' }, items: [project]
    })

    const detail = page({
      profile: 'atlas', backend_namespace: 'desktop-db',
      item: project,
      membership: { items: [{ id: 'session-1', title: 'Saved', source: 'desktop', started_at: 1, last_active: 2, message_count: 3 }], has_more: false, next_cursor: null, coverage: 'complete' }
    })

    expect(validateCompanionProjectList(list, 'atlas').projects[0].id).toBe('project-1')
    expect(validateCompanionProjectDetail(detail, 'atlas', 'project-1')).toMatchObject({ membership_has_more: false, sessions: [{ id: 'session-1' }] })
    expect(() => validateCompanionProjectList({ ...list, items: [{ ...project, backend_namespace: 'forged' }] }, 'atlas')).toThrow(/Malformed/)
    expect(() => validateCompanionProjectDetail({ ...detail, item: { ...project, backend_namespace: 'forged' } }, 'atlas', 'project-1')).toThrow(/Malformed/)
    expect(() => validateCompanionProjectDetail({ ...detail, membership: { ...detail.membership, has_more: true, next_cursor: null } }, 'atlas', 'project-1')).toThrow(/Malformed/)
  })
})
