import { type ReactNode, type TouchEvent, useRef, useState } from 'react'

import { appCopy } from '../copy/app'

const TRIGGER_DISTANCE = 72
const MAX_DISTANCE = 104

interface PullToRefreshProps {
  children: ReactNode
  enabled: boolean
  onRefresh(): Promise<unknown> | unknown
}

export function PullToRefresh({ children, enabled, onRefresh }: PullToRefreshProps) {
  const start = useRef<{ x: number; y: number } | null>(null)
  const inFlight = useRef<Promise<void> | null>(null)
  const distanceRef = useRef(0)
  const [distance, setDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const atTop = (target: EventTarget | null) => {
    const main = target instanceof Element ? target.closest('.main-content') : null

    return window.innerWidth <= 780 ? window.scrollY <= 0 : (main?.scrollTop ?? 0) <= 0
  }

  const touchStart = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]

    if (!enabled || event.touches.length !== 1 || !touch || !atTop(event.currentTarget)) {start.current = null; return}
    start.current = { x: touch.clientX, y: touch.clientY }
  }

  const touchMove = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]
    const origin = start.current

    if (!enabled || !touch || !origin || !atTop(event.currentTarget)) {distanceRef.current = 0; setDistance(0); start.current = null; return}
    const vertical = touch.clientY - origin.y
    const horizontal = Math.abs(touch.clientX - origin.x)

    if (vertical <= 0 || horizontal > vertical) {distanceRef.current = 0; setDistance(0); return}
    distanceRef.current = Math.min(MAX_DISTANCE, vertical * 0.55)
    setDistance(distanceRef.current)
  }

  const finish = () => {
    start.current = null

    if (!enabled || distanceRef.current < TRIGGER_DISTANCE || inFlight.current) {distanceRef.current = 0; setDistance(0); return}
    distanceRef.current = 0
    setRefreshing(true)
    const operation = Promise.resolve(onRefresh()).then(() => undefined).finally(() => {
      if (inFlight.current === operation) {inFlight.current = null}
      setRefreshing(false)
      setDistance(0)
    })
    inFlight.current = operation
  }

  const label = refreshing
    ? appCopy.refresh.running
    : distance >= TRIGGER_DISTANCE ? appCopy.refresh.release : appCopy.refresh.pulling

  return <div className="pull-to-refresh" onTouchCancel={finish} onTouchEnd={finish} onTouchMove={touchMove} onTouchStart={touchStart}>
    <div aria-live="polite" className={`pull-to-refresh__indicator${distance || refreshing ? ' pull-to-refresh__indicator--visible' : ''}`} role="status" style={{ transform: `translateY(${refreshing ? 0 : Math.max(-44, distance - 44)}px)` }}><span aria-hidden="true">{refreshing ? '↻' : '↓'}</span>{label}</div>
    {children}
  </div>
}
