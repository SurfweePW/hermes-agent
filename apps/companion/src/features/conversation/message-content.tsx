import { Fragment, type ReactNode, useState } from 'react'

import type { MessageRole } from '../../state/companion-store'

const CONTEXT_COMPACTION = '[CONTEXT COMPACTION — REFERENCE ONLY]'
const LONG_USER_MESSAGE_LENGTH = 720
const IMAGE_ATTACHMENT = ':::hermes-image-attachment:::'
const RAW_IMAGE_LINE = /^(?:file:\/\/)?(?:\/[\w .@%+~_-]+)+(?:\.(?:avif|gif|heic|jpe?g|png|webp))(?::\d+(?::\d+)?)?$/i
const DATA_IMAGE = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi
const IMAGE_ATTACHMENT_MARKER = /\[Image attached at:\s*(?:(?:file:\/\/)?\/[^\]\n]+)?\]/gi
const TELEGRAM_SENDER = /^\[[^\]\n|]+\|\d+\]\s*/

interface MessageContentProps {
  role: MessageRole
  text: string
}

export function MessageContent({ role, text }: MessageContentProps) {
  const [expanded, setExpanded] = useState(false)
  const normalized = normalizeMessageText(text)
  const isCompaction = isContextCompactionMessage(role, normalized)

  if (isCompaction) {
    const details = normalized.slice(CONTEXT_COMPACTION.length).trim()

    return (
      <aside aria-label="Earlier context summary" className="context-disclosure">
        <div className="context-disclosure__heading">
          <span aria-hidden="true">↺</span>
          <div><strong>Earlier context summary</strong><small>Older conversation details are hidden to keep this view readable.</small></div>
        </div>
        {expanded && <div className="context-disclosure__details"><MarkdownContent text={details} /></div>}
        <button aria-expanded={expanded} className="disclosure-button" onClick={() => setExpanded((value) => !value)} type="button">{expanded ? 'Hide details' : 'Show details'}</button>
      </aside>
    )
  }

  const collapsible = role === 'user' && normalized.length > LONG_USER_MESSAGE_LENGTH
  const visibleText = collapsible && !expanded ? buildPlainTextPreview(normalized) : normalized

  return (
    <div className="message-content">
      {visibleText ? <MarkdownContent text={visibleText} /> : <p className="attachment-note">Image attachment</p>}
      {collapsible && <button aria-expanded={expanded} className="disclosure-button" onClick={() => setExpanded((value) => !value)} type="button">{expanded ? 'Show less' : 'Show more'}</button>}
    </div>
  )
}

export function isContextCompactionMessage(role: MessageRole, text: string): boolean {
  const normalized = normalizeMessageText(text)

  if (!normalized.startsWith(CONTEXT_COMPACTION)) { return false }

  if (role === 'system') { return true }

  return normalized.includes('## Historical Task Snapshot') && normalized.includes('--- END OF CONTEXT SUMMARY')
}

function buildPlainTextPreview(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, 'Code block')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  const boundary = plain.lastIndexOf(' ', LONG_USER_MESSAGE_LENGTH)
  const end = boundary > LONG_USER_MESSAGE_LENGTH * 0.75 ? boundary : LONG_USER_MESSAGE_LENGTH

  return `${plain.slice(0, end).trimEnd()}…`
}

