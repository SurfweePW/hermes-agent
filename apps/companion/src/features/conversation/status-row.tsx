import { useState } from 'react'

import { conversationCopy } from '../../copy/conversation'

import { MessageContent } from './message-content'

export type StatusKind = 'tool' | 'internal' | 'compression'

interface StatusRowProps {
  kind: StatusKind
  label?: string | null
  payload?: string
  state?: string | null
}

const kindLabel: Record<StatusKind, string> = {
  compression: conversationCopy.statusRow.compression,
  internal: conversationCopy.statusRow.internal,
  tool: conversationCopy.statusRow.tool
}

export function StatusRow({ kind, label, payload = '', state = null }: StatusRowProps) {
  const [open, setOpen] = useState(false)
  const semanticKind = kindLabel[kind]

  return <details className={`status-row status-row--${kind}`} open={open}>
    <summary onClick={(event) => {event.preventDefault(); setOpen((value) => !value)}}><span>{semanticKind}</span><strong>{label || semanticKind}</strong>{state && <small>{state}</small>}</summary>
    {open && payload && <div className="status-row__details"><MessageContent role="system" text={payload} /></div>}
  </details>
}
