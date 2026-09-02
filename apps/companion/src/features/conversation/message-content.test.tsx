import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MessageContent } from './message-content'

describe('MessageContent', () => {
  it('collapses known context compaction payloads while keeping details accessible', () => {
    render(<MessageContent role="system" text={'[CONTEXT COMPACTION — REFERENCE ONLY]\nA very long internal summary with private transport details.'} />)

    expect(screen.getByText('Earlier context summary')).toBeTruthy()
    expect(screen.queryByText(/private transport details/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.getByText(/private transport details/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
    expect(screen.queryByText(/private transport details/)).toBeNull()
  })

  it('removes Telegram metadata and raw image payloads from visible prose', () => {
    const text = '[Atlas Weber|123456789] Please review this.\n/Users/atlasweber/Desktop/private-shot.png\ndata:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE='
    render(<MessageContent role="user" text={text} />)

    expect(screen.getByText('Please review this.')).toBeTruthy()
    expect(screen.getAllByText('Image attachment').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('123456789')
    expect(document.body.textContent).not.toContain('/Users/atlasweber')
    expect(document.body.textContent).not.toContain('iVBORw0KGgo')
  })

  it('turns production image attachment markers into a neutral note', () => {
    render(<MessageContent role="user" text={'Please inspect this.\n[Image attached at: /Users/atlasweber/Library/Application Support/Hermes/img.jpg]\ndata:image/jpeg;base64,/9j/4AAQSkZJRgABAQ'} />)

    expect(screen.getByText('Please inspect this.')).toBeTruthy()
    expect(screen.getAllByText('Image attachment')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('/Users/')
    expect(document.body.textContent).not.toContain('[Image attached at:')
    expect(document.body.textContent).not.toContain('/9j/4AAQ')
  })

  it('renders bounded Markdown structure without raw syntax', () => {
    render(<MessageContent role="assistant" text={'First **bold** and *clear* with `code` and [Hermes](https://hermes-agent.nousresearch.com).\n\n- one\n- two\n\n```ts\nconst safe = true\n```'} />)

    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByText('clear').tagName).toBe('EM')
    expect(screen.getByText('code').tagName).toBe('CODE')
    expect(screen.getByRole('link', { name: 'Hermes' }).getAttribute('href')).toBe('https://hermes-agent.nousresearch.com')
    expect(screen.getByRole('list').children).toHaveLength(2)
    expect(screen.getByText('const safe = true').tagName).toBe('CODE')
    expect(document.body.textContent).not.toContain('**bold**')
  })

  it('collapses long user messages but leaves short messages and assistant answers expanded', () => {
    const longText = `Beginning ${'detail '.repeat(140)} ending`
    const { rerender } = render(<MessageContent role="user" text={longText} />)

    expect(screen.getByText('Show more')).toBeTruthy()
    expect(document.body.textContent).not.toContain('ending')
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(document.body.textContent).toContain('ending')
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy()

    rerender(<MessageContent role="assistant" text={longText} />)
    expect(screen.queryByRole('button', { name: /Show (more|less)/ })).toBeNull()
    expect(document.body.textContent).toContain('ending')

    rerender(<MessageContent role="user" text="A short request" />)
    expect(screen.queryByRole('button', { name: /Show (more|less)/ })).toBeNull()
  })

  it('does not trust a user-authored compaction prefix without the generated summary envelope', () => {
    render(<MessageContent role="user" text="[CONTEXT COMPACTION — REFERENCE ONLY] This is ordinary user text." />)

    expect(screen.queryByLabelText('Earlier context summary')).toBeNull()
    expect(screen.getByText(/ordinary user text/)).toBeTruthy()
  })

  it('uses a plain-text preview when truncation crosses Markdown syntax', () => {
    const text = `${'word '.repeat(142)}[unfinished **bold link](https://example.com)`
    render(<MessageContent role="user" text={text} />)

    expect(document.body.textContent).not.toContain('**')
    expect(document.body.textContent).not.toContain('](https://')
  })
})
