/**
 * Files-API-Client.
 *
 * Endpunkte (gleiche Origin):
 *   POST   /api/files/queue/pause  → Snapshot
 *   POST   /api/files/queue/resume → Snapshot
 *   POST   /api/files/queue/abort  → Snapshot
 *   DELETE /api/files/queue/:jobId → { job, snapshot }
 */
const API_BASE = '/api/files';

/**
 * Führt einen JSON-Request aus und liefert den Response-Body.
 * @param {string} path - Der API-Pfad
 * @param {object} [options={}] - Fetch-Optionen (method, body)
 * @returns {Promise<object>} Der Response-Body
 */
async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...options,
    });
  } catch (err) {
    throw new Error('Connection to server failed.');
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Request failed with status ${res.status}`);
  }
  return body;
}

/** Pause: Dispatcher stoppt, aktive Jobs laufen zu Ende. */
export const pauseQueue = () => request(`${API_BASE}/queue/pause`, { method: 'POST' });

/** Resume: Dispatcher läuft weiter. */
export const resumeQueue = () => request(`${API_BASE}/queue/resume`, { method: 'POST' });

/** Abort: alle pending → cancelled, aktive Jobs via AbortSignal. */
export const abortQueue = () => request(`${API_BASE}/queue/abort`, { method: 'POST' });

/** Pending-Job entfernen (nur pending löschbar). */
export const removeJob = (jobId) => request(`${API_BASE}/queue/${jobId}`, { method: 'DELETE' });
