/**
 * Broadcastet ein Payload an alle Listener (Fehler pro Listener isoliert).
 * @param {Set<Function>} listeners
 * @param {*} [payload]
 * @param {{logger?: object, label?: string}} [opts]
 */
function broadcastToListeners(listeners, payload, { logger, label } = {}) {
    const log = logger || { error: () => {} };
    for (const listener of listeners) {
        try {
            listener(payload);
        } catch (err) {
            log.error(label, `broadcast failed: ${err.message}`);
        }
    }
}

export { broadcastToListeners };
