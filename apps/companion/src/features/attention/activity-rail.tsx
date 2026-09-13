import { appCopy } from '../../copy/app'
import type { CompanionMessage } from '../../state/companion-store'

interface ActivityRailProps {
  messages: readonly CompanionMessage[]
  teammateName?: string
}

export function ActivityRail({ messages, teammateName }: ActivityRailProps) {
  const recent = messages.slice(-4).reverse()

  return (
    <aside aria-labelledby="activity-title" className="activity-rail">
      <div className="rail-heading"><p className="kicker">{appCopy.attention.activity.kicker}</p><h2 id="activity-title">{appCopy.attention.activity.title}</h2></div>
      {recent.length > 0
        ? <ol className="timeline">{recent.map((message) => <li key={message.id}><span className="timeline__mark timeline__mark--mint">{message.role === 'user' ? '↑' : '✓'}</span><div><strong>{message.role === 'user' ? appCopy.attention.activity.sent : appCopy.attention.activity.replied(teammateName ?? 'Hermes')}</strong><p>{message.text.slice(0, 80)}</p></div></li>)}</ol>
        : <p className="screen-lede">{appCopy.attention.activity.empty}</p>}
      <div className="rail-note"><span aria-hidden="true">H+</span><p><strong>{appCopy.attention.activity.calmTitle}</strong><br />{appCopy.attention.activity.calmDetail}</p></div>
    </aside>
  )
}
