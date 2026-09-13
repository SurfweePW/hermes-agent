import { type ReactNode, useState } from 'react'

export function TechnicalDetails({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)

  return <details className="technical-details" open={open}><summary aria-expanded={open} onClick={(event) => {event.preventDefault(); setOpen((value) => !value)}}>Szczegóły techniczne</summary><div className="technical-details__body">{children}</div></details>
}
