import { useTranslation } from 'react-i18next';
import { Plug, Users } from 'lucide-react';
import { formatTime } from '../../utils/format.js';

/**
 * MCP-Karte: Konfiguration + aktuell verbundene Systeme (Sessions).
 * Die Sessions-Liste wird live per WebSocket aktualisiert.
 */
export default function McpCard({ mcp }) {
  const { t } = useTranslation();
  const sessions = mcp?.sessions || [];

  return (
    <article className="dash-card dash-card--mcp">
      <header className="dash-card__header">
        <span className="dash-card__icon">
          <Plug size={18} />
        </span>
        <h3 className="dash-card__title">{t('dashboard.mcp.title')}</h3>
        <span className={`dash-badge${mcp?.enabled ? ' is-on' : ' is-off'}`}>
          {mcp?.enabled ? t('dashboard.mcp.enabled') : t('dashboard.mcp.disabled')}
        </span>
      </header>

      <div className="dash-mcp__meta">
        <span className="dash-mcp__path">{mcp?.path || '/mcp'}</span>
        <span className="dash-mcp__count">
          <Users size={14} />
          {sessions.length} {t('dashboard.mcp.connected')}
        </span>
      </div>

      {sessions.length === 0 ? (
        <p className="dash-mcp__empty">{t('dashboard.mcp.none')}</p>
      ) : (
        <ul className="dash-mcp__list">
          {sessions.map((s) => (
            <li key={s.key} className="dash-mcp__session">
              <span className="dash-mcp__dot" aria-hidden="true" />
              <div className="dash-mcp__info">
                <span className="dash-mcp__name">
                  {s.name || t('dashboard.mcp.unknown')}
                  {s.version ? (
                    <em className="dash-mcp__version">v{String(s.version).replace(/^v/i, '')}</em>
                  ) : null}
                </span>
                <span className="dash-mcp__sub">
                  {s.host ? `${s.host} · ` : ''}
                  {s.requests} {t('dashboard.mcp.requests')}
                </span>
              </div>
              <span className="dash-mcp__since" title={s.firstSeen}>
                {formatTime(s.firstSeen)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
