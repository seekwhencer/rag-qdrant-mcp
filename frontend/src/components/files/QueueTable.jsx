import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { formatTime } from '../../utils/format.js';
import { removeJob } from '../../api/files.js';

const PAGE_SIZE = 25;

/**
 * Queue-Tabelle: Pfad, Event, Status, Zeit, Aktionen (Remove bei pending).
 * Pagination für große Listen.
 *
 * Progress-Log: für processing + pending Jobs aufklappbar. Zugeklappt blinkt
 * ein kleines Viereck, solange neue Log-Zeilen seit dem letzten Aufklappen
 * eingetroffen sind. Aufgeklappt zeigt die Zeile das Live-Log.
 */
export default function QueueTable({ jobs, progressLogs = {} }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [busyId, setBusyId] = useState(null);
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [seenLineCounts, setSeenLineCounts] = useState({});

  const list = jobs || [];
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const slice = list.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  const handleRemove = async (job) => {
    setBusyId(job.id);
    try {
      await removeJob(job.id);
    } catch {
      // Snapshot-Update kommt über den Stream; Button bleibt bedienbar.
    } finally {
      setBusyId(null);
    }
  };

  /** Alle Jobs sind aufklappbar — das Log bleibt auch nach Fertigstellung erhalten. */
  const canExpand = () => true;

  /**
   * Zeile auf-/zuklappen. Beim Wechsel wird die Anzahl der "gesehenen" Zeilen
   * auf den aktuellen Stand gesetzt → Blinken stoppen (Zeilen wurden gesehen).
   */
  const toggleExpand = (jobId, lineCount) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
    setSeenLineCounts((prev) => ({ ...prev, [jobId]: lineCount }));
  };

  if (list.length === 0) {
    return <p className="files__empty">{t('files.empty.queue')}</p>;
  }

  return (
    <div className="files__table-wrap">
      <table className="files__table">
        <thead>
          <tr>
            <th>{t('files.queue.path')}</th>
            <th>{t('files.queue.event')}</th>
            <th>{t('files.queue.status')}</th>
            <th>{t('files.queue.enqueuedAt')}</th>
            <th>{t('files.queue.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {slice.map((job) => {
            const expandable = canExpand(job);
            const isExpanded = expandedIds.has(job.id);
            const lines = progressLogs[job.id] || [];
            const newLines = lines.length - (seenLineCounts[job.id] || 0);
            return (
              <Fragment key={job.id}>
                <tr className={isExpanded ? 'files__row--expanded' : ''}>
                  <td className="files__cell--mono">
                    {expandable && (
                      <button
                        type="button"
                        className="files__expand-btn"
                        onClick={() => toggleExpand(job.id, lines.length)}
                        aria-expanded={isExpanded}
                        title={isExpanded ? t('files.queue.collapse') : t('files.queue.expand')}
                      >
                        <ChevronRight size={14} className={`files__chevron${isExpanded ? ' files__chevron--open' : ''}`} />
                      </button>
                    )}
                    {job.status === 'pending' && !isExpanded && newLines > 0 && (
                      <span className="files__blink" title={t('files.queue.newLines', { count: newLines })} />
                    )}
                    {job.path}
                  </td>
                  <td>
                    <span className={`files__tag files__tag--${job.event}`}>
                      {t(`files.event.${job.event}`)}
                    </span>
                  </td>
                  <td>
                    <span className={`files__status files__status--${job.status}`}>
                      {t(`files.status.${job.status}`)}
                    </span>
                  </td>
                  <td className="files__cell--mono">{formatTime(job.enqueuedAt)}</td>
                  <td>
                    {job.status === 'pending' ? (
                      <button
                        type="button"
                        className="btn btn--secondary btn--xs"
                        title={t('files.queue.remove')}
                        disabled={busyId === job.id}
                        onClick={() => handleRemove(job)}
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </td>
                </tr>
                {isExpanded && expandable && (
                  <tr className="files__log-row">
                    <td colSpan={5}>
                      <div className="files__log">
                        {lines.length === 0 ? (
                          <div className="files__log-empty">{t('files.queue.logEmpty')}</div>
                        ) : (
                          lines.map((entry, i) => (
                            <div key={i} className="files__log-line">
                              <span className="files__log-ts">{formatTime(entry.ts)}</span>
                              <span className="files__log-text">{entry.line}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {pageCount > 1 && (
        <div className="files__pagination">
          <button
            type="button"
            className="btn btn--secondary btn--xs"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            <ChevronLeft size={14} />
          </button>
          <span>
            {current + 1} / {pageCount}
          </span>
          <button
            type="button"
            className="btn btn--secondary btn--xs"
            disabled={current >= pageCount - 1}
            onClick={() => setPage(current + 1)}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
