import { useTranslation } from 'react-i18next';
import { Server, Database, Cpu } from 'lucide-react';
import { useDashboardStream } from '../hooks/useDashboardStream.js';
import InfoCard from '../components/dashboard/InfoCard.jsx';
import McpCard from '../components/dashboard/McpCard.jsx';
import Countdown from '../components/dashboard/Countdown.jsx';
import { formatUptime, formatBytes, formatTime } from '../utils/format.js';

export default function DashboardPage() {
  const { t } = useTranslation();
  const { data, connected, error } = useDashboardStream();

  const server = data?.server;
  const qdrant = data?.qdrant;
  const embeddings = data?.embeddings;
  const chat = data?.chat;

  return (
    <div className="dash-page">
      <div className="dash">
        <header className="dash__header">
          <div>
            <h1 className="dash__title">{t('dashboard.title')}</h1>
            <p className="dash__subtitle">
              {t('dashboard.subtitle')}{' '}
              <span className={`dash__status${connected ? ' is-on' : ' is-off'}`}>
                {connected ? t('dashboard.live') : t('dashboard.offline')}
              </span>
            </p>
          </div>
          {data && (
            <span className="dash__updated" title={data.ts}>
              {t('dashboard.updated')} {formatTime(data.ts)}
            </span>
          )}
        </header>

        {error && <div className="dash__error">{t('dashboard.error')}</div>}
        {!data && !error && <div className="dash__loading">{t('dashboard.loading')}</div>}

        {data && (
          <div className="dash__grid">
            <McpCard mcp={data.mcp} />

            <InfoCard
              title={t('dashboard.qdrant.title')}
              icon={<Database size={18} />}
              rows={[
                {
                  label: t('dashboard.qdrant.status'),
                  value: qdrant?.reachable ? t('dashboard.qdrant.reachable') : t('dashboard.qdrant.unreachable'),
                  status: qdrant?.reachable ? 'ok' : 'err'
                },
                {
                  label: t('dashboard.qdrant.endpoint'),
                  value: [qdrant?.url, qdrant?.port].filter(Boolean).join(':') || '—',
                  mono: true
                },
                { label: t('dashboard.qdrant.collection'), value: qdrant?.collection || '—', mono: true },
                { label: t('dashboard.qdrant.version'), value: qdrant?.version || '—', mono: true },
                { label: t('dashboard.qdrant.points'), value: qdrant?.points ?? '—', mono: true },
                { label: t('dashboard.qdrant.attempts'), value: qdrant?.attempts ?? 0, mono: true },
                {
                  label: t('dashboard.qdrant.nextAttempt'),
                  value: <Countdown to={qdrant?.nextAttemptAt} />,
                  mono: true
                },
                {
                  label: t('dashboard.qdrant.retryDelay'),
                  value: `${qdrant?.retryDelaySec ?? '—'}s`,
                  mono: true
                },
                {
                  label: t('dashboard.qdrant.maxRetries'),
                  value: qdrant?.maxRetries === 0 ? t('dashboard.qdrant.unlimited') : qdrant?.maxRetries ?? '—',
                  mono: true
                }
              ]}
            />

            <InfoCard
              title={t('dashboard.server.title')}
              icon={<Server size={18} />}
              rows={[
                { label: t('dashboard.server.uptime'), value: formatUptime(server?.uptimeSec) },
                {
                  label: t('dashboard.server.memory'),
                  value: `${formatBytes(server?.memory?.heapUsed)} / ${formatBytes(server?.memory?.heapTotal)}`,
                  mono: true
                },
                { label: t('dashboard.server.node'), value: server?.node || '—', mono: true },
                { label: t('dashboard.server.platform'), value: server?.platform || '—', mono: true },
                {
                  label: t('dashboard.server.logs'),
                  value: `${server?.logLines ?? 0} (${server?.logErrors ?? 0} ${t('dashboard.server.errors')})`,
                  mono: true
                }
              ]}
            />

            <InfoCard
              title={t('dashboard.models.title')}
              icon={<Cpu size={18} />}
              rows={[
                {
                  label: t('dashboard.models.embeddings'),
                  value: [embeddings?.api, embeddings?.model].filter(Boolean).join(' · ') || '—',
                  mono: true
                },
                {
                  label: t('dashboard.models.chat'),
                  value: [chat?.api, chat?.model].filter(Boolean).join(' · ') || '—',
                  mono: true
                }
              ]}
            />
          </div>
        )}
      </div>
    </div>
  );
}
