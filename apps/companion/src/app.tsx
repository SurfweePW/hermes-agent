import { type FormEvent, useEffect, useRef, useState } from 'react'

import { NeedsMe } from './features/attention/needs-me'
import { Conversation } from './features/conversation/conversation'
import { Recovery } from './features/recovery/recovery'
import { Roster, type Teammate } from './features/roster/roster'
import { TeammateDetails } from './features/roster/teammate-details'
import { createFakeGateway } from './fixtures/fake-gateway'
import { type CompanionStore, createCompanionStore } from './state/companion-store'
import { useCompanion } from './state/use-companion'

type Screen = 'teammates' | 'conversation' | 'attention' | 'details' | 'recovery'

const fixtureMode = import.meta.env.VITE_COMPANION_FIXTURE === 'true'
const defaultStore = createCompanionStore(fixtureMode ? { gatewayFactory: createFakeGateway } : {})

const screenTitles: Record<Screen, string> = {
  teammates: 'Teammates', conversation: 'Conversation', attention: 'Needs Me', details: 'Teammate Details', recovery: 'Recovery'
}

export function App({ store = defaultStore }: { store?: CompanionStore }) {
  const companion = useCompanion(store)
  const [screen, setScreen] = useState<Screen>('teammates')
  const mainRef = useRef<HTMLElement>(null)
  const initialScreen = useRef(true)
  const fixtureStarted = useRef(false)
  const selected = companion.teammates.find((teammate) => teammate.id === companion.selectedTeammateId)
  const attentionCount = companion.attentionItems.length + Number(companion.phase === 'disconnected')

  useEffect(() => {
    if (!fixtureMode || store !== defaultStore || fixtureStarted.current) {return}
    fixtureStarted.current = true
    void store.configure({ baseUrl: 'http://fixture.invalid', token: 'fixture-qa-token' })
  }, [store])

  useEffect(() => {
    if (initialScreen.current) { initialScreen.current = false;

 return }

    mainRef.current?.focus()
  }, [screen])

  if (companion.phase === 'setup' || companion.phase === 'connecting') {
    return <SetupScreen canForgetSavedToken={companion.canForgetSavedToken} connecting={companion.phase === 'connecting'} error={companion.error} hasSavedToken={companion.hasSavedToken} initialBaseUrl={companion.baseUrl} onConnect={(baseUrl, token) => store.configure({ baseUrl, token })} onForgetSavedToken={store.forgetSavedToken} storesTokenEncrypted={companion.storesTokenEncrypted} warnings={companion.warnings} />
  }

  const openTeammate = (teammate: Teammate) => {
    void store.selectTeammate(teammate.id)
    setScreen('details')
  }

  const content = (() => {
    if (companion.phase === 'disconnected' || companion.phase === 'recovering' || screen === 'recovery') {
      return <Recovery error={companion.error} hasDraft={Boolean(companion.draft)} onBack={companion.phase === 'disconnected' ? undefined : () => setScreen('attention')} onRetry={() => void store.recover()} recovering={companion.phase === 'recovering'} teammateName={selected?.name} turnUncertain={companion.turnStatus === 'uncertain'} />
    }

    if (screen === 'conversation') {
      const activeSession = companion.recentSessions.find((session) => session.id === companion.storedSessionId || session.resolved_id === companion.storedSessionId)

      return selected
        ? <Conversation approval={companion.pendingApproval} connected={companion.phase === 'ready'} draft={companion.draft} messages={companion.messages} onApproval={(choice) => void store.respondToApproval(choice)} onBackToSessions={() => setScreen('details')} onDraftChange={store.setDraft} onInterrupt={() => void store.interrupt()} onSubmit={() => void store.submitDraft()} sessionTitle={activeSession?.title || 'Main conversation'} streamingText={companion.streamingText} teammate={selected} turnStatus={companion.turnStatus} />
        : <ChooseTeammate onBack={() => setScreen('teammates')} />
    }

    if (screen === 'attention') {return <NeedsMe items={companion.attentionItems} onOpen={(item) => { void store.openAttention(item).then(() => setScreen('conversation')) }} onRefresh={() => void store.refreshAttention()} scope={companion.attentionScope} />}

    if (screen === 'details' && selected) {return <TeammateDetails onBack={() => setScreen('teammates')} onMessage={() => setScreen('conversation')} onOpenSession={(id) => { void store.selectTeammate(selected.id, id).then(() => setScreen('conversation')) }} onPin={(id, pinned) => void store.setSessionPinned(id, pinned)} sessions={companion.recentSessions} sessionsLoading={companion.sessionsLoading} teammate={selected} />}

    return <TeammatesHome attentionCount={attentionCount} onNeedsMe={() => setScreen('attention')} onQuickTask={(teammateId, text) => { void store.submitQuickTask(teammateId, text).then(() => setScreen('conversation')) }} onSelect={openTeammate} teammates={companion.teammates} />
  })()

  return (
    <div className="app-shell app-shell--two-column">
      <header className="mobile-header"><Wordmark /><span aria-label="Profile: Companion user" className="avatar avatar--user" role="img">CU</span></header>
      <aside className="left-rail">
        <Wordmark />
        <nav aria-label="Main navigation" className="primary-nav">
          <NavButton active={screen === 'teammates' || screen === 'details'} icon="⌂" label="Teammates" onClick={() => setScreen('teammates')} />
          <NavButton active={screen === 'conversation'} icon="◌" label="Conversation" onClick={() => setScreen('conversation')} />
          <NavButton active={screen === 'attention' || screen === 'recovery'} badge={attentionCount ? String(attentionCount) : undefined} icon="!" label="Needs Me" onClick={() => setScreen('attention')} />
        </nav>
        <div className="rail-roster"><div className="rail-section-title"><span>Teammates</span><span>{companion.teammates.length}</span></div><Roster compact onSelect={openTeammate} teammates={companion.teammates} /></div>
        <div className="connection"><span aria-hidden="true" /><div><strong>Companion is ready</strong><small>{companion.teammates.length} teammates available</small></div></div>
      </aside>
      <main aria-label={screenTitles[screen]} className={`main-content${screen === 'conversation' ? ' main-content--conversation' : ''}`} ref={mainRef} tabIndex={-1}>
        <h1 className="sr-only">Hermes Companion</h1>
        {screen !== 'conversation' && <header className="desktop-topbar"><div><span>Hermes Companion</span><strong>{screenTitles[screen]}</strong></div><span aria-label="Profile: Companion user" className="avatar avatar--user" role="img">CU</span></header>}
        {companion.error && <div className="decision-toast" role="alert">{companion.error}</div>}
        {content}
      </main>
      <nav aria-label="Mobile navigation" className="bottom-nav">
        <NavButton active={screen === 'teammates' || screen === 'details'} icon="⌂" label="Teammates" onClick={() => setScreen('teammates')} />
        <NavButton active={screen === 'conversation'} icon="◌" label="Chat" onClick={() => setScreen('conversation')} />
        <NavButton active={screen === 'attention' || screen === 'recovery'} badge={attentionCount ? String(attentionCount) : undefined} icon="!" label="Needs Me" onClick={() => setScreen('attention')} />
      </nav>
    </div>
  )
}

