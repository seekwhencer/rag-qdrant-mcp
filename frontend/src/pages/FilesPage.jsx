import { useTranslation } from 'react-i18next';
import { useFilesStream } from '../hooks/useFilesStream.js';
import QueueTable from '../components/files/QueueTable.jsx';
import QueueControls from '../components/files/QueueControls.jsx';
import FilesTable from '../components/files/FilesTable.jsx';
import { formatTime } from '../utils/format.js';

const STAT_KEYS = [
  { key: 'pending', label: 'files.stats.pending' },
  { key: 'processing', label: 'files.stats.processing' },
  { key: 'done', label: 'files.stats.done' },
  { key: 'error', label: 'files.stats.error' },
  { key: 'cancelled', label: 'files.stats.cancelled' },
];

export default function FilesPage() {
  const { t } = useTranslation();
  const { data, connected, error } = useFilesStream();

  const stats = data?.stats;

  return (
    <div className="files-page">
      <div className="files">
        <header className="files__header">
          <div>
            <h1 className="files__title">{t('files.title')}</h1>
            <p className="files__subtitle">
              {t('files.subtitle')}{' '}
              <span className={`files__status${connected ? ' is-on' : ' is-off'}`}>
                {connected ? t('files.live') : t('files.offline')}
              </span>
            </p>
          </div>
          {data && (
            <span className="files__updated" title={data.ts}>
              {t('files.updated')} {formatTime(data.ts)}
            </span>
          )}
        </header>

        {error && <div className="files__error">{t('files.error')}</div>}
        {!data && !error && <div className="files__loading">{t('files.loading')}</div>}

        {data && (
          <>
            <div className="files__stats">
              {STAT_KEYS.map((s) => (
                <div key={s.key} className={`files__stat files__stat--${s.key}`}>
                  <span className="files__stat-label">{t(s.label)}</span>
                  <span className="files__stat-value">{stats?.[s.key] ?? 0}</span>
                </div>
              ))}
            </div>

            <section className="files__section">
              <div className="files__section-header">
                <h2>{t('files.queue.title')}</h2>
                <QueueControls paused={Boolean(data.paused)} />
              </div>
              <QueueTable jobs={data.queue || []} />
            </section>

            <section className="files__section">
              <div className="files__section-header">
                <h2>{t('files.files.title')}</h2>
              </div>
              <FilesTable files={data.files || []} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
