/**
 * Generische Info-Karte: Titel + Zeilen (Label → Wert).
 *
 * @param {object} props
 * @param {string} props.title
 * @param {React.ReactNode} [props.icon]
 * @param {Array<{label: string, value: React.ReactNode, mono?: boolean, status?: 'ok'|'err'|'warn'}>} props.rows
 * @param {React.ReactNode} [props.footer]
 */
export default function InfoCard({ title, icon, rows, footer }) {
  return (
    <article className="dash-card">
      <header className="dash-card__header">
        {icon && <span className="dash-card__icon">{icon}</span>}
        <h3 className="dash-card__title">{title}</h3>
      </header>
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
      {footer && <footer className="dash-card__footer">{footer}</footer>}
    </article>
  );
}
