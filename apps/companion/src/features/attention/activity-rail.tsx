interface ActivityRailProps {
  decision?: string
}

export function ActivityRail({ decision }: ActivityRailProps) {
  return (
    <aside aria-labelledby="activity-title" className="activity-rail">
      <div className="rail-heading"><p className="kicker">Today</p><h2 id="activity-title">Activity</h2></div>
      {decision && <div className="decision-toast">Choice saved: <strong>{decision}</strong></div>}
      <ol className="timeline">
        <li><span className="timeline__mark timeline__mark--mint">✓</span><div><strong>Sources checked</strong><p>Atlas · Investment brief</p><time dateTime="15:41">3:41 PM</time></div></li>
        <li><span className="timeline__mark timeline__mark--blue">↗</span><div><strong>Portfolio review</strong><p>Mentor · Working</p><time dateTime="15:36">3:36 PM</time></div></li>
        <li><span className="timeline__mark timeline__mark--coral">!</span><div><strong>Work paused safely</strong><p>Maven · Connection lost</p><time dateTime="15:29">3:29 PM</time></div></li>
        <li><span className="timeline__mark timeline__mark--lilac">✓</span><div><strong>Source map ready</strong><p>Scout · Completed</p><time dateTime="14:54">2:54 PM</time></div></li>
      </ol>
      <div className="rail-note"><span aria-hidden="true">H+</span><p><strong>Calm by default.</strong><br />Hermes only interrupts when your judgment changes what happens next.</p></div>
    </aside>
  )
}
