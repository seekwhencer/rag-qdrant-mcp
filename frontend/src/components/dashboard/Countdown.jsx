import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Live-Countdown bis zu einem absoluten Zeitstempel (ISO).
 * Taktet lokal jede Sekunde – der Server pusht nur bei jedem
 * Verbindungsversuch einen frischen `nextAttemptAt`.
 *
 * @param {object} props
 * @param {string|null} props.to - ISO-Zeitstempel des nächsten Versuchs (null = kein Plan)
 */
export default function Countdown({ to }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!to) return <span>—</span>;
  const target = new Date(to).getTime();
  if (Number.isNaN(target)) return <span>—</span>;

  const remainingSec = Math.max(0, Math.round((target - now) / 1000));
  if (remainingSec <= 0) return <span>{t('dashboard.qdrant.nextAttemptNow')}</span>;
  return <span>{t('dashboard.qdrant.nextAttemptIn', { sec: remainingSec })}</span>;
}