function SetupScreen({ initialBaseUrl, warnings, connecting, error, hasSavedToken, canForgetSavedToken, storesTokenEncrypted, onConnect, onForgetSavedToken }: { initialBaseUrl: string; warnings: readonly string[]; connecting: boolean; error: string | null; hasSavedToken: boolean; canForgetSavedToken: boolean; storesTokenEncrypted: boolean; onConnect: (baseUrl: string, token: string) => void; onForgetSavedToken: () => void | Promise<void> }) {
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl)
  const [token, setToken] = useState('')

  const storageCopy = storesTokenEncrypted
    ? 'The native app stores the token encrypted in secure device storage.'
    : 'The browser keeps the token for this session only.'

  return <main aria-labelledby="setup-title" className="recovery-screen"><section className="recovery-card"><Wordmark /><p className="kicker">Connection setup</p><h1 id="setup-title">Connect Hermes Companion</h1><p>Use the private HTTP(S) base URL for your Hermes gateway and a session token. {storageCopy}</p><form onSubmit={(event) => { event.preventDefault(); onConnect(baseUrl, token) }}><label>Gateway base URL<input autoComplete="url" onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://localhost:8642" required type="url" value={baseUrl} /></label><label>Session token<input autoComplete="off" onChange={(event) => setToken(event.target.value)} placeholder={hasSavedToken ? 'Leave blank to use saved token' : undefined} required={!hasSavedToken} type="password" value={token} /></label>{hasSavedToken && <p role="status">A saved encrypted token is available. Enter a new token to replace it after a successful connection.</p>}{warnings.map((warning) => <p key={warning} role="status">{warning}</p>)}{error && <p role="alert">{error}</p>}<button className="primary-button" disabled={connecting} type="submit">{connecting ? 'Connecting…' : hasSavedToken && !token ? 'Use saved token' : 'Connect privately'}</button>{canForgetSavedToken && <button disabled={connecting} onClick={onForgetSavedToken} type="button">Forget saved token</button>}</form></section></main>
}

