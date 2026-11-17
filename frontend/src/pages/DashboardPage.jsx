import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Server, Database, Cpu, FileText, Folder } from 'lucide-react';
import { useDashboardStream } from '../hooks/useDashboardStream.js';
import InfoCard from '../components/dashboard/InfoCard.jsx';
import McpCard from '../components/dashboard/McpCard.jsx';
import Countdown from '../components/dashboard/Countdown.jsx';
import Modal from '../components/ui/Modal.jsx';
import { formatUptime, formatBytes, formatTime } from '../utils/format.js';

/** Array → lesbare Zeile (leer → '—'). */
function arr(a) {
  return Array.isArray(a) && a.length > 0 ? a.join(', ') : '—';
}

/** MB-Wert → lesbar (ungültig → '—'). */
function mb(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${v.toFixed(1)} MB` : '—';
}

/** DB-Config (host/port/database) → Endpunkt-Zeile (host:port/db). */
function dbEndpoint(d) {
  if (!d?.host) return '—';
  const hostPort = d.port ? `${d.host}:${d.port}` : d.host;
  return d.database ? `${hostPort}/${d.database}` : hostPort;
}

/** /version liefert ein Map (Paket → Version) → kompakte Zeile. */
function versionString(v) {
  if (!v) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if (v['docling-serve']) return String(v['docling-serve']);
    const entries = Object.entries(v);
    return entries.length > 0 ? entries.map(([k, val]) => `${k} ${val}`).join(' · ') : '—';
  }
  return String(v);
}

/** Endpunkt-Ergebnis → Wert + Status für eine InfoCard-Zeile. */
function endpointRow(e) {
  if (!e) return { value: '—', status: undefined };
  if (e.ok) return { value: e.data?.status ?? 'ok', status: 'ok' };
  return { value: e.error || 'error', status: 'err' };
}

/** Modell-Konfig (api/url/model) → Status-, Endpoint- und Model-Zeile. */
function modelRows(m, t) {
  return [
    {
      label: t('dashboard.models.status'),
      value: m?.api || '—',
      status: m?.api ? 'ok' : 'warn'
    },
    { label: t('dashboard.models.endpoint'), value: m?.url || '—', mono: true },
    { label: t('dashboard.models.model'), value: m?.model || '—', mono: true }
  ];
}

export default function DashboardPage() {
  const { t } = useTranslation();
  const { data, connected, error } = useDashboardStream();
  const [doclingDetailsOpen, setDoclingDetailsOpen] = useState(false);

  const server = data?.server;
  const qdrant = data?.qdrant;
  const db = data?.database;
  const files = data?.files;
  const docling = data?.docling;
  const embeddings = data?.embeddings;
  const chat = data?.chat;
  const vision = data?.vision;

  const ep = (key) => docling?.endpoints?.[key];
  const healthRow = endpointRow(ep('health'));
  const readyRow = endpointRow(ep('ready'));
  const caps = ep('capabilities')?.data;
  const memStats = ep('memoryStats')?.data;
  const memCounts = ep('memoryCounts')?.data;

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
              title={t('dashboard.files.title')}
              icon={<Folder size={18} />}
              rows={[
                { label: t('dashboard.files.folder'), value: files?.root || '—', mono: true },
                { label: t('dashboard.files.pending'), value: files?.pending ?? 0, mono: true },
                { label: t('dashboard.files.processing'), value: files?.processing ?? 0, mono: true },
                { label: t('dashboard.files.done'), value: files?.done ?? 0, mono: true },
                { label: t('dashboard.files.errors'), value: files?.error ?? 0, mono: true },
                { label: t('dashboard.files.cancelled'), value: files?.cancelled ?? 0, mono: true }
              ]}
            />

            <InfoCard
              title={t('dashboard.database.title')}
              icon={<Database size={18} />}
              rows={[
                {
                  label: t('dashboard.database.status'),
                  value: db?.reachable ? t('dashboard.database.reachable') : t('dashboard.database.unreachable'),
                  status: db?.reachable ? 'ok' : 'err'
                },
                {
                  label: t('dashboard.database.endpoint'),
                  value: dbEndpoint(db),
                  mono: true
                }
              ]}
            />

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
              title={t('dashboard.docling.title')}
              icon={<FileText size={18} />}
              rows={[
                {
                  label: t('dashboard.docling.status'),
                  value: !docling?.configured
                    ? t('dashboard.docling.notConfigured')
                    : docling?.reachable
                      ? t('dashboard.docling.reachable')
                      : t('dashboard.docling.unreachable'),
                  status: !docling?.configured ? 'warn' : docling?.reachable ? 'ok' : 'err'
                },
                {
                  label: t('dashboard.docling.endpoint'),
                  value: docling?.url || '—',
                  mono: true
                },
                { label: t('dashboard.docling.health'), ...healthRow },
                { label: t('dashboard.docling.ready'), ...readyRow },
                { label: t('dashboard.docling.version'), value: versionString(ep('version')?.data), mono: true },
                { label: t('dashboard.docling.memoryRss'), value: mb(memStats?.rss), mono: true },
                { label: t('dashboard.docling.memoryCgroup'), value: mb(memStats?.cgroup_total), mono: true },
                { label: t('dashboard.docling.objects'), value: memCounts?.objects?.total ?? '—', mono: true },
                {
                  label: t('dashboard.docling.tasks'),
                  value: memCounts?.asyncio
                    ? `${memCounts.asyncio.pending_tasks ?? 0}/${memCounts.asyncio.all_tasks ?? 0}`
                    : '—',
                  mono: true
                },
                {
                  label: t('dashboard.docling.pollInterval'),
                  value: docling?.pollIntervalSec ? `${docling.pollIntervalSec}s` : '—',
                  mono: true
                },
                { label: t('dashboard.docling.checked'), value: formatTime(docling?.checkedAt) || '—', mono: true }
              ]}
              footer={
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => setDoclingDetailsOpen(true)}>
                  {t('dashboard.docling.more')}
                </button>
              }
            />

            <InfoCard
              title={t('dashboard.models.title')}
              icon={<Cpu size={18} />}
              blocks={[
                {
                  title: t('dashboard.models.embeddings'),
                  rows: modelRows(embeddings, t)
                },
                {
                  title: t('dashboard.models.chat'),
                  rows: modelRows(chat, t)
                },
                {
                  title: t('dashboard.models.vision'),
                  rows: modelRows(vision, t)
                }
              ]}
            />
          </div>
        )}
      </div>

      <Modal
        open={doclingDetailsOpen}
        title={t('dashboard.docling.detailsTitle')}
        onClose={() => setDoclingDetailsOpen(false)}
      >
        <dl className="dash-card__rows">
          <div className="dash-card__row">
            <dt className="dash-card__label">{t('dashboard.docling.sources')}</dt>
            <dd className="dash-card__value dash-card__value--mono">{arr(caps?.sources)}</dd>
          </div>
          <div className="dash-card__row">
            <dt className="dash-card__label">{t('dashboard.docling.targets')}</dt>
            <dd className="dash-card__value dash-card__value--mono">{arr(caps?.targets?.allowed)}</dd>
          </div>
          <div className="dash-card__row">
            <dt className="dash-card__label">{t('dashboard.docling.outputFormats')}</dt>
            <dd className="dash-card__value dash-card__value--mono">{arr(caps?.output_formats)}</dd>
          </div>
        </dl>
      </Modal>
    </div>
  );
}
