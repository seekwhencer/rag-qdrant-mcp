/**
 * Generische Info-Karte: Titel + Zeilen (Label → Wert) und/oder Blöcke (Überschrift + Zeilen).
 *
 * @param {object} props
 * @param {string} props.title
 * @param {React.ReactNode} [props.icon]
 * @param {Array<{label: string, value: React.ReactNode, mono?: boolean, status?: 'ok'|'err'|'warn'}>} [props.rows]
 * @param {Array<{title: string, rows: Array<{label: string, value: React.ReactNode, mono?: boolean, status?: 'ok'|'err'|'warn'}>}>} [props.blocks]
 * @param {React.ReactNode} [props.footer]
 */
function RowList({ rows }) {
  return (
    <dl className="dash-card__rows">
      {rows.map((r, i) => (
        <div key={i} className="dash-card__row">
          <dt className="dash-card__label">{r.label}</dt>
          <dd
            className={`dash-card__value${r.mono ? ' dash-card__value--mono' : ''}${
              r.status ? ` dash-card__value--${r.status}` : ''
            }`}
          >
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function InfoCard({ title, icon, rows, blocks, footer }) {
  return (
    <article className="dash-card">
      <header className="dash-card__header">
        {icon && <span className="dash-card__icon">{icon}</span>}
        <h3 className="dash-card__title">{title}</h3>
      </header>
      {rows && rows.length > 0 && <RowList rows={rows} />}
      {blocks?.map((b, i) => (
        <section key={i} className="dash-card__block">
          <h4 className="dash-card__block-title">{b.title}</h4>
          <RowList rows={b.rows} />
        </section>
      ))}
      {footer && <footer className="dash-card__footer">{footer}</footer>}
    </article>
  );
}
