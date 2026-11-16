/**
 * Normalisiert eine URL: entfernt trailing Slashes.
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
    return String(url || '').replace(/\/+$/, '');
}

export { normalizeUrl };
