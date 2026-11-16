import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { formatTime } from '../../utils/format.js';
import { removeJob } from '../../api/files.js';

const PAGE_SIZE = 25;

/**
 * Queue-Tabelle: Pfad, Event, Status, Zeit, Aktionen (Remove bei pending).
 * Pagination für große Listen.
 */
export default function QueueTable({ jobs }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [busyId, setBusyId] = useState(null);

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
          {slice.map((job) => (
            <tr key={job.id}>
              <td className="files__cell--mono">{job.path}</td>
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
          ))}
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
