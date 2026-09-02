import type { GatewayAttentionItem } from '../../gateway/types'

interface NeedsMeProps {
  items: readonly GatewayAttentionItem[]
  scope: string
  onOpen: (item: GatewayAttentionItem) => void
  onRefresh: () => void
}

export function NeedsMe({ items, scope, onOpen, onRefresh }: NeedsMeProps) {
  return (
    <section aria-labelledby="needs-title" className="needs-screen">
      <p className="kicker">Runtime-local attention</p>
      <h2 id="needs-title">Needs Me <span className="heading-count">{items.length}</span></h2>
      <p className="screen-lede">Scope: <strong>{scope}</strong>. This is not a global inbox; only items reported by the connected gateway runtime appear here.</p>
      <button onClick={onRefresh} type="button">Refresh</button>
      <div className="attention-list">
        {items.map((item) => {
          const actionable = item.actionable
            && (item.resolution === 'approval' || item.resolution === 'open_session')
            && Boolean(item.stored_session_id)
          return actionable ? (
            <button className="attention-item attention-item--amber" key={item.id} onClick={() => onOpen(item)} type="button">
              <span className="attention-item__number">!</span><span><span className="label">{item.kind} · {item.profile}</span><strong>{item.title}</strong><small>{item.detail || 'Open the stored session to review.'}</small></span><span aria-hidden="true">→</span>
            </button>
          ) : (
            <article className="attention-item" key={item.id}>
              <span className="attention-item__number">i</span><span><span className="label">{item.kind} · {item.profile}</span><strong>{item.title}</strong><small>{item.detail}</small><em>unsupported_here — open the originating Hermes runtime to respond.</em></span>
            </article>
          )
        })}
      </div>
      {items.length === 0 && <div className="all-clear"><span aria-hidden="true">✓</span><div><strong>Nothing needs you in this runtime</strong><p>No attention items were returned by attention.list.</p></div></div>}
    </section>
  )
}
