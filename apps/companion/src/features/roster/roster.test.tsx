import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Roster, type Teammate } from './roster'

const teammates: Teammate[] = [
  { id: 'atlas', initials: 'A', name: 'Atlas', role: 'Chief of Staff', status: 'needs-approval', summary: 'A decision is ready for review.' },
  { id: 'mentor', initials: 'M', name: 'Mentor', role: 'Investments', status: 'working', summary: 'Reviewing portfolio concentration.' },
  { id: 'maven', initials: 'MV', name: 'Maven', role: 'Data Ops', status: 'blocked', summary: 'Paused safely after a session expired.' },
  { id: 'scout', initials: 'S', name: 'Scout', role: 'Research', status: 'completed', summary: 'Finished the source review.' }
]

describe('Roster', () => {
  it('renders every teammate status as visible text', () => {
    render(<Roster onSelect={() => undefined} teammates={teammates} />)

    expect(screen.getByText('Wymaga zgody')).toBeTruthy()
    expect(screen.getByText('Pracuje')).toBeTruthy()
    expect(screen.getByText('Zablokowany')).toBeTruthy()
    expect(screen.getByText('Zakończono')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Needs approval')
  })

  it('keeps an unserved profile visible and disabled with a Polish reason', () => {
    const onSelect = vi.fn()

    render(<Roster availability={[{
      teammateId: 'mentor',
      selectable: false,
      statusLabel: 'Niedostępny w tym połączeniu',
      detail: 'Ten profil nie jest obsługiwany przez bieżący gateway.'
    }]} onSelect={onSelect} teammates={teammates} />)

    const profile = screen.getByRole('button', { name: /Mentor.*Niedostępny w tym połączeniu/ })
    expect(profile.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Ten profil nie jest obsługiwany przez bieżący gateway.')).toBeTruthy()
    fireEvent.click(profile)
    expect(onSelect).not.toHaveBeenCalled()
  })
})
