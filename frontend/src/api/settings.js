/**
 * Settings-API-Client.
 *
 * Endpunkte (gleiche Origin):
 *   GET  /api/settings → Settings-Objekt (direkt, nicht in {success, data} verpackt)
 *   PUT  /api/settings → { applied, restartRequired }
 */
const API_BASE = '/api/settings';

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

/** Liefert die aktuellen Settings. */
export const getSettings = () => request(API_BASE);

/** Speichert einen Settings-Patch (z. B. `{ qdrant: { url } }`). */
export const updateSettings = (patch) =>
  request(API_BASE, { method: 'PUT', body: JSON.stringify(patch) });
