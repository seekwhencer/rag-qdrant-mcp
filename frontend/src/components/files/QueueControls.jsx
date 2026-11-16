import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, XCircle } from 'lucide-react';
import { pauseQueue, resumeQueue, abortQueue } from '../../api/files.js';

/**
 * Queue-Steuerung: Pause/Resume + Abbrechen.
 * Der Server antwortet mit einem Snapshot, der WebSocket pusht es weiter.
 */
export default function QueueControls({ paused }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // Fehleranzeige kommt über den Stream/Server; Buttons bleiben bedienbar.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="files__controls">
      {paused ? (
        <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => run(resumeQueue)}>
          <Play size={16} />
          <span>{t('files.queue.resume')}</span>
        </button>
      ) : (
        <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => run(pauseQueue)}>
          <Pause size={16} />
          <span>{t('files.queue.pause')}</span>
        </button>
      )}
      <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => run(abortQueue)}>
        <XCircle size={16} />
        <span>{t('files.queue.abort')}</span>
      </button>
    </div>
  );
}
