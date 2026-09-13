import type { ReactNode } from 'react'

interface PersistedConversationListProps<T> {
  items: readonly T[]
  itemKey: (item: T) => string
  renderItem: (item: T) => ReactNode
  className: string
  emptyTitle: string
  emptyCopy: string
  showEmpty?: boolean
}

export function PersistedConversationList<T>({ items, itemKey, renderItem, className, emptyTitle, emptyCopy, showEmpty = true }: PersistedConversationListProps<T>) {
  if (!items.length) {
    return showEmpty ? <div className="persisted-conversation-empty" role="status"><strong>{emptyTitle}</strong><p>{emptyCopy}</p></div> : null
  }

  return <div className={className}>{items.map((item) => <div className="persisted-conversation-entry" key={itemKey(item)}>{renderItem(item)}</div>)}</div>
}
