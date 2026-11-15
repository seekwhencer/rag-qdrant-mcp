/**
 * In-memory log buffer + broadcast service.
 *
 * Der Logger pusht formatierte Zeilen in diesen Service (via setSink).
 * Er hält einen Ring-Buffer (History) und broadcastet neue Zeilen an
 * Listener (WebSocket-Clients).
 *
 * Zeilen-Format: { ts, level, message, raw }
 */
class LogService {
    /**
     * @param {Logger} [logger]
     * @param {{ maxBuffer?: number }} [opts]
     */
    constructor(logger, { maxBuffer = 1000 } = {}) {
        this.label = '[LogService]';
        this.logger = logger || { log: () => {}, error: () => {} };
        this.maxBuffer = maxBuffer;
        this.buffer = [];           // Ring-Buffer: letzte maxBuffer Zeilen (History)
        this.listeners = new Set(); // (line, kind) => void — WebSocket-Clients
    }

    /** Eine Zeile in den Ring-Buffer legen + an alle Listener broadcasten. */
    push(line) {
        this.buffer.push(line);
        if (this.buffer.length > this.maxBuffer) this.buffer.shift();
        this.emit(line, 'line');
    }

    /** An alle Listener broadcasten (Fehler pro Listener isoliert). */
    emit(line, kind) {
        for (const listener of this.listeners) {
            try {
                listener(line, kind);
            } catch (err) {
                this.logger.error(this.label, `broadcast failed: ${err.message}`);
            }
        }
    }

    /** History (Kopie des Ring-Buffers) für neue Clients. */
    getHistory() {
        return this.buffer.slice();
    }

    /** Listener abonnieren. Gibt eine Unsubscribe-Funktion zurück. */
    addListener(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /** Listener entfernen (beim Server-Shutdown). */
    stop() {
        this.listeners.clear();
    }
}

export { LogService };
