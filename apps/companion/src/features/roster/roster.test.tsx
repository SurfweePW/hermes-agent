import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

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

    expect(screen.getByText('Needs approval')).toBeTruthy()
    expect(screen.getByText('Working')).toBeTruthy()
    expect(screen.getByText('Blocked')).toBeTruthy()
    expect(screen.getByText('Completed')).toBeTruthy()
  })
})
