import { type ReactNode, useState } from 'react'

import { conversationCopy } from '../copy/conversation'

export function TechnicalDetails({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)

  return <details className="technical-details" open={open}><summary aria-expanded={open} onClick={(event) => {event.preventDefault(); setOpen((value) => !value)}}><span>{conversationCopy.technical.details}</span><span aria-hidden="true" className="technical-details__chevron">⌄</span></summary><div className="technical-details__body">{children}</div></details>
}
