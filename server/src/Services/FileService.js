import { join } from 'node:path';
import { FileStore } from './FileStore.js';
import { DummyProcessor } from './FileProcessor.js';
import { FileQueue } from './FileQueue.js';
import { FileWatcher } from './FileWatcher.js';

/**
 * Orchestrator für die Datei-Verwaltung.
 *
 * Verdrahtet Config + FileStore + FileWatcher + FileQueue + FileProcessor
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
     * @param {FileStore} [params.store] - injizierbar für Tests
     * @param {object} [params.processor] - Strategie: `{ async process(job, signal) → result }`
     * @param {FileQueue} [params.queue] - injizierbar für Tests
     * @param {FileWatcher} [params.watcher] - injizierbar für Tests
     * @param {(config: object) => FileWatcher} [params.watcherFactory] - injizierbar für Tests
     * @param {number} [params.broadcastDebounceMs=100] - Broadcast-Debounce
     */
    constructor({ config, logger, store, processor, queue, watcher, watcherFactory, broadcastDebounceMs = 100 } = {}) {
        if (!config || !config.storage) {
            throw new Error('FileService requires a config with a storage group');
        }
        this.label = '[FileService]';
        this.logger = logger || { log: () => {}, error: () => {} };
        this.config = config;
        this.broadcastDebounceMs = broadcastDebounceMs;

        // Sub-Komponenten (injizierbar für Tests, sonst Default).
        // Store-Datei liegt im Data-Ordner (config.dataDir, eine Ebene über server/).
        this.store = store || new FileStore({
            filePath: this.config.dataDir ? join(this.config.dataDir, 'files.json') : undefined,
            logger: this.logger
        });
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
    }

    /**
     * Startet: Queue-Changes abonnieren, Watcher starten (wenn aktiviert), Initial-Refresh.
     */
    start() {
        if (this._started) return;
        this._started = true;

        // Config-Change-Event abonnieren (onConfigChange ist idempotent/billig —
        // auf JEDES 'change'-Event reagieren, Filter prüft onConfigChange selbst).
        if (this.config.on) {
            this._configHandler = (payload) => this.onConfigChange(payload);
            this.config.on('change', this._configHandler);
        }

        this._queueHandler = ({ type, job }) => this.onQueueChange(type, job);
        this.queue.on('change', this._queueHandler);

        if (this.config.storage.enabled) {
            this.startWatcher();
        }

        this.refresh();
    }

    /**
     * Stoppt: Watcher + Queue stoppen, Timer + Listener räumen.
     */
    stop() {
        this._started = false;
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
    }

    /**
     * Baut den vollständigen Snapshot.
     * @returns {object}
     */
    buildSnapshot() {
        const st = this.config.storage;
        const stats = this.queue.stats();
        const snap = {
            ts: new Date().toISOString(),
            root: st.root,
            dataDir: this.config.dataDir || null,
            enabled: !!st.enabled,
            concurrency: st.concurrency,
            dummyDelaySec: st.dummyDelaySec,
            paused: this.queue.paused,
            stats: {
                pending: stats.pending,
                processing: stats.processing,
                done: stats.done,
                error: stats.error,
                cancelled: stats.cancelled,
                files: this.store.list().length
            },
            queue: this.queue.list().slice(0, 200),
            files: this.store.list()
        };
        this.lastSnapshot = snap;
        return snap;
    }

    /**
     * Snapshot bauen + debounced Broadcast an alle Listener.
     * @returns {object} der aktuelle Snapshot
     */
    refresh() {
        this.lastSnapshot = this.buildSnapshot();
        this.scheduleBroadcast();
        return this.lastSnapshot;
    }

    /**
     * Debounced Broadcast (~100 ms): mehrere Changes → ein Broadcast.
     */
    scheduleBroadcast() {
        if (this._broadcastTimer) clearTimeout(this._broadcastTimer);
        this._broadcastTimer = setTimeout(() => {
            this._broadcastTimer = null;
            const snap = this.buildSnapshot();
            this.lastSnapshot = snap;
            this.broadcast(snap);
        }, this.broadcastDebounceMs);
        if (this._broadcastTimer.unref) this._broadcastTimer.unref();
    }

    /**
     * An alle Listener broadcasten (Fehler pro Listener isoliert).
     * @param {object} snap
     */
    broadcast(snap) {
        const payload = JSON.stringify({ type: 'update', data: snap });
        for (const listener of this.listeners) {
            try {
                listener(payload);
            } catch (err) {
                this.logger.error(this.label, `broadcast failed: ${err.message}`);
            }
        }
    }

    /**
     * Aktueller Snapshot (für neue WS-Clients).
     * @returns {object}
     */
    getSnapshot() {
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
     */
    pause() {
        this.queue.pause();
        this.refresh();
    }

    /**
     * Resume: delegiert an Queue, danach refresh().
     */
    resume() {
        this.queue.resume();
        this.refresh();
    }

    /**
     * Abort: delegiert an Queue, danach refresh().
     */
    abort() {
        this.queue.abort();
        this.refresh();
    }

    /**
     * Entfernt einen pending-Job. Delegiert an Queue, danach refresh().
     * @param {string} id
     * @returns {object|null} der entfernte Job (null, wenn nicht gefunden/nicht pending)
     */
    removeJob(id) {
        const job = this.queue.remove(id);
        this.refresh();
        return job;
    }

    /**
     * Wird vom Router nach einer Config-Änderung aufgerufen.
     * - enabled=false → Watcher + Queue stoppen.
     * - enabled=true → starten (Initial-Scan).
     * - root geändert → Watcher neu starten (Initial-Scan auf neuem Root).
     * - dataDir geändert → Store auf neue Store-Datei umstellen (Runtime-Wechsel).
     * @param {{changed?: string[]}} [payload] - Config-Change-Payload
     */
    onConfigChange(payload) {
        // dataDir geändert → Store neu ausrichten (wirkt auch vor start()).
        if (payload?.changed?.includes('dataDir') && this.config.dataDir && typeof this.store.setPath === 'function') {
            const newPath = join(this.config.dataDir, 'files.json');
            this.store.setPath(newPath);
            this.logger.log(this.label, 'Store-Pfad gewechselt', { dataDir: this.config.dataDir, filePath: newPath });
        }

        if (!this._started) {
            this.refresh();
            return;
        }

        const st = this.config.storage;
        const enabled = !!st.enabled;
        const root = st.root;

        if (!enabled) {
            this.stopWatcher();
            this.queue.stop();
            this.refresh();
            return;
        }

        if (this._watcherRoot !== root) {
            this.restartWatcher();
        } else if (!this._watcherActive) {
            this.startWatcher();
        }

        this.refresh();
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
        this.refresh();
    }
}

export { FileService };
