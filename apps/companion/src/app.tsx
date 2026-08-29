import { useEffect, useRef, useState } from 'react'

import { ActivityRail } from './features/attention/activity-rail'
import type { ApprovalDecision } from './features/attention/approval-card'
import { NeedsMe } from './features/attention/needs-me'
import { Conversation } from './features/conversation/conversation'
import { Recovery } from './features/recovery/recovery'
import { Roster, type Teammate } from './features/roster/roster'
import { TeammateDetails } from './features/roster/teammate-details'

type Screen = 'teammates' | 'conversation' | 'attention' | 'search' | 'details' | 'recovery'

const teammates: Teammate[] = [
  { id: 'atlas', initials: 'A', name: 'Atlas', role: 'Chief of Staff', status: 'needs-approval', summary: 'Prepared a decision and is waiting for your approval.' },
  { id: 'mentor', initials: 'M', name: 'Mentor', role: 'Investments', status: 'working', summary: 'Reviewing portfolio concentration against new data.' },
  { id: 'maven', initials: 'MV', name: 'Maven', role: 'Data Operations', status: 'blocked', summary: 'Paused safely when the portal connection expired.' },
  { id: 'scout', initials: 'S', name: 'Scout', role: 'Research', status: 'completed', summary: 'Finished the source map and left a clear handoff.' }
]

const screenTitles: Record<Screen, string> = {
  teammates: 'Teammates', conversation: 'Conversation', attention: 'Needs Me', search: 'Search', details: 'Teammate Details', recovery: 'Recovery'
}

export function App() {
  const [screen, setScreen] = useState<Screen>('teammates')
  const [selected, setSelected] = useState<Teammate>(teammates[0])
  const [decision, setDecision] = useState<string>()
  const mainRef = useRef<HTMLElement>(null)
  const initialScreen = useRef(true)

  useEffect(() => {
    if (initialScreen.current) {
      initialScreen.current = false

      return
    }

    mainRef.current?.focus()
  }, [screen])

  const openTeammate = (teammate: Teammate) => {
    setSelected(teammate)
    setScreen('details')
  }

  const decide = (choice: ApprovalDecision) => {
    setDecision(choice === 'once' ? 'Approved once' : choice === 'session' ? 'Approved for session' : 'Denied')
  }

  const content = (() => {
    if (screen === 'conversation') {return <Conversation decision={decision} isStreaming onApproval={decide} />}

    if (screen === 'attention') {return <NeedsMe onOpenApproval={() => setScreen('conversation')} onOpenRecovery={() => setScreen('recovery')} />}

    if (screen === 'details') {return <TeammateDetails onBack={() => setScreen('teammates')} onMessage={() => setScreen('conversation')} teammate={selected} />}

    if (screen === 'recovery') {return <Recovery onBack={() => setScreen('attention')} onRetry={() => setScreen('conversation')} />}

    if (screen === 'search') {return <SearchPlaceholder />}

    return <TeammatesHome onNeedsMe={() => setScreen('attention')} onSelect={openTeammate} />
  })()

  return (
    <div className="app-shell">
      <header className="mobile-header"><Wordmark /><span aria-label="Profile: Atlas Weber" className="avatar avatar--user" role="img">AW</span></header>
      <aside className="left-rail">
        <Wordmark />
        <nav aria-label="Main navigation" className="primary-nav">
          <NavButton active={screen === 'teammates' || screen === 'details'} icon="⌂" label="Teammates" onClick={() => setScreen('teammates')} />
          <NavButton active={screen === 'conversation'} icon="◌" label="Conversation" onClick={() => setScreen('conversation')} />
          <NavButton active={screen === 'attention' || screen === 'recovery'} badge="2" icon="!" label="Needs Me" onClick={() => setScreen('attention')} />
          <NavButton active={screen === 'search'} icon="⌕" label="Search" onClick={() => setScreen('search')} />
        </nav>
        <div className="rail-roster"><div className="rail-section-title"><span>Teammates</span><span>4</span></div><Roster compact onSelect={openTeammate} teammates={teammates} /></div>
        <div className="connection"><span aria-hidden="true" /><div><strong>Companion is ready</strong><small>4 teammates available</small></div></div>
      </aside>
      <main aria-label={screenTitles[screen]} className="main-content" ref={mainRef} tabIndex={-1}>
        <h1 className="sr-only">Hermes Companion</h1>
        <header className="desktop-topbar"><div><span>Hermes Companion</span><strong>{screenTitles[screen]}</strong></div><span aria-label="Profile: Atlas Weber" className="avatar avatar--user" role="img">AW</span></header>
        {content}
      </main>
      <ActivityRail decision={decision} />
      <nav aria-label="Mobile navigation" className="bottom-nav">
        <NavButton active={screen === 'teammates' || screen === 'details'} icon="⌂" label="Teammates" onClick={() => setScreen('teammates')} />
        <NavButton active={screen === 'conversation'} icon="◌" label="Chat" onClick={() => setScreen('conversation')} />
        <NavButton active={screen === 'attention' || screen === 'recovery'} badge="2" icon="!" label="Needs Me" onClick={() => setScreen('attention')} />
        <NavButton active={screen === 'search'} icon="⌕" label="Search" onClick={() => setScreen('search')} />
      </nav>
    </div>
  )
}

function Wordmark() {
  return <div className="wordmark"><span aria-hidden="true" className="wordmark__sigil">H+</span><span>Hermes<strong>Companion</strong></span></div>
}

interface NavButtonProps { active: boolean; icon: string; label: string; onClick: () => void; badge?: string }

function NavButton({ active, icon, label, onClick, badge }: NavButtonProps) {
  return <button aria-current={active ? 'page' : undefined} className={`nav-button${active ? ' nav-button--active' : ''}`} onClick={onClick} type="button"><span aria-hidden="true" className="nav-button__icon">{icon}</span><span>{label}</span>{badge && <span aria-label={`${badge} items`} className="nav-badge">{badge}</span>}</button>
}

function TeammatesHome({ onSelect, onNeedsMe }: { onSelect: (teammate: Teammate) => void; onNeedsMe: () => void }) {
  return <section aria-labelledby="teammates-title" className="teammates-home"><div className="hero-copy"><p className="kicker">Sunday · your team at a glance</p><h2 id="teammates-title">Good morning.<br />Your team is moving.</h2><p className="screen-lede">Two moments need your attention. Everything else is in hand.</p></div><button className="attention-banner" onClick={onNeedsMe} type="button"><span className="attention-banner__count">2</span><span><strong>Needs your judgment</strong><small>One approval, one safe recovery</small></span><span aria-hidden="true">→</span></button><div className="section-heading"><div><p className="kicker">The people doing the work</p><h3>Teammates</h3></div><span>4 total</span></div><Roster onSelect={onSelect} teammates={teammates} /></section>
}

function SearchPlaceholder() {
  return <section aria-labelledby="search-title" className="search-screen"><p className="kicker">Find the thread, not the machinery</p><h2 id="search-title">Search</h2><label className="search-box"><span aria-hidden="true">⌕</span><span className="sr-only">Search conversations and teammates</span><input autoFocus placeholder="Search conversations and teammates…" /></label><div className="search-empty"><span aria-hidden="true">⌕</span><h3>What are you looking for?</h3><p>Try a teammate name, a conversation, or a result.</p></div></section>
}
