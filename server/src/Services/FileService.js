import { join } from 'node:path';
import { FileStore } from '../Models/FileStore.js';
import { DummyProcessor } from './File/FileProcessor.js';
import { FileQueue } from './File/FileQueue.js';
import { FileWatcher } from './File/FileWatcher.js';
import { broadcastToListeners } from '../Utils/listeners.js';
import { noopLogger } from '../Utils/logger.js';

/**
 * Orchestrator für die Datei-Verwaltung.
 *
 * Verdrahtet Config + Database + FileStore + FileWatcher + FileQueue + FileProcessor
 * und bietet die gleichen Muster wie DashboardService:
 *   start(), stop(), getSnapshot(), refresh(), addListener(fn).
 *
 * - Broadcast-Debounce ~100 ms (chokidar feuert bei Copy/Extract viele Events).
 * - Processing-Events (start/done/error/retry) in das bestehende Log-System
 *   (sichtbar im Logs-Dashboard).
 * - pause(), resume(), abort(), removeJob(id) → delegiert an Queue, danach refresh().
 * - Config-Change auf storage.root → Watcher neu starten (Initial-Scan auf neuem Root).
 * - Config-Change auf dataDir → Store auf neue Store-Datei umstellen (Runtime-Wechsel).
 * - enabled=false → Watcher + Queue stoppen; enabled=true → starten (Initial-Scan).
 *
 * Sub-Komponenten sind injizierbar (Tests); ohne Injection werden Defaults erzeugt.
 */
class FileService {
    /**
     * @param {object} params
     * @param {Config} params.config - Config-Objekt mit `.storage`-Gruppe
     * @param {Logger} [params.logger]
     * @param {Database} params.database - zentrale Database-Instanz (Pool-Eigentümer, wird von `index.js` durchgereicht)
     * @param {FileStore} [params.store] - injizierbar für Tests
     * @param {object} [params.processor] - Strategie: `{ async process(job, signal) → result }`
     * @param {FileQueue} [params.queue] - injizierbar für Tests
     * @param {FileWatcher} [params.watcher] - injizierbar für Tests
     * @param {(config: object) => FileWatcher} [params.watcherFactory] - injizierbar für Tests
     * @param {number} [params.broadcastDebounceMs=100] - Broadcast-Debounce
     */
    constructor({ config, logger, database, store, processor, queue, watcher, watcherFactory, broadcastDebounceMs = 100 } = {}) {
        if (!config || !config.storage) {
            throw new Error('FileService requires a config with a storage group');
        }
        this.label = '[FileService]';
        this.logger = logger || noopLogger();
        this.config = config;
        this.broadcastDebounceMs = broadcastDebounceMs;

        // MariaDB ist der einzige Store (kein Driver-Switch, kein JSON-Fallback):
        // `Database` besitzt den Pool, `FileStore` ist das Model für die Tabelle `files`.
        // Die Instanz kommt von `index.js` (einmalig erzeugt, hier durchgereicht).
        if (!database) {
            throw new Error('FileService requires a Database instance');
        }
        this.database = database;
        this.store = store || new FileStore({ db: this.database, logger: this.logger });
        this.processor = processor || new DummyProcessor({ config, store: this.store, logger: this.logger });
        this.queue = queue || new FileQueue({ config, processor: this.processor, logger: this.logger });

        // Watcher-Factory (injizierbar für Tests; Default erzeugt einen FileWatcher).
        this.watcherFactory = watcherFactory || ((cfg) => new FileWatcher({
            config: cfg,
            handler: (relPath, event) => this.enqueueEvent(relPath, event),
            logger: this.logger
        }));
        this.watcher = watcher || this.watcherFactory(config);

        this.listeners = new Set(); // (payload: string) => void
        this.lastSnapshot = null;
        this._queueHandler = null;
        this._configHandler = null;
        this._broadcastTimer = null;
        this._started = false;
        this._watcherActive = false;
        this._watcherRoot = config.storage.root;

        // DB-Connect-State + Reconnect-Loop (Qdrant-Pattern, Plan 6.4).
        this._storeConnected = false;
        this._storeError = null;
        this._storeAttempts = 0;
        this._storeConsecutiveFailures = 0;
        this._storeGaveUp = false;
        this._storeLastAttemptAt = null;
        this._storeNextAttemptAt = null;
        this._storeReconnectTimer = null;
        this._storeConnecting = false;
        this._storeStopped = false;
    }