export function normalizeMessageText(text: string): string {
  const withoutSender = text.replace(TELEGRAM_SENDER, '')
  let hasImageAttachment = IMAGE_ATTACHMENT_MARKER.test(withoutSender) || DATA_IMAGE.test(withoutSender)
  DATA_IMAGE.lastIndex = 0
  IMAGE_ATTACHMENT_MARKER.lastIndex = 0
  const withoutPayloads = withoutSender.replace(IMAGE_ATTACHMENT_MARKER, '').replace(DATA_IMAGE, '')

  const visibleLines = withoutPayloads
    .split('\n')
    .filter((line) => {
      if (RAW_IMAGE_LINE.test(line.trim())) { hasImageAttachment = true;

 return false }

      return true
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return [visibleLines, hasImageAttachment ? IMAGE_ATTACHMENT : ''].filter(Boolean).join('\n\n')
}

function MarkdownContent({ text }: { text: string }) {
  const blocks = parseBlocks(text)

  return <>{blocks.map((block, index) => renderBlock(block, index))}</>
}

type MarkdownBlock =
  | { type: 'code'; language: string; content: string }
  | { type: 'attachment' }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; content: string }

function parseBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) { index += 1;

 continue }

    if (line.trim() === IMAGE_ATTACHMENT) {
      blocks.push({ type: 'attachment' })
      index += 1

      continue
    }

    const fence = line.match(/^```([\w-]*)\s*$/)

    if (fence) {
      const content: string[] = []
      index += 1

      while (index < lines.length && !/^```\s*$/.test(lines[index])) { content.push(lines[index]); index += 1 }

      if (index < lines.length) { index += 1 }
      blocks.push({ type: 'code', language: fence[1], content: content.join('\n') })

      continue
    }

    const listMatch = line.match(/^\s*(?:(\d+)\.|[-*])\s+(.+)$/)

    if (listMatch) {
      const ordered = Boolean(listMatch[1])
      const items: string[] = []

      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:(\d+)\.|[-*])\s+(.+)$/)

        if (!item || Boolean(item[1]) !== ordered) { break }
        items.push(item[2])
        index += 1
      }

      blocks.push({ type: 'list', ordered, items })

      continue
    }

    const paragraph = [line]
    index += 1

    while (index < lines.length && lines[index].trim() && !/^```/.test(lines[index]) && !/^\s*(?:(?:\d+)\.|[-*])\s+/.test(lines[index])) {
      paragraph.push(lines[index])
      index += 1
    }

    blocks.push({ type: 'paragraph', content: paragraph.join('\n') })
  }

  return blocks
}

function renderBlock(block: MarkdownBlock, index: number): ReactNode {
  if (block.type === 'attachment') {
    return <p className="attachment-note" key={index}><span aria-hidden="true">▧</span> Image attachment</p>
  }

  if (block.type === 'code') {
    return <pre className="markdown-code" key={index}><code data-language={block.language || undefined}>{block.content}</code></pre>
  }

  if (block.type === 'list') {
    const List = block.ordered ? 'ol' : 'ul'

    return <List key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</List>
  }

  return <p key={index}>{renderInline(block.content)}</p>
}

function renderInline(text: string): ReactNode[] {
  const token = /(\[[^\]]+\]\([^)]+\)|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|(?<!\*)\*[^*\n]+\*(?!\*)|(?<!_)_[^_\n]+_(?!_))/g
  const nodes: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = token.exec(text)) !== null) {
    if (match.index > cursor) { nodes.push(text.slice(cursor, match.index)) }
    const value = match[0]
    const link = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/)

    if (link) {
      const href = safeHref(link[2])
      nodes.push(href ? <a href={href} key={match.index} rel="noreferrer" target="_blank">{link[1]}</a> : link[1])
    } else if (value.startsWith('`')) {
      nodes.push(<code key={match.index}>{value.slice(1, -1)}</code>)
    } else if (value.startsWith('**') || value.startsWith('__')) {
      nodes.push(<strong key={match.index}>{value.slice(2, -2)}</strong>)
    } else {
      nodes.push(<em key={match.index}>{value.slice(1, -1)}</em>)
    }

    cursor = match.index + value.length
  }

  if (cursor < text.length) { nodes.push(text.slice(cursor)) }

  return nodes.map((node, index) => <Fragment key={index}>{node}</Fragment>)
}

function safeHref(value: string): string | null {
  try {
    const url = new URL(value)

    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? value : null
  } catch {
    return null
  }
}
