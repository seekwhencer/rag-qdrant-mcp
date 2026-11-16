/**
 * Aggregiert den Live-Status für das Dashboard und broadcastet Updates.
 *
 * Quellen:
 *   - Server (Port, Uptime, Memory, Log-Statistik)
 *   - MCP (Konfiguration + verbundene Sessions via McpSessionTracker)
 *   - Qdrant (Erreichbarkeit, Version, Punktanzahl) — serverseitig geprüft
 *   - Embeddings / Chat (Konfiguration)
 *
 * Das Dashboard (Client) pollt NICHT: es erhält per WebSocket einen
 * Snapshot auf Connect und danach Updates, wenn sich etwas ändert.
 * Der Qdrant-Check läuft serverseitig im Intervall (kein Client-Polling).
 */
class DashboardService {
    /**
     * @param {object} params
     * @param {Config} params.config
     * @param {Qdrant} [params.qdrant]
     * @param {McpSessionTracker} params.mcpSessions
     * @param {LogService} [params.logService]
     * @param {Logger} [params.logger]
     * @param {number} [params.refreshIntervalMs] - Serverseitiges Qdrant-Refresh-Intervall
     */
    constructor({ config, qdrant, mcpSessions, logService, logger, refreshIntervalMs = 30 * 1000 } = {}) {
        this.label = '[Dashboard]';
        this.logger = logger || { log: () => {}, error: () => {} };
        this.config = config;
        this.qdrant = qdrant;
        this.mcpSessions = mcpSessions;
        this.logService = logService;
        this.refreshIntervalMs = refreshIntervalMs;
        this.listeners = new Set(); // (payload: string) => void
        this.timer = null;
        this._unsubMcp = null;
        this._onQdrantStatus = null;
        this.qdrantStatus = { reachable: false, version: null, points: null, checkedAt: null };
        this.lastSnapshot = null;
    }

    /** Startet: MCP-Changes abonnieren, Qdrant-Status abonnieren, Perioden-Refresh. */
    start() {
        this._unsubMcp = this.mcpSessions.addListener(() => {
            this.refresh().catch((err) => this.logger.error(this.label, `refresh failed: ${err.message}`));
        });

        // Qdrant-Reconnect: bei jedem Verbindungsversuch sofort aktualisieren.
        if (this.qdrant && typeof this.qdrant.on === 'function') {
            this._onQdrantStatus = () => {
                this.refresh({ checkQdrant: true }).catch((err) => this.logger.error(this.label, `refresh failed: ${err.message}`));
            };
            this.qdrant.on('status', this._onQdrantStatus);
        }

        this.refresh({ checkQdrant: true }).catch((err) => this.logger.error(this.label, `initial refresh failed: ${err.message}`));
        this.timer = setInterval(() => {
            this.refresh({ checkQdrant: true }).catch((err) => this.logger.error(this.label, `refresh failed: ${err.message}`));
        }, this.refreshIntervalMs);
        if (this.timer.unref) this.timer.unref();
    }

    /** Stoppt Timer + Listener. */
    stop() {
        this._unsubMcp?.();
        this._unsubMcp = null;
        if (this.qdrant && this._onQdrantStatus && typeof this.qdrant.off === 'function') {
            this.qdrant.off('status', this._onQdrantStatus);
        }
        this._onQdrantStatus = null;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.listeners.clear();
    }

    /**
     * Liest den Qdrant-Status aus dem Qdrant-Service (Reconnect-Loop) und
     * zählt die Punkte, wenn verbunden.
     */
    async checkQdrant() {
        if (!this.qdrant) {
            this.qdrantStatus = { reachable: false, version: null, points: null, checkedAt: null };
            return;
        }
        const st = this.qdrant.getStatus();
        let points = null;
        if (st.connected) {
            try {
                const c = await this.qdrant.client.count(this.qdrant.collection, { exact: true });
                points = c?.count ?? null;
            } catch {
                // Collection existiert ggf. noch nicht → Punkte unbekannt
            }
        }
        this.qdrantStatus = {
            reachable: st.connected,
            version: st.version,
            points,
            checkedAt: st.lastAttemptAt,
            attempts: st.attempts,
            nextAttemptAt: st.nextAttemptAt,
            retryDelaySec: st.retryDelaySec,
            maxRetries: st.maxRetries,
            gaveUp: st.gaveUp,
            error: st.error
        };
    }

    /** Baut den vollständigen Status-Snapshot. */
    buildSnapshot() {
        const mem = process.memoryUsage();
        const logBuffer = this.logService ? this.logService.getHistory() : [];
        const logErrors = logBuffer.filter((l) => l.level === 'ERR').length;
        const mcp = this.config.mcp || {};

        const snap = {
            ts: new Date().toISOString(),
            server: {
                name: 'rag-qdrant-mcp',
                port: this.config.serverPort,
                node: process.version,
                platform: `${process.platform}/${process.arch}`,
                uptimeSec: Math.round(process.uptime()),
                memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
                logLines: logBuffer.length,
                logErrors
            },
            mcp: {
                enabled: !!mcp.enabled,
                path: mcp.path || '/mcp',
                allowedHosts: mcp.allowedHosts || [],
                ...this.mcpSessions.getSnapshot()
            },
            qdrant: {
                url: this.config.qdrant?.url || '',
                port: this.config.qdrant?.port || null,
                collection: this.config.qdrant?.collection || '',
                ...this.qdrantStatus
            },
            embeddings: {
                api: this.config.embeddings?.api || '',
                model: this.config.embeddings?.model || '',
                host: this.config.embeddings?.host || '',
                url: this.config.embeddings?.url || ''
            },
            chat: {
                api: this.config.chat?.api || '',
                model: this.config.chat?.model || '',
                url: this.config.chat?.url || ''
            }
        };
        this.lastSnapshot = snap;
        return snap;
    }

    /** Snapshot bauen + an alle Listener broadcasten. */
    async refresh({ checkQdrant = false } = {}) {
        if (checkQdrant) await this.checkQdrant();
        const snap = this.buildSnapshot();
        const payload = JSON.stringify({ type: 'update', data: snap });
        for (const listener of this.listeners) {
            try {
                listener(payload);
            } catch (err) {
                this.logger.error(this.label, `broadcast failed: ${err.message}`);
            }
        }
    }

    /** Aktueller Snapshot (für neue WS-Clients). */
    getSnapshot() {
        return this.lastSnapshot || this.buildSnapshot();
    }

    /** Listener abonnieren. Gibt eine Unsubscribe-Funktion zurück. */
    addListener(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
}

export { DashboardService };
