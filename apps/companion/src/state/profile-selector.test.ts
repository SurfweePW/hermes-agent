import { describe, expect, it } from 'vitest'

import { buildProfileSelectorModel } from './profile-selector'

describe('buildProfileSelectorModel', () => {
  it('keeps unavailable profiles visible while exposing one shared selectable set', () => {
    const teammates = [
      { id: 'atlas', name: 'Atlas', initials: 'A', role: 'Chief of Staff', status: 'idle' as const, summary: '' },
      { id: 'mentor', name: 'Mentor', initials: 'M', role: 'Investments', status: 'idle' as const, summary: '' },
      { id: 'maven', name: 'Maven', initials: 'MV', role: 'Data Operations', status: 'idle' as const, summary: '' }
    ]
    const model = buildProfileSelectorModel(teammates, [
      { teammateId: 'atlas', profile: 'atlas', servedByGateway: true },
      { teammateId: 'mentor', profile: 'mentor', servedByGateway: true },
      { teammateId: 'maven', profile: 'maven', servedByGateway: false }
    ], [
      { profile: 'atlas', status: 'ready', backendNamespace: 'backend-1', complete: true, freshness: null, message: null, sessionCursor: null, projectCursor: null, sessionsHasMore: false, projectsHasMore: false, sessionComplete: true, projectComplete: true, sessionStatus: 'ready', projectStatus: 'ready' },
      { profile: 'mentor', status: 'error', backendNamespace: 'backend-1', complete: false, freshness: null, message: 'refused', sessionCursor: null, projectCursor: null, sessionsHasMore: false, projectsHasMore: false, sessionComplete: false, projectComplete: true, sessionStatus: 'error', projectStatus: 'ready' },
      { profile: 'maven', status: 'ready', backendNamespace: 'backend-1', complete: true, freshness: null, message: null, sessionCursor: null, projectCursor: null, sessionsHasMore: false, projectsHasMore: false, sessionComplete: true, projectComplete: true, sessionStatus: 'ready', projectStatus: 'ready' }
    ])

    expect(model.filter((option) => option.selectable).map((option) => option.profile)).toEqual(['atlas'])
    expect(model.map((option) => [option.profile, option.optionLabel])).toEqual([
      ['atlas', 'Atlas'],
      ['mentor', 'Mentor — niedostępny'],
      ['maven', 'Maven — niedostępny']
    ])
    expect(model[2]).toMatchObject({
      statusLabel: 'Niedostępny w tym połączeniu',
      detail: 'Ten profil nie jest obsługiwany przez bieżący gateway. Zmień konfigurację gatewaya, aby używać go w aplikacji.'
    })
  })
})
