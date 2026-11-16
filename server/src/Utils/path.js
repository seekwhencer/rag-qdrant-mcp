import { isAbsolute, relative, sep } from 'node:path';

/**
 * Normalisiert einen Pfad relativ zum Root (POSIX-Slashes).
 * Path-Guard: leer / absolut / `..` (außerhalb des Roots) → null.
 * @param {string} root
 * @param {string} fullPath
 * @returns {string|null}
 */
function toRelPath(root, fullPath) {
    const rel = relative(root, fullPath);
    const normalized = rel.split(sep).join('/');
    if (normalized === '' || isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
        return null;
    }
    return normalized;
}

export { toRelPath };
