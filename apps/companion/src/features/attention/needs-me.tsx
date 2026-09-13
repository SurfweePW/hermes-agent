import type { GatewayAttentionItem } from '../../gateway/types'

interface NeedsMeProps {
  items: readonly GatewayAttentionItem[]
  scope: string
  onOpen: (item: GatewayAttentionItem) => void
  onRefresh: () => void
}

export function NeedsMe({ items, scope, onOpen, onRefresh }: NeedsMeProps) {
  if (items.length === 0) {return null}

  return (
    <section aria-labelledby="runtime-actions-title" className="needs-screen runtime-actions">
      <p className="kicker">Uprawnienia jednorazowe</p>
      <h2 id="runtime-actions-title">Akcje w aktywnych rozmowach <span className="heading-count">{items.length}</span></h2>
      <p className="screen-lede">Te prośby pozwalają kontynuować działanie tylko w bieżącej rozmowie. Trwałe decyzje powyżej zapisują kierunek pracy i nie udzielają zgody na wykonanie. Zakres: <strong>{scope}</strong>.</p>
      <button className="button" onClick={onRefresh} type="button">Odśwież</button>
      <div className="attention-list">
        {items.map((item) => {
          const actionable = item.actionable
            && (item.resolution === 'approval' || item.resolution === 'open_session')
            && Boolean(item.stored_session_id)

          return actionable ? (
            <button className="attention-item attention-item--amber" key={item.id} onClick={() => onOpen(item)} type="button">
              <span className="attention-item__number">!</span><span><span className="label">{item.kind} · {item.profile}</span><strong>{item.title}</strong><small>{item.detail || 'Otwórz dokładną prośbę.'}</small></span><span aria-hidden="true">→</span>
            </button>
          ) : (
            <article className="attention-item" key={item.id}>
              <span className="attention-item__number">i</span><span><span className="label">{item.kind} · {item.profile}</span><strong>{item.title}</strong><small>{item.detail}</small><em>Odpowiedz w źródłowym Hermesie.</em></span>
            </article>
          )
        })}
      </div>
    </section>
  )
}
