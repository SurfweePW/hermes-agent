import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { safeLibraryReference, safeWorkUrl, type WorkCardView, WorkInbox, type WorkInboxProps } from './work-inbox'

export const card: WorkCardView = {
  id: 'work-1', profile: 'CMO Exact', title: 'Prepare campaign', brief: 'A focused business brief', revision: 2,
  status: 'needs_me', bucket: 'needs_me', evidence: [{ label: 'Research', url: 'https://example.org/report' }],
  permitted: ['Draft copy'], excluded: ['Publish'], nextAction: 'Review preparation', owner: 'Pawel',
  decision: 'Awaiting review', recommendedAction: 'approve_preparation', previews: [{ label: 'Unsafe preview', url: 'javascript:alert(1)' }],
  discussion: [{ id: 'c1', author: 'CMO', body: 'Which audience?' }], actionable: true, canDecide: true
}

function props(overrides: Partial<WorkInboxProps> = {}): WorkInboxProps {
  return { items: [card], selected: card, status: 'verified', pending: false, message: null, groupBy: 'topic', priorityWritable: false, sources: [],
    onOpen: vi.fn(), onOpenArtifact: vi.fn(), onOpenSourceSession: vi.fn(), onClose: vi.fn(), onRefresh: vi.fn(), onGroupBy: vi.fn(), onDecision: vi.fn(async () => true), onComment: vi.fn(async () => true), onPriority: vi.fn(async () => true), onRestorePriority: vi.fn(async () => true), ...overrides }
}

