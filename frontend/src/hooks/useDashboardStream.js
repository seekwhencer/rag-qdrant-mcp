import { useEffect, useRef, useState } from 'react';

const RECONNECT_MS = 2000;

/**
 * WebSocket-Client für das Dashboard (/dashboard).
 * Liefert: data (Status-Snapshot), connected, error.
 *
 * Kein Pollen: der Server pusht einen Snapshot auf Connect und danach
 * Updates, wenn sich etwas ändert (MCP-Sessions, Qdrant, Server-Status).
 *
 * Protokoll:
 *   { type: 'snapshot', data: status } — einmalig auf Connect
 *   { type: 'update',   data: status } — bei jeder Änderung
 */
export function useDashboardStream({ enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!enabled) return;
    let closed = false;

    function connect() {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/dashboard`);
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

  return { data, connected, error };
}