    /**
     * Startet: Queue-Changes abonnieren, Watcher starten (wenn aktiviert),
     * DB-Connect mit Reconnect-Loop.
     * DB down → kein Crash: Reconnect-Loop im Hintergrund (Backoff `db.retryDelaySec`,
     * max. `db.maxRetries`; 0 = unbegrenzt), Snapshot meldet `store.connected = false`.
     * @returns {Promise<void>}
     */
    async start() {
        if (this._started) return;
        this._started = true;

        // Reconnect-Loop-Status für den (Neu-)Start zurücksetzen
        // (sonst würde ein `stop()` → `start()`-Zyklus den Loop dauerhaft killen).
        this._storeStopped = false;
        this._storeConsecutiveFailures = 0;
        this._storeGaveUp = false;

        // Config-Change-Event abonnieren (onConfigChange ist idempotent/billig —
        // auf JEDES 'change'-Event reagieren, Filter prüft onConfigChange selbst).
        if (this.config.on) {
            this._configHandler = (payload) => this.onConfigChange(payload).catch((err) => {
                this.logger.error(this.label, `onConfigChange failed: ${err.message}`);
            });
            this.config.on('change', this._configHandler);
        }

        this._queueHandler = ({ type, job }) => this.onQueueChange(type, job);
        this.queue.on('change', this._queueHandler);

        if (this.config.storage.enabled) {
            this.startWatcher();
        }

        // DB-Connect (SELECT 1 + Migrations). Bei Fehlschlag: kein Crash —
        // der Reconnect-Loop läuft im Hintergrund weiter. Bei Erfolg: refresh().
        await this._attemptStoreConnect();
    }

    /**
     * Plant den nächsten DB-Connect-Versuch nach `delayMs` Millisekunden.
     * (Qdrant-Pattern: `_scheduleNext`.)
     * @param {number} delayMs
     */
    _scheduleStoreReconnect(delayMs) {
        if (this._storeStopped) return;
        if (this._storeReconnectTimer) clearTimeout(this._storeReconnectTimer);
        this._storeNextAttemptAt = new Date(Date.now() + delayMs).toISOString();
        this._storeReconnectTimer = setTimeout(() => this._attemptStoreConnect(), delayMs);
        if (this._storeReconnectTimer.unref) this._storeReconnectTimer.unref();
    }

    /**
     * Einmaliger DB-Connect-Versuch (`database.connect()` = SELECT 1 + Migrations).
     * Erfolg → `store.connected = true` + `refresh()` (Frontend holt aktuellen Stand).
     * Fehler → `store.connected = false`, nächsten Versuch planen
     * (Backoff `db.retryDelaySec`, max. `db.maxRetries`; 0 = unbegrenzt).
     * @returns {Promise<void>}
     */
    async _attemptStoreConnect() {
        if (this._storeConnecting) return;
        this._storeConnecting = true;
        try {
            this._storeAttempts += 1;
            this._storeLastAttemptAt = new Date().toISOString();
            this._storeNextAttemptAt = null;
            try {
                await this.database.connect();
                this._storeConnected = true;
                this._storeError = null;
                this._storeConsecutiveFailures = 0;
                this._storeGaveUp = false;
                this.logger.log(this.label, `DB verbunden (Versuch ${this._storeAttempts})`);
                try {
                    await this.refresh();
                } catch (err) {
                    this.logger.error(this.label, `refresh after DB-connect failed: ${err.message}`);
                }
            } catch (err) {
                this._storeConnected = false;
                this._storeError = err?.message || 'unreachable';
                this._storeConsecutiveFailures += 1;
                this.logger.error(this.label, `DB nicht erreichbar (Versuch ${this._storeAttempts}): ${this._storeError}`);

                const db = this.config.db || {};
                const maxRetries = db.maxRetries ?? 0;
                if (maxRetries > 0 && this._storeConsecutiveFailures >= maxRetries) {
                    this._storeGaveUp = true;
                    this.logger.error(this.label, `Max. ${maxRetries} Fehlversuche erreicht – Reconnect gestoppt.`);
                } else {
                    const retryDelaySec = db.retryDelaySec ?? 10;
                    this._scheduleStoreReconnect(retryDelaySec * 1000);
                }
            }
        } finally {
            this._storeConnecting = false;
        }
    }

