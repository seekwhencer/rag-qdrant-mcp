/**
 * Trackt verbundene MCP-Clients (Systeme am MCP-Endpunkt).
 *
 * Das MCP-SDK läuft stateless (keine Session-IDs), daher werden Clients
 * über ihre Identität erkannt: Quell-IP + User-Agent (beide sind bei jeder
 * Anfrage verfügbar). Beim `initialize`-Request wird zusätzlich die
 * Client-Info (Name + Version) erfasst.
 *
 * Ein Client gilt als verbunden, solange er aktiv ist. Nach einer
 * Inaktivitäts-Dauer (Idle-Timeout) wird er entfernt.
 *
 * Broadcastet Änderungen an Listener (Dashboard-WebSocket), damit das
 * Dashboard live ohne Pollen aktualisiert wird.
 */
class McpSessionTracker {
    /**
     * @param {object} [opts]
     * @param {Logger} [opts.logger]
     * @param {number} [opts.idleTimeoutMs] - Client nach dieser Inaktivität entfernen
     * @param {number} [opts.sweepIntervalMs] - Wie oft nach inaktiven Clients gefegt wird
     */
    constructor({ logger, idleTimeoutMs = 5 * 60 * 1000, sweepIntervalMs = 30 * 1000 } = {}) {
        this.label = '[McpSessions]';
        this.logger = logger || { log: () => {}, error: () => {} };
        this.idleTimeoutMs = idleTimeoutMs;
        this.sweepIntervalMs = sweepIntervalMs;
        this.clients = new Map(); // key (ip|userAgent) -> record
        this.listeners = new Set(); // () => void
        this.timer = null;
        this.emitTimer = null;
        this.lastEmit = 0;
    }

    /** Startet den Idle-Sweep-Timer. */
    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
        if (this.timer.unref) this.timer.unref();
    }

    /** Stoppt die Timer und entfernt alle Listener. */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.emitTimer) {
            clearTimeout(this.emitTimer);
            this.emitTimer = null;
        }
        this.listeners.clear();
    }

    /** Identitäts-Key aus IP + User-Agent. */
    makeKey(ip, userAgent) {
        return `${ip || 'unknown'}|${userAgent || 'unknown'}`;
    }

    /**
     * Client upserten (neuer Client oder Aktivität).
     * @returns {boolean} true, wenn ein NEUER Client hinzugefügt wurde
     */
    touch({ ip, host = '', userAgent = '', clientInfo = null }) {
        const key = this.makeKey(ip, userAgent);
        const now = new Date().toISOString();
        const existing = this.clients.get(key);
        const record = existing || {
            key,
            name: clientInfo?.name || '',
            version: clientInfo?.version || '',
            host,
            userAgent,
            ip: ip || '',
            firstSeen: now,
            requests: 0
        };
        if (clientInfo) {
            record.name = clientInfo.name || record.name;
            record.version = clientInfo.version || record.version;
        }
        record.lastSeen = now;
        record.requests += 1;
        this.clients.set(key, record);

        if (!existing) {
            this.logger.log(this.label, `Client verbunden: ${record.name || record.userAgent || ip} (${this.clients.size} aktiv)`);
        }
        this.emitChange();
        return !existing;
    }

    /** Entfernt inaktive Clients. */
    sweep() {
        const now = Date.now();
        let changed = false;
        for (const [key, rec] of this.clients) {
            const last = Date.parse(rec.lastSeen);
            if (Number.isFinite(last) && now - last > this.idleTimeoutMs) {
                this.clients.delete(key);
                changed = true;
                this.logger.log(this.label, `Client inaktiv entfernt: ${rec.name || rec.userAgent || rec.ip}`);
            }
        }
        if (changed) this.emitChange();
    }

    /** Snapshot für das Dashboard. */
    getSnapshot() {
        const sessions = [...this.clients.values()].map((r) => ({ ...r }));
        sessions.sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : -1));
        return { sessions, count: sessions.length };
    }

    /** Listener abonnieren. Gibt eine Unsubscribe-Funktion zurück. */
    addListener(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /**
     * An alle Listener broadcasten (Fehler pro Listener isoliert).
     * Gedrosselt: max. ein Broadcast pro 300ms, mit trailing-Emit, damit
     * Request-Bursts nicht zu vielen Nachrichten führen.
     */
    emitChange() {
        const now = Date.now();
        const wait = 300 - (now - this.lastEmit);
        if (wait > 0) {
            if (!this.emitTimer) {
                this.emitTimer = setTimeout(() => {
                    this.emitTimer = null;
                    this.lastEmit = Date.now();
                    this.doEmit();
                }, wait);
                if (this.emitTimer.unref) this.emitTimer.unref();
            }
            return;
        }
        this.lastEmit = now;
        this.doEmit();
    }

    /** Tatsächlicher Broadcast an alle Listener. */
    doEmit() {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch (err) {
                this.logger.error(this.label, `broadcast failed: ${err.message}`);
            }
        }
    }
}

export { McpSessionTracker };
