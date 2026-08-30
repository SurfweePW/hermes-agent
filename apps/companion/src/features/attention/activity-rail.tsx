import type { CompanionMessage } from '../../state/companion-store'

interface ActivityRailProps {
  messages: readonly CompanionMessage[]
  teammateName?: string
}

export function ActivityRail({ messages, teammateName }: ActivityRailProps) {
  const recent = messages.slice(-4).reverse()

  return (
    <aside aria-labelledby="activity-title" className="activity-rail">
      <div className="rail-heading"><p className="kicker">Current conversation</p><h2 id="activity-title">Activity</h2></div>
      {recent.length > 0
        ? <ol className="timeline">{recent.map((message) => <li key={message.id}><span className="timeline__mark timeline__mark--mint">{message.role === 'user' ? '↑' : '✓'}</span><div><strong>{message.role === 'user' ? 'You sent a message' : `${teammateName ?? 'Hermes'} replied`}</strong><p>{message.text.slice(0, 80)}</p></div></li>)}</ol>
        : <p className="screen-lede">Conversation activity will appear here.</p>}
      <div className="rail-note"><span aria-hidden="true">H+</span><p><strong>Calm by default.</strong><br />Hermes only interrupts when your judgment changes what happens next.</p></div>
    </aside>
  )
}