    /**
     * Stoppt: Watcher + Queue stoppen, Timer + Listener räumen, Store-Pool schließen.
     * @returns {Promise<void>}
     */
    async stop() {
        this._started = false;
        // Reconnect-Loop stoppen (kein hängender Timer nach Shutdown).
        this._storeStopped = true;
        this._storeConnected = false;
        if (this._storeReconnectTimer) {
            clearTimeout(this._storeReconnectTimer);
            this._storeReconnectTimer = null;
        }
        this._storeNextAttemptAt = null;
        if (this._configHandler && this.config.off) {
            this.config.off('change', this._configHandler);
            this._configHandler = null;
        }
        if (this._queueHandler) {
            this.queue.removeListener('change', this._queueHandler);
            this._queueHandler = null;
        }
        this.stopWatcher();
        this.queue.stop();
        if (this._broadcastTimer) {
            clearTimeout(this._broadcastTimer);
            this._broadcastTimer = null;
        }
        this.listeners.clear();
        await this.database.close();
    }

    /**
     * Baut den vollständigen Snapshot.
     * @returns {Promise<object>}
     */
    async buildSnapshot() {
        const st = this.config.storage;
        const stats = this.queue.stats();
        let files = [];
        try {
            files = await this.store.list();
        } catch (err) {
            // DB down → Snapshot trotzdem verfügbar (`store.connected = false`).
            this.logger.error(this.label, `list failed: ${err.message}`);
        }
        const snap = {
            ts: new Date().toISOString(),
            root: st.root,
            dataDir: this.config.dataDir || null,
            enabled: !!st.enabled,
            concurrency: st.concurrency,
            dummyDelaySec: st.dummyDelaySec,
            paused: this.queue.paused,
            store: {
                connected: this._storeConnected
            },
            stats: {
                pending: stats.pending,
                processing: stats.processing,
                done: stats.done,
                error: stats.error,
                cancelled: stats.cancelled,
                files: files.length
            },
            queue: this.queue.list().slice(0, 200),
            files
        };
        this.lastSnapshot = snap;
        return snap;
    }

    /**
     * Snapshot bauen + debounced Broadcast an alle Listener.
     * @returns {Promise<object>} der aktuelle Snapshot
     */
    async refresh() {
        this.lastSnapshot = await this.buildSnapshot();
        this.scheduleBroadcast();
        return this.lastSnapshot;
    }

    /**
     * Debounced Broadcast (~100 ms): mehrere Changes → ein Broadcast.
     */
    scheduleBroadcast() {
        if (this._broadcastTimer) clearTimeout(this._broadcastTimer);
        this._broadcastTimer = setTimeout(async () => {
            this._broadcastTimer = null;
            try {
                const snap = await this.buildSnapshot();
                this.lastSnapshot = snap;
                this.broadcast(snap);
            } catch (err) {
                this.logger.error(this.label, `broadcast failed: ${err.message}`);
            }
        }, this.broadcastDebounceMs);
        if (this._broadcastTimer.unref) this._broadcastTimer.unref();
    }

    /**
     * An alle Listener broadcasten (Fehler pro Listener isoliert).
     * @param {object} snap
     */
    broadcast(snap) {
        const payload = JSON.stringify({ type: 'update', data: snap });
        broadcastToListeners(this.listeners, payload, { logger: this.logger, label: this.label });
    }

    /**
     * Aktueller Snapshot (für neue WS-Clients).
     * @returns {Promise<object>}
     */
    async getSnapshot() {
        return this.lastSnapshot || this.buildSnapshot();
    }