describe('durable work inbox', () => {
  it('answers the decision questions and links evidence, discussion and the source session', () => {
    const onOpenSourceSession = vi.fn()
    const priority = { profile: 'CMO Exact', work_id: 'work-1', candidate_id: 'candidate-1', eligibility: 'assessed' as const, why_here: 'The launch is blocked on this review.', next_step: 'Approve the bounded draft.', trade_off: 'Defers visual polish.', assessed_at: null, evidence: ['Assessment A'], assessment: null, override: null, topicName: 'Launch', group: { kind: 'topic' as const, id: 'topic-1', profile: 'CMO Exact', backend_namespace: 'organization-db' }, groupOrder: 0, itemOrder: 0 }
    const sourceSession = { backend: 'mac-mini', profile: 'CMO Exact', id: 'session-42' }
    render(<WorkInbox {...props({ onOpenSourceSession, selected: { ...card, priority, sourceSession } })} />)

    for (const name of ['Czego potrzebujemy od Ciebie', 'Dlaczego teraz', 'Rekomendacja', 'Co zmieni kliknięcie']) {expect(screen.getByRole('heading', { name })).toBeTruthy()}
    expect(screen.getByText(priority.why_here)).toBeTruthy()
    expect(screen.getByText((_text, element) => element?.tagName === 'P' && element.textContent?.includes(priority.next_step) === true)).toBeTruthy()
    expect(screen.getByText('Which audience?')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Research/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz rozmowę źródłową' }))
    expect(onOpenSourceSession).toHaveBeenCalledWith(sourceSession)
  })

  it('defaults to a vertical Do decyzji list and filters the same records from view options', () => {
    const p = props({ selected: null, items: [card, { ...card, id: 'progress', bucket: 'in_progress', status: 'in_progress', title: 'Preparing now' }] })
    render(<WorkInbox {...p} />)

    expect(screen.getByRole('heading', { name: 'Do decyzji' })).toBeTruthy()
    expect(screen.getByText(card.title)).toBeTruthy()
    expect(screen.queryByText('Preparing now')).toBeNull()
    const options = screen.getByText('Opcje widoku').closest('details') as HTMLDetailsElement
    expect(options.open).toBe(false)
    fireEvent.click(screen.getByText('Opcje widoku'))
    fireEvent.click(screen.getByRole('button', { name: 'W toku' }))
    expect(screen.getByText('Preparing now')).toBeTruthy()
    expect(screen.queryByText(card.title)).toBeNull()
  })
  it('shows dispatch and revision-scoped decision history without claiming execution', () => {
    render(<WorkInbox {...props({ selected: { ...card, status: 'in_progress', actionable: false,
      preparationStatus: 'Preparation approved — awaiting execution tracker task link',
      decisionHistory: [{ id: 'd1', revision: 1, action: 'request_changes', actor: 'human', reason: 'Narrow earlier scope', createdAt: '2026-01-01T00:00:00Z', scope: 'none', snoozedUntil: null }]
    } })} />)
    expect(screen.getByText('Preparation approved — awaiting execution tracker task link')).toBeTruthy()
    expect(screen.getByText('request changes · Rewizja 1')).toBeTruthy()
    expect(screen.getByText('Narrow earlier scope')).toBeTruthy()
    expect(screen.getByText(/połączenia przez współdzielony token i połączenia agentów pozostają tylko do odczytu/)).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Decyzja dla rewizji 2' }).hasAttribute('disabled')).toBe(true)
  })
  it('switching filters leaves detail and never retargets a pending decision', () => {
    const p = props(); const { rerender } = render(<WorkInbox {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pomysły' }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
    rerender(<WorkInbox {...p} pending />)
    fireEvent.click(screen.getByRole('button', { name: 'W toku' }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })

  it('renders revision, evidence, scope, owner and persisted discussion without active unsafe previews', () => {
    render(<WorkInbox {...props()} />)
    expect(screen.getByRole('heading', { name: card.title })).toBeTruthy()
    expect(screen.getByText('CMO Exact · needs_me · Rewizja 2')).toBeTruthy()

    for (const text of ['Draft copy', 'Publish', 'Pawel', 'Which audience?']) {expect(screen.getByText(text)).toBeTruthy()}
    expect(screen.getByRole('link', { name: /Research/ }).getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.queryByRole('link', { name: /Unsafe preview/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Zawsze zatwierdzaj/ })).toBeNull()
  })
  it('turns a structured producer brief into an understandable decision summary', () => {
    const brief = JSON.stringify({
      evidence_summary: 'Two creative cells are ready for a controlled draft.',
      inference: 'A local paused draft can now be prepared safely.',
      decision_scope: 'preparation',
      cost_boundary: 'No spend is authorized. A later test is capped at 500 PLN.',
      scope_boundary: 'Local draft preparation only. No activation or publication.',
      forbidden_actions: ['publish', 'activate paid'],
      artifacts: [{ path: 'reports/test-summary.md', sha256: 'a'.repeat(64) }]
    })

    const structuredCard = { ...card, brief }
    const view = render(<WorkInbox {...props({ items: [structuredCard], selected: structuredCard })} />)

    expect(screen.getByRole('heading', { name: 'O co chodzi' })).toBeTruthy()
    expect(screen.getByText('Two creative cells are ready for a controlled draft.')).toBeTruthy()
    expect(screen.getByText('A local paused draft can now be prepared safely.')).toBeTruthy()
    expect(screen.getByText((_text, element) => element?.tagName === 'P' && element.textContent === 'Zakres decyzji: preparation')).toBeTruthy()
    expect(screen.getByText('No spend is authorized. A later test is capped at 500 PLN.')).toBeTruthy()
    expect(screen.getByText('Local draft preparation only. No activation or publication.')).toBeTruthy()
    expect(screen.getByText('SHA-256: ' + 'a'.repeat(64))).toBeTruthy()
    expect(document.body.textContent).not.toContain('"evidence_summary"')

    view.rerender(<WorkInbox {...props({ items: [structuredCard], selected: null })} />)
    expect(screen.getByRole('button', { name: /Two creative cells are ready for a controlled draft/ })).toBeTruthy()
    expect(document.body.textContent).not.toContain('"evidence_summary"')
  })
  it('does not render or activate unprefixed filesystem-shaped evidence', () => {
    const unsafe = ['data/cmo/audits/paid-growth/report.md', 'summary.pdf', './relative/report.pdf', '/tmp/report.pdf', 'file:///tmp/report.pdf', 'C:\\Users\\atlas\\report.pdf', '\\\\server\\share\\report.pdf']
    const onOpenArtifact = vi.fn()

    render(<WorkInbox {...props({ onOpenArtifact, selected: { ...card, evidence: unsafe.map((reference) => ({ label: reference, url: reference })) } })} />)

    expect(screen.queryByRole('button', { name: /w plikach/ })).toBeNull()
    expect(onOpenArtifact).not.toHaveBeenCalled()
    for (const reference of unsafe) {expect(document.body.textContent).not.toContain(reference)}
  })
  it('opens a safe library reference with its full explicit identity', () => {
    const onOpenArtifact = vi.fn()
    const reference = 'library:campaigns/autumn/brief-v1.pdf'

    render(<WorkInbox {...props({ onOpenArtifact, selected: { ...card, evidence: [{ label: reference, url: reference }] } })} />)
    fireEvent.click(screen.getByRole('button', { name: `Otwórz ${reference} w plikach` }))

    expect(onOpenArtifact).toHaveBeenCalledWith('CMO Exact', reference)
    expect(document.body.textContent).not.toContain('/Users/')
  })
  it('preserves a Library reference embedded in a structured brief', () => {
    const onOpenArtifact = vi.fn()
    const structured = { ...card, brief: JSON.stringify({ artifacts: [{ path: 'library:campaigns/autumn/brief-v1.pdf' }] }) }

    render(<WorkInbox {...props({ onOpenArtifact, selected: structured })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz library:campaigns/autumn/brief-v1.pdf w plikach' }))

    expect(onOpenArtifact).toHaveBeenCalledWith('CMO Exact', 'library:campaigns/autumn/brief-v1.pdf')
  })

  it.each([
    'javascript:alert(1)', 'file:///etc/passwd', 'library:/etc/passwd', 'library:../secret.pdf',
    'library:campaigns/../../secret.pdf', 'library:campaigns\\secret.pdf', 'library:campaigns/%2e%2e/secret.pdf',
    'library:campaigns/brief.pdf?token=secret', 'library:campaigns/brief.pdf\u0000'
  ])('rejects unsafe Library reference %s', (reference) => {
    expect(safeLibraryReference(reference)).toBeUndefined()
  })
  it('renders tracker blocker, result, completion evidence and observed history', () => {
    render(<WorkInbox {...props({ selected: { ...card,
      trackerEvidence: { state: 'prepared', observed_at: '2026-09-06T11:00:00Z', evidence: ['tracker read-back'], result_evidence: ['prepared artifact'] },
      completionEvidence: ['final artifact'],
      trackerStatusHistory: [{ state: 'blocked', observed_at: '2026-09-06T10:00:00Z', evidence: ['block event'], blocker: 'Legal review' }]
    } })} />)
    expect(screen.getByText(/Zaobserwowano 2026-09-06T11:00:00Z/)).toBeTruthy()
    expect(screen.getByText(/Wynik:/)).toBeTruthy()
    expect(screen.getByText(/Blokada:/)).toBeTruthy()
    expect(screen.getByText('final artifact')).toBeTruthy()
  })
  it('switches Topic, Session and Project grouping through the control', () => {
    const p = props({ selected: null }); render(<WorkInbox {...p} />)
    fireEvent.change(screen.getByLabelText('Grupuj według'), { target: { value: 'session' } })
    expect(p.onGroupBy).toHaveBeenCalledWith('session')
  })
  it('keeps detailed source errors behind progressive disclosure', () => {
    render(<WorkInbox {...props({ selected: null, sources: [
      { profile: 'atlas', status: 'verified', incomplete: false, lastSuccess: '2026-09-07T10:00:00Z', message: null },
      { profile: 'offline', status: 'error', incomplete: true, lastSuccess: null, message: 'Refresh failed' }
    ] })} />)
    const summary = screen.getByText('1 z 2 źródeł pracy jest niepełnych')
    const details = summary.closest('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    fireEvent.click(summary)
    expect(details.open).toBe(true)
  })
  it.each(['offline', 'error', 'unsupported', 'loading'] as const)('disables decision and comment on %s', (status) => {
    render(<WorkInbox {...props({ status })} />)
    expect(screen.getByRole('group', { name: 'Decyzja dla rewizji 2' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Dodaj komentarz' }).hasAttribute('disabled')).toBe(true)
  })
  it('does not pretend unsupported is an empty inbox', () => {
    render(<WorkInbox {...props({ selected: null, items: [], status: 'unsupported' })} />)
    expect(screen.getByText(/nie obsługuje trwałej skrzynki pracy/)).toBeTruthy()
    expect(screen.queryByText(/Brak pracy w tym widoku/)).toBeNull()
  })
  it('exposes exactly three bounded actions and marks the authoritative recommendation', () => {
    render(<WorkInbox {...props()} />)
    const group = screen.getByRole('group', { name: 'Decyzja dla rewizji 2' })
    const actions = Array.from(group.querySelectorAll('button'))

    expect(actions.map((button) => button.textContent?.replace(' · Rekomendowane', ''))).toEqual(['Zatwierdź', 'Poproś o poprawki', 'Przypomnij za 2 godziny'])
    expect(actions.filter((button) => button.textContent?.includes('Rekomendowane'))).toHaveLength(1)
    expect(actions[0]?.textContent).toBe('Zatwierdź · Rekomendowane')
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull()
    expect(screen.queryByLabelText(/snooze until/i)).toBeNull()
    const explanation = screen.getByRole('heading', { name: 'Co zmieni kliknięcie' }).parentElement!
    expect(screen.getAllByRole('heading', { name: 'Co zmieni kliknięcie' })).toHaveLength(1)
    expect(explanation.querySelectorAll('li')).toHaveLength(3)
    expect(explanation.textContent).toContain('Zatwierdź')
    expect(explanation.textContent).toContain('Poproś o poprawki')
    expect(explanation.textContent).toContain('Przypomnij za 2 godziny')
    expect(explanation.textContent).toContain('nie publikuje')
    expect(explanation.textContent).toContain('wraca ona do decyzji')
  })
  it('requires a changes comment and sends preparation-only decisions', async () => {
    const p = props(); render(<WorkInbox {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Poproś o poprawki' }))
    expect(p.onDecision).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Dyskusja / żądane poprawki'), { target: { value: 'Narrow audience' } })
    fireEvent.click(screen.getByRole('button', { name: 'Poproś o poprawki' }))
    await waitFor(() => expect(p.onDecision).toHaveBeenCalledWith({ action: 'request_changes', comment: 'Narrow audience' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zatwierdź' }))
    await waitFor(() => expect(p.onDecision).toHaveBeenCalledWith({ action: 'approve_preparation' }))
  })
  it('submits the fixed reminder semantic without arbitrary dates or decline', async () => {
    const p = props(); render(<WorkInbox {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Przypomnij za 2 godziny' }))
    await waitFor(() => expect(p.onDecision).toHaveBeenCalledWith({ action: 'remind_in_2_hours' }))
  })
  it('keeps historical work recoverable and opens exact profile/id without chat', () => {
    const p = props({ selected: null, items: [{ ...card, bucket: 'history', status: 'declined' }] }); render(<WorkInbox {...p} />)
    expect(screen.queryByText(card.title)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Historia i odłożone' }))
    fireEvent.click(screen.getByRole('button', { name: /Prepare campaign/ }))
    expect(p.onOpen).toHaveBeenCalledWith('CMO Exact', 'work-1')
  })
  it('blocks duplicate pending controls and read-only work', () => {
    render(<WorkInbox {...props({ pending: true })} />)
    expect(screen.getByRole('group', { name: 'Decyzja dla rewizji 2' }).hasAttribute('disabled')).toBe(true)
  })
  it('keeps comments read-only without current can_decide authority', () => {
    render(<WorkInbox {...props({ selected: { ...card, actionable: false, canDecide: false, readOnlyReason: 'Owner sign-in required' } })} />)
    expect(screen.getByLabelText('Dyskusja / żądane poprawki').hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Dodaj komentarz' }).hasAttribute('disabled')).toBe(true)
  })
  it('sets and restores an owner priority without collecting an actor', async () => {
    const priority = { profile: 'CMO Exact', work_id: 'work-1', candidate_id: 'candidate-1', eligibility: 'assessed' as const, why_here: 'Deadline', next_step: 'Review', trade_off: 'Defers polish', assessed_at: null, evidence: [], assessment: null, override: { id: 'override-1', version: 2, mode: 'set_priority' as const, label: 'Now', actor: 'owner:server', reason: 'Launch', expires_at: null, review_id: null, review_at: null, active: true }, topicName: 'Launch', group: { kind: 'topic' as const, id: 'topic-1', profile: 'CMO Exact', backend_namespace: 'organization-db' }, groupOrder: 0, itemOrder: 0 }
    const p = props({ priorityWritable: true, selected: { ...card, priority } }); render(<WorkInbox {...p} />)
    fireEvent.change(screen.getByLabelText('Etykieta priorytetu'), { target: { value: 'Do first' } })
    fireEvent.change(screen.getByLabelText('Powód'), { target: { value: 'Material deadline' } })
    expect(screen.getByRole('button', { name: 'Ustaw priorytet' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Wybierz termin wygaśnięcia tego nadpisania.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Wygasa (wymagane)'), { target: { value: '2099-01-01T00:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ustaw priorytet' }))
    await waitFor(() => expect(p.onPriority).toHaveBeenCalledWith({ label: 'Do first', reason: 'Material deadline', expiresAt: new Date('2099-01-01T00:00').toISOString() }))
    expect(screen.queryByLabelText(/actor/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Przywróć rekomendowane' }))
    await waitFor(() => expect(p.onRestorePriority).toHaveBeenCalledTimes(1))
  })
  it('rejects executable, local and credential-bearing links', () => {
    for (const url of ['file:///etc/passwd', 'data:text/html,x', 'javascript:alert(1)', 'https://u:p@example.org', '/relative']) {expect(safeWorkUrl(url)).toBeUndefined()}
  })
  it('hands an authoritative project group to the project navigator', () => {
    const onOpenProject = vi.fn()
    const group = { kind: 'project' as const, id: 'canonical-project-42', source_id: 'desktop-project-7', profile: 'project-owner', backend_namespace: 'desktop:exact' }
    const priority = { profile: 'CMO Exact', work_id: 'work-1', candidate_id: 'candidate-1', eligibility: 'assessed' as const, why_here: 'Deadline', next_step: 'Review', trade_off: 'Defers polish', assessed_at: null, evidence: [], assessment: null, override: null, topicName: 'Autumn', group, groupOrder: 0, itemOrder: 0 }

    render(<WorkInbox {...props({ onOpenProject, selected: { ...card, priority } })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz projekt' }))

    expect(onOpenProject).toHaveBeenCalledWith({ source_id: 'desktop-project-7', profile: 'project-owner', backend_namespace: 'desktop:exact' })
  })
  it('renders Polish work chrome', () => {
    render(<WorkInbox {...props({ selected: null })} />)
    expect(screen.getByText('Trwała praca biznesowa')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Odśwież pracę' })).toBeTruthy()
  })
})
