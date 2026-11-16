import { statSync } from 'node:fs';
import { join } from 'node:path';
import { waitFor } from '../../Utils/async.js';
import { noopLogger } from '../../Utils/logger.js';

/**
 * Strategie-Interface für die Datei-Verarbeitung.
 *
 * - `async process(job, signal) → result`
 * - job: `{ id, path, event: 'create'|'modify'|'delete', ... }` (Pfad relativ zum storage-Root)
 * - signal: AbortSignal (Queue-Abort bricht die Verarbeitung ab)
 * - result: `{ status: 'done'|'skipped'|'deleted', path, event, size, entry }`
 *
 * Später: hier echte Verarbeitung einhängen (Chunking → Embeddings → Qdrant),
 * Interface bleibt gleich.
 */
class FileProcessor {
    /**
     * @param {object} params
     * @param {object} params.config - Config-Objekt mit `.storage`-Gruppe
     * @param {object} params.store - FileStore (upsert)
     * @param {Logger} [params.logger]
     */
    constructor({ config, store, logger } = {}) {
        if (!config || !config.storage) {
            throw new Error('FileProcessor requires a config with a storage group');
        }
        if (!store || typeof store.upsert !== 'function') {
            throw new Error('FileProcessor requires a store with an upsert method');
        }
        this.label = '[FileProcessor]';
        this.logger = logger || noopLogger();
        this.config = config;
        this.store = store;
    }

    /**
     * Verarbeitet einen Job. Muss von einer Strategie implementiert werden.
     * @param {object} job
     * @param {AbortSignal} [signal]
     * @returns {Promise<object>}
     */
    async process(job, signal) {
        throw new Error('FileProcessor.process() must be implemented by a strategy');
    }

    /**
     * Absoluter Pfad eines Jobs (storage-Root + relativer Pfad).
     * @param {object} job
     * @returns {string}
     */
    resolvePath(job) {
        return join(this.config.storage.root, job.path);
    }

    /**
     * Setzt ein Tombstone (delete-Event / ENOENT-Race).
     * @param {object} job
     * @returns {Promise<object>} der Store-Eintrag
     */
    async markDeleted(job) {
        return this.store.upsert(job.path, {
            status: 'deleted',
            deletedAt: new Date().toISOString(),
            lastEvent: 'delete'
        });
    }
}

/**
 * Dummy-Verarbeitung: wartet `dummyDelaySec` (aus Config, pro Job gelesen),
 * dann Store-Update.
 *
 * - create/modify → Store.upsert(path, meta) (size, mtime, ctime via statSync)
 * - delete → Store.upsert(path, { status: 'deleted', deletedAt }) (Tombstone)
 * - Race: File während Processing gelöscht → statSync ENOENT → wie delete behandeln
 * - Size-Limit: File > maxFileSizeMb → skipped (kein Fehler), loggen
 * - Abort: Dummy-Wartezeit hört auf AbortSignal
 */
class DummyProcessor extends FileProcessor {
    /**
     * @param {object} job
     * @param {AbortSignal} [signal]
     * @returns {Promise<object>}
     */
    async process(job, signal) {
        const delaySec = this.config.storage.dummyDelaySec ?? 0;
        await waitFor(delaySec * 1000, signal);

        if (job.event === 'delete') {
            const entry = await this.markDeleted(job);
            this.logger.log(this.label, 'Tombstone gesetzt (delete)', { path: job.path });
            return { status: 'deleted', path: job.path, event: job.event, size: null, entry };
        }

        let stats;
        try {
            stats = statSync(this.resolvePath(job));
        } catch (err) {
            if (err.code === 'ENOENT') {
                // Race: File während Processing gelöscht → wie delete behandeln
                const entry = await this.markDeleted(job);
                this.logger.log(this.label, 'File während Processing gelöscht (ENOENT) → Tombstone', { path: job.path });
                return { status: 'deleted', path: job.path, event: job.event, size: null, entry };
            }
            throw err;
        }

        const maxBytes = (this.config.storage.maxFileSizeMb ?? Infinity) * 1024 * 1024;
        if (stats.size > maxBytes) {
            const entry = await this.store.upsert(job.path, {
                size: stats.size,
                mtime: stats.mtime.toISOString(),
                ctime: stats.ctime.toISOString(),
                status: 'skipped',
                lastEvent: job.event
            });
            this.logger.log(this.label, 'File übersprungen (zu groß)', {
                path: job.path,
                size: stats.size,
                maxFileSizeMb: this.config.storage.maxFileSizeMb
            });
            return { status: 'skipped', path: job.path, event: job.event, size: stats.size, entry };
        }

        const entry = await this.store.upsert(job.path, {
            size: stats.size,
            mtime: stats.mtime.toISOString(),
            ctime: stats.ctime.toISOString(),
            status: 'done',
            lastEvent: job.event,
            processedAt: new Date().toISOString()
        });
        this.logger.log(this.label, 'File verarbeitet (Dummy)', { path: job.path, event: job.event, size: stats.size });
        return { status: 'done', path: job.path, event: job.event, size: stats.size, entry };
    }
}

export { FileProcessor, DummyProcessor };
