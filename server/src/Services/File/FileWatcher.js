import { watch } from 'chokidar';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { toRelPath as toRelPathUtil } from '../../Utils/path.js';
import { matchesAny } from '../../Utils/glob.js';
import { noopLogger } from '../../Utils/logger.js';

/**
 * Beobachtet den storage-Root auf Datei-Änderungen (chokidar) und leitet
 * normalisierte Events an einen injizierten Handler weiter (z. B. FileQueue).
 *
 * - Event-Mapping: add → create, change → modify, unlink → delete.
 *   addDir / unlinkDir → ignorieren (Ordner sind implizit über ihre Files).
 * - Initial-Scan (ignoreInitial: false): alle vorhandenen Files als create
 *   → Selbstheilung nach Neustart.
 * - Pfade relativ zum Root normalisieren (POSIX-Slashes).
 * - Path-Guard: `..` und absolute Pfade (außerhalb des Roots) verwerfen + loggen.
 * - Root fehlt: beim Start anlegen (mkdirSync recursive), sonst klare Fehlermeldung.
 * - stop() → watcher.close().
 * - Handler wird injiziert: (relPath, event) → void (testbar).
 */
class FileWatcher {
    /**
     * @param {object} params
     * @param {object} params.config - Config-Objekt mit `.storage`-Gruppe
     * @param {(relPath: string, event: 'create'|'modify'|'delete') => void} params.handler - injizierter Handler (z. B. Queue)
     * @param {Logger} [params.logger]
     */
    constructor({ config, handler, logger } = {}) {
        if (!config || !config.storage) {
            throw new Error('FileWatcher requires a config with a storage group');
        }
        if (typeof handler !== 'function') {
            throw new Error('FileWatcher requires a handler function (relPath, event) => void');
        }
        this.label = '[FileWatcher]';
        this.logger = logger || noopLogger();
        this.config = config;
        this.handler = handler;
        // Absoluter Root: chokidar emittiert dann absolute Pfade → relative() ist konsistent.
        this.root = resolve(config.storage.root);
        this.ignore = config.storage.ignore;
        this.watcher = null;
        this.readyPromise = null;
    }

    /**
     * Legt den Root-Ordner an (wenn er fehlt) und startet den Watcher.
     * @returns {FileWatcher} this
     */
    start() {
        if (!existsSync(this.root)) {
            try {
                mkdirSync(this.root, { recursive: true });
                this.logger.log(this.label, 'Root-Ordner angelegt', { root: this.root });
            } catch (err) {
                this.logger.error(this.label, 'Root-Ordner konnte nicht angelegt werden', {
                    root: this.root,
                    error: err.message
                });
                throw new Error(`FileWatcher: storage root not creatable: ${this.root}`);
            }
        }

        this.watcher = watch(this.root, {
            ignoreInitial: false,
            followSymlinks: false,
            awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
            ignored: this.ignore
        });

        this.readyPromise = new Promise((resolveReady) => {
            this.watcher.once('ready', () => resolveReady());
        });

        this.watcher
            .on('add', (p) => this.handleEvent('create', p))
            .on('change', (p) => this.handleEvent('modify', p))
            .on('unlink', (p) => this.handleEvent('delete', p))
            .on('error', (err) => this.logger.error(this.label, 'Watcher-Fehler', { error: err.message }));

        this.logger.log(this.label, 'Watcher gestartet', { root: this.root });
        return this;
    }

    /**
     * Promise, das löst, wenn der Initial-Scan fertig ist (ready-Event).
     * @returns {Promise<void>}
     */
    whenReady() {
        return this.readyPromise || Promise.resolve();
    }

    /**
     * Mappt ein chokidar-Event auf ein Queue-Event und leitet es an den Handler.
     * @param {'create'|'modify'|'delete'} event
     * @param {string} fullPath
     */
    handleEvent(event, fullPath) {
        const relPath = this.toRelPath(fullPath);
        if (!relPath) return;
        // Whitelist-Filter: nur Files, die min. ein Pattern erfüllen, werden
        // weitergeleitet (leere Whitelist = kein Filter). Pro Event aus Config
        // gelesen → Settings-Änderung wirkt sofort.
        if (!matchesAny(relPath, this.config.storage.whitelist)) {
            this.logger.log(this.label, 'Event verworfen (Whitelist)', { relPath, event });
            return;
        }
        try {
            this.handler(relPath, event);
        } catch (err) {
            this.logger.error(this.label, 'Handler-Fehler', { relPath, event, error: err.message });
        }
    }

    /**
     * Normalisiert einen Pfad relativ zum Root (POSIX-Slashes).
     * Path-Guard: leer / absolut / `..` (außerhalb des Roots) → null (verworfen + geloggt).
     * @param {string} fullPath
     * @returns {string|null}
     */
    toRelPath(fullPath) {
        const normalized = toRelPathUtil(this.root, fullPath);
        if (normalized === null) {
            this.logger.log(this.label, 'Pfad verworfen (Path-Guard)', { fullPath });
            return null;
        }
        return normalized;
    }

    /**
     * Stoppt den Watcher.
     * @returns {Promise<void>}
     */
    stop() {
        if (this.watcher) {
            const w = this.watcher;
            this.watcher = null;
            return w.close();
        }
        return Promise.resolve();
    }
}

export { FileWatcher };