    /**
     * Listener abonnieren. Gibt eine Unsubscribe-Funktion zurück.
     * @param {(payload: string) => void} fn
     * @returns {() => void}
     */
    addListener(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /**
     * Pause: delegiert an Queue, danach refresh().
     * @returns {Promise<void>}
     */
    async pause() {
        this.queue.pause();
        await this.refresh();
    }

    /**
     * Resume: delegiert an Queue, danach refresh().
     * @returns {Promise<void>}
     */
    async resume() {
        this.queue.resume();
        await this.refresh();
    }

    /**
     * Abort: delegiert an Queue, danach refresh().
     * @returns {Promise<void>}
     */
    async abort() {
        this.queue.abort();
        await this.refresh();
    }

    /**
     * Entfernt einen pending-Job. Delegiert an Queue, danach refresh().
     * @param {string} id
     * @returns {Promise<object|null>} der entfernte Job (null, wenn nicht gefunden/nicht pending)
     */
    async removeJob(id) {
        const job = this.queue.remove(id);
        await this.refresh();
        return job;
    }

    /**
     * Wird vom Router nach einer Config-Änderung aufgerufen.
     * - enabled=false → Watcher + Queue stoppen.
     * - enabled=true → starten (Initial-Scan).
     * - root geändert → Watcher neu starten (Initial-Scan auf neuem Root).
     * - dataDir geändert → Store auf neue Store-Datei umstellen (Runtime-Wechsel).
     * @param {{changed?: string[]}} [payload] - Config-Change-Payload
     * @returns {Promise<void>}
     */
    async onConfigChange(payload) {
        // dataDir geändert → Store neu ausrichten (wirkt auch vor start()).
        if (payload?.changed?.includes('dataDir') && this.config.dataDir && typeof this.store.setPath === 'function') {
            const newPath = join(this.config.dataDir, 'files.json');
            this.store.setPath(newPath);
            this.logger.log(this.label, 'Store-Pfad gewechselt', { dataDir: this.config.dataDir, filePath: newPath });
        }

        if (!this._started) {
            await this.refresh();
            return;
        }

        const st = this.config.storage;
        const enabled = !!st.enabled;
        const root = st.root;

        if (!enabled) {
            this.stopWatcher();
            this.queue.stop();
            await this.refresh();
            return;
        }

        if (this._watcherRoot !== root) {
            this.restartWatcher();
        } else if (!this._watcherActive) {
            this.startWatcher();
        }

        await this.refresh();
    }

    /**
     * Startet den Watcher (Initial-Scan).
     */
    startWatcher() {
        if (this._watcherActive) return;
        this.watcher.start();
        this._watcherActive = true;
        this._watcherRoot = this.config.storage.root;
    }

    /**
     * Stoppt den Watcher.
     */
    stopWatcher() {
        if (!this._watcherActive) return;
        this.watcher.stop();
        this._watcherActive = false;
    }

    /**
     * Startet den Watcher neu (neuer Root → neue Instanz).
     */
    restartWatcher() {
        this.stopWatcher();
        this.watcher = this.watcherFactory(this.config);
        this.startWatcher();
    }

    /**
     * Leitet ein Watcher-Event an die Queue weiter.
     * @param {string} relPath
     * @param {'create'|'modify'|'delete'} event
     */
    enqueueEvent(relPath, event) {
        try {
            this.queue.enqueue(relPath, event);
        } catch (err) {
            this.logger.error(this.label, 'Enqueue fehlgeschlagen', { relPath, event, error: err.message });
        }
    }

    /**
     * Behandelt ein Queue-Change-Event: Processing-Events in das Log-System
     * + debounced Broadcast.
     * @param {string} type
     * @param {object} job
     */
    onQueueChange(type, job) {
        if (type === 'start' || type === 'done' || type === 'error' || type === 'retry') {
            this.logger.log(this.label, `Job ${type}`, {
                id: job.id,
                path: job.path,
                event: job.event,
                retries: job.retries,
                error: job.error || undefined
            });
        }
        // Event-Handler (Emitter-Kontext) → refresh() fire-and-forget mit Catch.
        this.refresh().catch((err) => {
            this.logger.error(this.label, `refresh failed: ${err.message}`);
        });
    }
}

export { FileService };
