import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Trash2 } from 'lucide-react';
import { useLogStream } from '../hooks/useLogStream.js';
import LogViewer from '../components/logs/LogViewer.jsx';

const LEVELS = ['ERR', 'WAR', 'INF', 'DBG'];

export default function LogsPage() {
  const { t } = useTranslation();
  const { lines, connected, error, clear } = useLogStream();
  const [levelFilter, setLevelFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState(null);

  // Pause = client-seitig: Ansicht einfrieren (Snapshot), WebSocket bleibt verbunden.
  const togglePause = () => {
    if (paused) {
      setPaused(false);
      setFrozen(null);
    } else {
      setFrozen(lines);
      setPaused(true);
    }
  };

  const source = paused && frozen ? frozen : lines;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return source.filter((l) => {
      if (levelFilter !== 'ALL' && l.level !== levelFilter) return false;
      if (q && !`${l.message}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [source, levelFilter, search]);

  return (
    <div className="logs-page">
      <div className="logs">
        <header className="logs__header">
          <div>
            <h1 className="logs__title">{t('pages.logs.title')}</h1>
            <p className="logs__subtitle">
              {t('pages.logs.subtitle')}{' '}
              <span className={`logs__status${connected ? ' is-on' : ' is-off'}`}>
                {connected ? t('pages.logs.live') : t('pages.logs.offline')}
              </span>
            </p>
          </div>
          <div className="logs__controls">
            <div className="logs__levels" role="group" aria-label={t('pages.logs.levelFilter')}>
              <button type="button" className={levelFilter === 'ALL' ? 'is-active' : ''} onClick={() => setLevelFilter('ALL')}>{t('pages.logs.levelAll')}</button>
              {LEVELS.map((lv) => (
                <button key={lv} type="button" className={levelFilter === lv ? 'is-active' : ''} onClick={() => setLevelFilter(lv)}>{lv}</button>
              ))}
            </div>
            <input
              type="text"
              className="logs__search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('pages.logs.search')}
            />
            <button type="button" className="btn btn--secondary btn--sm" onClick={togglePause}>
              {paused ? <Play size={16} /> : <Pause size={16} />}
              <span>{paused ? t('pages.logs.resume') : t('pages.logs.pause')}</span>
            </button>
            <button type="button" className="btn btn--secondary btn--sm" onClick={clear}>
              <Trash2 size={16} />
              <span>{t('pages.logs.clear')}</span>
            </button>
          </div>
        </header>

        <div className="logs__body">
          <LogViewer lines={filtered} connected={connected} error={error} />
        </div>
      </div>
    </div>
  );
}
