import axios from 'axios';
import { EventEmitter } from 'node:events';
import { normalizeUrl } from '../Utils/url.js';
import { noopLogger } from '../Utils/logger.js';

/**
 * Status-Endpunkte der docling-serve-Instanz (siehe data/docling/index.md).
 * Reihenfolge = Anzeige-Reihenfolge im Dashboard.
 */
const STATUS_ENDPOINTS = [
    { key: 'health', path: '/health' },
    { key: 'ready', path: '/ready' },
    { key: 'capabilities', path: '/v1/capabilities' },
    { key: 'version', path: '/version' },
    { key: 'memoryStats', path: '/v1/memory/stats' },
    { key: 'memoryCounts', path: '/v1/memory/counts' }
];

/** Timeout pro Endpunkt-Request (ms). */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Docling service (docling-serve integration).
 *
 * Pollt im Intervall `config.docling.statusPollIntervalSec` die Status-Endpunkte
 * (Health, Readiness, Capabilities, Version, Memory-Stats, Memory-Counts),
 * aggregiert das Ergebnis in `this.status` und feuert ein `status`-Event,
 * damit das Dashboard (DashboardService) live per WebSocket aktualisiert wird.
 *
 * Konfiguration (env > config.json > Default, siehe Config.js):
 *   - DOCLING_URL                    — Basis-URL (leer = Polling deaktiviert)
 *   - DOCLING_API_KEY                — Bearer-Key für die /v1/*-Endpunkte (Secret, nur Env)
 *   - DOCLING_STATUS_POLL_INTERVAL_SEC — Poll-Intervall in Sekunden
 *
 * Erbt von EventEmitter: `status`-Event mit dem aggregierten Status-Objekt.
 */
class DoclingService extends EventEmitter {
    /**
     * @param {object} [params] - Configuration parameters
     * @param {Config} [params.config] - Config-Instanz (docling-Gruppe + change-Events)
     * @param {Logger} [params.logger] - Logger instance
     */
    constructor({ config, logger } = {}) {
        super();
        this.label = '[DoclingService]';
        this.logger = logger || noopLogger();
        this.config = config || null;
        this.timer = null;
        this._polling = false;
        this._onConfigChange = null;
        this.status = this.emptyStatus();
    }

    /** Status-Objekt ohne Konfiguration (keine URL → kein Polling). */
    emptyStatus() {
        return {
            configured: false,
            url: '',
            reachable: false,
            ready: false,
            checkedAt: null,
            pollIntervalSec: null,
            endpoints: {}
        };
    }

    /** Aktuelle docling-Config (leeres Objekt, wenn keine Config injiziert ist). */
    get doclingConfig() {
        return this.config?.docling || {};
    }

    /**
     * Startet das Polling:
     *   1) Config-Changes abonnieren (docling-Gruppe → Polling neu starten)
     *   2) sofort ersten Poll + Intervall-Timer
     */
    start() {
        if (this.config && typeof this.config.on === 'function' && !this._onConfigChange) {
            this._onConfigChange = ({ changed }) => {
                if (Array.isArray(changed) && changed.includes('docling')) {
                    this.logger.log(this.label, 'Docling-Config geändert → Polling neu starten');
                    this.restart();
                }
            };
            this.config.on('change', this._onConfigChange);
        }
        this.restart();
    }

    /** Stoppt Timer + Config-Listener. */
    stop() {
        this.stopTimer();
        if (this.config && typeof this.config.off === 'function' && this._onConfigChange) {
            this.config.off('change', this._onConfigChange);
            this._onConfigChange = null;
        }
    }

    /** Timer stoppen (idempotent). */
    stopTimer() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * Polling (neu) starten: Timer zurücksetzen, ersten Poll ausführen.
     * Ohne konfigurierte URL wird kein Polling gefahren (Status = not configured).
     */
    restart() {
        this.stopTimer();
        const { url, statusPollIntervalSec } = this.doclingConfig;

        if (!url || String(url).trim() === '') {
            this.status = this.emptyStatus();
            this.emit('status', this.status);
            return;
        }

        const intervalSec = Math.max(1, Number(statusPollIntervalSec) || 30);
        this.status = {
            ...this.status,
            configured: true,
            url: normalizeUrl(url),
            pollIntervalSec: intervalSec
        };

        this.poll().catch((err) => this.logger.error(this.label, `poll failed: ${err.message}`));
        this.timer = setInterval(() => {
            this.poll().catch((err) => this.logger.error(this.label, `poll failed: ${err.message}`));
        }, intervalSec * 1000);
        if (this.timer.unref) this.timer.unref();
    }

    /**
     * Fragt alle Status-Endpunkte parallel ab und aggregiert das Ergebnis.
     * Einzelne Fehler schlagen NICHT den ganzen Poll fehl (pro Endpunkt ok/error).
     * @returns {Promise<object>} aggregierter Status
     */
    async poll() {
        if (this._polling) return this.status;
        this._polling = true;
        try {
            const { url, apiKey } = this.doclingConfig;
            const base = normalizeUrl(url);
            const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

            const results = await Promise.allSettled(
                STATUS_ENDPOINTS.map((ep) =>
                    axios
                        .get(`${base}${ep.path}`, { headers, timeout: REQUEST_TIMEOUT_MS })
                        .then((res) => ({ ok: true, httpStatus: res.status, data: res.data }))
                        .catch((err) => ({
                            ok: false,
                            httpStatus: err.response?.status ?? null,
                            error: err.response?.data?.detail || err.message,
                            data: err.response?.data ?? null
                        }))
                )
            );

            const endpoints = {};
            results.forEach((r, i) => {
                const key = STATUS_ENDPOINTS[i].key;
                endpoints[key] = r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.message || 'unknown error' };
            });

            this.status = {
                configured: true,
                url: base,
                reachable: endpoints.health?.ok === true,
                ready: endpoints.ready?.ok === true,
                checkedAt: new Date().toISOString(),
                pollIntervalSec: this.status.pollIntervalSec,
                endpoints
            };
            this.emit('status', this.status);
            return this.status;
        } finally {
            this._polling = false;
        }
    }

    /** Letzter aggregierter Status (für Dashboard-Snapshot). */
    getStatus() {
        return this.status;
    }
}

export { DoclingService, STATUS_ENDPOINTS };
