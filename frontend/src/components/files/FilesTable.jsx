import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatBytes, formatTime } from '../../utils/format.js';

const PAGE_SIZE = 25;

/**
 * Files-Tabelle (Struktur-Spiegel): Pfad, Größe, mtime, Status, letztes Event.
 * Pagination für große Listen.
 */
export default function FilesTable({ files }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);

  const list = files || [];
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const slice = list.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  if (list.length === 0) {
    return <p className="files__empty">{t('files.empty.files')}</p>;
  }

  return (
    <div className="files__table-wrap">
      <table className="files__table">
        <thead>
          <tr>
            <th>{t('files.files.path')}</th>
            <th>{t('files.files.size')}</th>
            <th>{t('files.files.mtime')}</th>
            <th>{t('files.files.status')}</th>
            <th>{t('files.files.lastEvent')}</th>
          </tr>
        </thead>
        <tbody>
          {slice.map((f) => (
            <tr key={f.path}>
              <td className="files__cell--mono">{f.path}</td>
              <td className="files__cell--mono">
                {f.status === 'deleted' ? '—' : formatBytes(f.size)}
              </td>
              <td className="files__cell--mono">{formatTime(f.mtime)}</td>
              <td>
                <span className={`files__status files__status--${f.status}`}>
                  {t(`files.status.${f.status}`)}
                </span>
              </td>
              <td>
                <span className={`files__tag files__tag--${f.lastEvent}`}>
                  {t(`files.event.${f.lastEvent}`)}
                </span>
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
