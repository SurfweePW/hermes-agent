import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { GatewayAttentionItem } from '../../gateway/types'

import { NeedsMe } from './needs-me'

const item = (kind: GatewayAttentionItem['kind'], actionable = true): GatewayAttentionItem => ({
  id: kind,
  kind,
  profile: 'atlas',
  runtime_session_id: `runtime-${kind}`,
  stored_session_id: actionable ? `stored-${kind}` : null,
  title: `Title ${kind}`,
  detail: `Detail ${kind}`,
  occurred_at: 1,
  actionable,
  resolution: actionable ? 'approval' : 'unsupported_here'
})

describe('NeedsMe', () => {
  it('renders Polish labels for every attention kind', () => {
    const items = [item('approval'), item('question'), item('blocker'), item('completion', false), item('error', false)]
    render(<NeedsMe items={items} onOpen={vi.fn()} onRefresh={vi.fn()} scope="lokalny" />)

    for (const label of ['Zatwierdzenie', 'Pytanie', 'Blokada', 'Ukończenie', 'Błąd']) {
      expect(screen.getByText(new RegExp(`${label} · atlas`))).toBeTruthy()
    }
    expect(document.querySelectorAll('.attention-item .label')).toHaveLength(5)
    expect([...document.querySelectorAll('.attention-item .label')].map((node) => node.textContent)).toEqual([
      'Zatwierdzenie · atlas', 'Pytanie · atlas', 'Blokada · atlas', 'Ukończenie · atlas', 'Błąd · atlas'
    ])

    fireEvent.click(screen.getByRole('button', { name: /Title approval/ }))
  })
})
