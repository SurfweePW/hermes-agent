import { useLayoutEffect, useRef, useState } from 'react'

interface SavedScrollPosition {
  top: number
  following: boolean
  unread: boolean
  anchorId: string | null
  anchorOffset: number
}

interface PreviousContent {
  sessionKey: string
  firstId: string | null
  lastId: string | null
  version: string
  height: number
  position: SavedScrollPosition
}

const scrollPositions = new Map<string, SavedScrollPosition>()
const nearBottom = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight < 96

export const transcriptSessionKey = (source: string, profile: string, storedSessionId: string) => JSON.stringify([source, profile, storedSessionId])

function readPosition(element: HTMLDivElement, following: boolean, unread: boolean): SavedScrollPosition {
  const listTop = element.getBoundingClientRect().top
  const anchor = [...element.querySelectorAll<HTMLElement>('[data-transcript-id]')]
    .find((item) => item.getBoundingClientRect().bottom > listTop) ?? null

  return {
    top: element.scrollTop,
    following,
    unread,
    anchorId: anchor?.dataset.transcriptId ?? null,
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - listTop : 0
  }
}

function restorePosition(element: HTMLDivElement, position: SavedScrollPosition) {
  element.scrollTop = position.top
  if (!position.anchorId) {return}
  const anchor = [...element.querySelectorAll<HTMLElement>('[data-transcript-id]')]
    .find((item) => item.dataset.transcriptId === position.anchorId)

  if (anchor) {element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - position.anchorOffset}
}

export function useTranscriptScroll(sessionKey: string, itemIds: readonly string[], contentVersion: string) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const followingLatestRef = useRef(true)
  const unreadRef = useRef(false)
  const previousContentRef = useRef<PreviousContent | null>(null)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) {return}
    const saved = scrollPositions.get(sessionKey)
    followingLatestRef.current = saved?.following ?? true
    unreadRef.current = saved?.unread ?? false
    setShowJumpToLatest(unreadRef.current)
    if (saved) {restorePosition(element, saved)} else {element.scrollTop = element.scrollHeight}

    return () => {scrollPositions.set(sessionKey, readPosition(element, followingLatestRef.current, unreadRef.current))}
  }, [sessionKey])

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) {return}
    const previous = previousContentRef.current
    const firstId = itemIds[0] ?? null
    const lastId = itemIds.at(-1) ?? null

    if (previous?.sessionKey === sessionKey && previous.version !== contentVersion) {
      const oldFirstIndex = previous.firstId ? itemIds.indexOf(previous.firstId) : -1
      const prependedOnly = oldFirstIndex > 0 && previous.lastId === lastId

      if (prependedOnly) {
        const heightDelta = element.scrollHeight - previous.height
        restorePosition(element, previous.position)
        // JSDOM and some virtualized surfaces do not expose row geometry.
        if (element.scrollTop === previous.position.top && heightDelta) {element.scrollTop += heightDelta}
      } else if (followingLatestRef.current) {
        element.scrollTop = element.scrollHeight
      } else {
        unreadRef.current = true
        setShowJumpToLatest(true)
      }
    }

    const position = readPosition(element, followingLatestRef.current, unreadRef.current)
    previousContentRef.current = { sessionKey, firstId, lastId, version: contentVersion, height: element.scrollHeight, position }
    scrollPositions.set(sessionKey, position)
  }, [contentVersion, itemIds, sessionKey])

  const onScroll = () => {
    const element = viewportRef.current
    if (!element) {return}
    followingLatestRef.current = nearBottom(element)
    if (followingLatestRef.current) {
      unreadRef.current = false
      setShowJumpToLatest(false)
    }
    const position = readPosition(element, followingLatestRef.current, unreadRef.current)
    if (previousContentRef.current?.sessionKey === sessionKey) {
      previousContentRef.current.height = element.scrollHeight
      previousContentRef.current.position = position
    }
    scrollPositions.set(sessionKey, position)
  }

  const jumpToLatest = () => {
    followingLatestRef.current = true
    unreadRef.current = false
    setShowJumpToLatest(false)
    const element = viewportRef.current
    if (element) {
      element.scrollTo?.({ behavior: 'smooth', top: element.scrollHeight })
      element.scrollTop = element.scrollHeight
      scrollPositions.set(sessionKey, readPosition(element, true, false))
    } else {endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })}
  }

  return { viewportRef, endRef, showJumpToLatest, onScroll, jumpToLatest }
}
