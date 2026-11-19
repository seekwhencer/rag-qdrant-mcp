import { useEffect, useRef, useState } from 'react';

const RECONNECT_MS = 2000;

/**
 * WebSocket-Client für die Datei-Verwaltung (/files).
 * Liefert: data (Snapshot: Stats + Queue + Files), progressLogs (jobId → [{ts, line}]),
 * connected, error.
 *
 * Kein Pollen: der Server pusht einen Snapshot auf Connect und danach
 * Updates, wenn sich etwas ändert (Queue, Files, Stats).
 * Progress-Zeilen kommen als separate {type:'progress'}-Messages (echtes Realtime).
 *
 * Protokoll:
 *   { type: 'snapshot', data: snapshot } — einmalig auf Connect
 *   { type: 'update',   data: snapshot } — bei jeder Änderung
 *   { type: 'progress', jobId, line, ts } — pro Progress-Zeile (Realtime)
 */
export function useFilesStream({ enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [progressLogs, setProgressLogs] = useState({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!enabled) return;
    let closed = false;

    function connect() {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/files`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setError(null);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'snapshot' || msg.type === 'update') {
            setData(msg.data);
            // Puffer aus dem Snapshot initialisieren (History für neue Clients).
            // Der Snapshot ist die Quelle der Wahrheit → Puffer wird synchronisiert.
            const logs = {};
            for (const job of msg.data?.queue || []) {
              if (job.progressLog && job.progressLog.length > 0) logs[job.id] = job.progressLog;
            }
            setProgressLogs(logs);
          } else if (msg.type === 'progress') {
            // Neue Progress-Zeile anhängen (Realtime, sofort sichtbar).
            setProgressLogs((prev) => ({
              ...prev,
              [msg.jobId]: [...(prev[msg.jobId] || []), { ts: msg.ts, line: msg.line }]
            }));
          }
        } catch { /* malformed → ignorieren */ }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!closed) timerRef.current = setTimeout(connect, RECONNECT_MS);
      };

      ws.onerror = () => setError(new Error('WebSocket-Fehler'));
    }

    connect();

    return () => {
      closed = true;
      clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [enabled]);

  return { data, progressLogs, connected, error };
}