function Wordmark() { return <div className="wordmark"><span aria-hidden="true" className="wordmark__sigil">H+</span><span>Hermes<strong>Companion</strong></span></div> }
interface NavButtonProps { active: boolean; icon: string; label: string; onClick: () => void; badge?: string }

function NavButton({ active, icon, label, onClick, badge }: NavButtonProps) { return <button aria-current={active ? 'page' : undefined} className={`nav-button${active ? ' nav-button--active' : ''}`} onClick={onClick} type="button"><span aria-hidden="true" className="nav-button__icon">{icon}</span><span>{label}</span>{badge && <span aria-label={`${badge} items`} className="nav-badge">{badge}</span>}</button> }

function TeammatesHome({ teammates, attentionCount, onSelect, onNeedsMe, onQuickTask }: { teammates: readonly Teammate[]; attentionCount: number; onSelect: (teammate: Teammate) => void; onNeedsMe: () => void; onQuickTask: (teammateId: string, text: string) => void }) {
  const atlasId = teammates.find((teammate) => teammate.id === 'atlas')?.id ?? teammates[0]?.id ?? ''
  const [target, setTarget] = useState(atlasId)
  const [task, setTask] = useState('')

  const handleQuickTaskSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!task.trim() || !target) {return}

    onQuickTask(target, task)
    setTask('')
  }

  return <section aria-labelledby="teammates-title" className="teammates-home"><div className="hero-copy"><p className="kicker">Your team at a glance</p><h2 id="teammates-title">Your team is ready.</h2><p className="screen-lede">Send a quick text task or open a teammate.</p></div><form aria-label="Quick task" className="quick-task" onSubmit={handleQuickTaskSubmit}><div className="quick-task__heading"><div><p className="kicker">Quick task</p><h3>Delegate something now</h3></div><span aria-hidden="true">↗</span></div><label htmlFor="quick-task-target">Assign to</label><select id="quick-task-target" onChange={(event) => setTarget(event.target.value)} value={target}>{teammates.map((teammate) => <option key={teammate.id} value={teammate.id}>{teammate.name}</option>)}</select><label htmlFor="quick-task-text">Task</label><textarea id="quick-task-text" onChange={(event) => setTask(event.target.value)} placeholder="What should Hermes do?" rows={3} value={task} /><button className="primary-button" disabled={!task.trim() || !target} type="submit">Send task</button></form>{attentionCount > 0 && <button className="attention-banner" onClick={onNeedsMe} type="button"><span className="attention-banner__count">{attentionCount}</span><span><strong>Needs your judgment</strong><small>Review runtime-local attention</small></span><span aria-hidden="true">→</span></button>}<div className="section-heading"><div><p className="kicker">Available profiles</p><h3>Teammates</h3></div><span>{teammates.length} total</span></div><Roster onSelect={onSelect} teammates={[...teammates]} /></section>
}

function ChooseTeammate({ onBack }: { onBack: () => void }) { return <section className="search-empty"><h2>Choose a teammate first</h2><p>Select a teammate to create a conversation.</p><button className="primary-button" onClick={onBack} type="button">View teammates</button></section> }
