import { createHash } from 'node:crypto';

/**
 * SHA-256-Hash als Hex-String.
 * @param {string} text
 * @returns {string}
 */
function sha256Hex(text) {
    return createHash('sha256').update(String(text)).digest('hex');
}

/**
 * Wandelt einen 32-Zeichen-Hash (Hex) in UUID-Format um.
 * @param {string} hex
 * @returns {string}
 */
function hashToUuid(hex) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export { sha256Hex, hashToUuid };
