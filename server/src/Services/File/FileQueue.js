import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { noopLogger } from '../../Utils/logger.js';

const VALID_EVENTS = ['create', 'modify', 'delete'];

/**
 * In-Memory-Job-Queue mit Dispatcher (einziger Picker).
 *
 * - Dedup: max. 1 Job pro Pfad. Neues Event ersetzt den pending-Job
 *   desselben Pfads (latest-wins). delete ersetzt immer.
 * - Dispatcher: `while (!paused && active < concurrency && queue.length)`
 *   → nächster Job an Worker. concurrency wird pro Tick aus Config gelesen
 *   → Änderung in Settings wirkt sofort.
 * - pause(): Dispatcher stoppt, aktive Jobs laufen zu Ende (graceful).
 * - resume(): Dispatcher läuft weiter.
 * - abort(): alle pending → cancelled, Dispatcher stoppt, aktive Jobs
 *   bekommen AbortSignal (brechen sofort ab).
 * - remove(id): nur pending-Jobs löschbar.
 * - Retry: Job error → falls retries < maxRetries: retries++,
 *   retryAt = now + retryDelaySec, zurück in pending. Dispatcher überspringt
 *   Jobs mit retryAt in der Zukunft. Danach: endgültig error.
 * - Queue-Cap: max. 10.000 Jobs. Overflow → älteste pending-Jobs verwerfen + loggen.
 * - Emittet 'change'-Events (EventEmitter) → FileService broadcastet.
 * - Processor wird injiziert (Strategie-Interface: async process(job, signal) → result).
 */
class FileQueue extends EventEmitter {
    /**
     * @param {object} params
     * @param {object} params.config - Config-Objekt mit `.storage`-Gruppe
     * @param {object} params.processor - Strategie: `{ async process(job, signal) → result }`
     * @param {Logger} [params.logger]
     * @param {number} [params.maxQueueSize=10000] - Queue-Cap
     */
    constructor({ config, processor, logger, maxQueueSize = 10000 } = {}) {
        super();
        if (!config || !config.storage) {
            throw new Error('FileQueue requires a config with a storage group');
        }
        if (!processor || typeof processor.process !== 'function') {
            throw new Error('FileQueue requires a processor with an async process(job, signal) method');
        }
        this.label = '[FileQueue]';
        this.logger = logger || noopLogger();
        this.config = config;
        this.processor = processor;
        this.maxQueueSize = maxQueueSize;

        /** @type {Map<string, object>} id → Job */
        this.jobs = new Map();
        /** @type {string[]} Job-IDs in Enqueue-Reihenfolge (FIFO) */
        this.order = [];
        /** @type {Map<string, string>} path → Job-ID (nur pending/processing) */
        this.byPath = new Map();
        /** Anzahl aktiver (processing) Jobs. */
        this.active = 0;
        this.paused = false;
        this.aborted = false;
        /** @type {Map<string, AbortController>} jobId → Controller */
        this.activeControllers = new Map();
        /** @type {Map<string, NodeJS.Timeout>} jobId → Retry-Timer */
        this.retryTimers = new Map();
    }

    /**
     * Legt einen Job in die Queue (Dedup: latest-wins pro Pfad).
     * @param {string} path - Pfad relativ zum storage-Root
     * @param {'create'|'modify'|'delete'} event
     * @returns {object|null} der neue Job (null, wenn verworfen)
     */
    enqueue(path, event) {
        if (!VALID_EVENTS.includes(event)) {
            throw new Error(`invalid event: ${event}`);
        }
        const existingId = this.byPath.get(path);
        if (existingId) {
            const existing = this.jobs.get(existingId);
            if (existing && existing.status === 'pending') {
                // latest-wins: pending-Job ersetzen
                this.discardJob(existingId);
            } else if (existing && existing.status === 'processing') {
                // aktiver Job verarbeitet den aktuellen Datei-Zustand → Event verwerfen
                this.logger.log(this.label, 'Event verworfen (Job läuft)', { path, event });
                return null;
            }
        }
        const job = this.createJob(path, event);
        this.jobs.set(job.id, job);
        this.order.push(job.id);
        this.byPath.set(path, job.id);
        this.enforceCap();
        this.emitChange('enqueue', job);
        this.dispatch();
        return job;
    }

    /**
     * Dispatcher (einziger Picker): holt so lange Jobs, wie Kapazität da ist.
     * concurrency wird pro Tick aus Config gelesen → Änderung wirkt sofort.
     */
    dispatch() {
        if (this.aborted || this.paused) return;
        const concurrency = this.config.storage.concurrency;
        while (this.active < concurrency && !this.paused && !this.aborted) {
            const job = this.nextPendingJob();
            if (!job) break;
            this.startJob(job);
        }
    }

    /**
     * Nächstes pending-Job (FIFO), dessen retryAt fällig ist.
     * @returns {object|null}
     */
    nextPendingJob() {
        const now = Date.now();
        for (const id of this.order) {
            const job = this.jobs.get(id);
            if (!job) continue;
            if (job.status !== 'pending') continue;
            if (job.retryAt && job.retryAt > now) continue;
            return job;
        }
        return null;
    }

    /**
     * Startet einen Job (gibt ihn an den Processor).
     * @param {object} job
     */
    startJob(job) {
        job.status = 'processing';
        job.startedAt = new Date().toISOString();
        this.active++;
        const controller = new AbortController();
        this.activeControllers.set(job.id, controller);
        this.emitChange('start', job);
        Promise.resolve()
            .then(() => this.processor.process(job, controller.signal))
            .then((result) => {
                job.result = result;
                this.finishJob(job, 'done');
            })
            .catch((err) => {
                this.handleJobError(job, err, controller);
            })
            .finally(() => {
                this.active--;
                this.activeControllers.delete(job.id);
                this.dispatch();
            });
    }

    /**
     * Beendet einen Job im Terminal-Zustand (done/error/cancelled).
     * @param {object} job
     * @param {'done'|'error'|'cancelled'} status
     * @param {string|null} [error]
     */
    finishJob(job, status, error = null) {
        job.status = status;
        job.finishedAt = new Date().toISOString();
        if (error) job.error = error;
        if (this.byPath.get(job.path) === job.id) {
            this.byPath.delete(job.path);
        }
        this.emitChange(status, job);
        this.dispatch();
    }

    /**
     * Behandelt einen Job-Fehler: Abort → cancelled, sonst Retry oder endgültig error.
     * @param {object} job
     * @param {Error} err
     * @param {AbortController} controller
     */
    handleJobError(job, err, controller) {
        if (controller?.signal.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
            this.finishJob(job, 'cancelled', err.message || 'aborted');
            return;
        }
        const maxRetries = this.config.storage.maxRetries;
        if (job.retries < maxRetries) {
            job.retries++;
            job.retryAt = Date.now() + this.config.storage.retryDelaySec * 1000;
            job.status = 'pending';
            job.error = err.message;
            this.emitChange('retry', job);
            this.scheduleRetry(job);
        } else {
            this.finishJob(job, 'error', err.message);
        }
    }

    /**
     * Plant einen Retry-Timer: nach retryDelaySec erneut dispatchen.
     * @param {object} job
     */
    scheduleRetry(job) {
        const delay = Math.max(0, job.retryAt - Date.now());
        const timer = setTimeout(() => {
            this.retryTimers.delete(job.id);
            this.dispatch();
        }, delay);
        if (timer.unref) timer.unref();
        this.retryTimers.set(job.id, timer);
    }

    /**
     * Pause: Dispatcher stoppt, aktive Jobs laufen zu Ende (graceful).
     */
    pause() {
        this.paused = true;
        this.logger.log(this.label, 'Queue pausiert');
    }

    /**
     * Resume: Dispatcher läuft weiter.
     */
    resume() {
        this.paused = false;
        this.aborted = false;
        this.logger.log(this.label, 'Queue fortgesetzt');
        this.dispatch();
    }

    /**
     * Abort: alle pending → cancelled, Dispatcher stoppt, aktive Jobs via AbortSignal.
     */
    abort() {
        this.aborted = true;
        this.paused = true;
        for (const job of this.jobs.values()) {
            if (job.status === 'pending') {
                job.status = 'cancelled';
                job.finishedAt = new Date().toISOString();
                job.error = 'aborted';
                if (this.byPath.get(job.path) === job.id) {
                    this.byPath.delete(job.path);
                }
                const timer = this.retryTimers.get(job.id);
                if (timer) {
                    clearTimeout(timer);
                    this.retryTimers.delete(job.id);
                }
                this.emitChange('cancel', job);
            }
        }
        for (const controller of this.activeControllers.values()) {
            controller.abort();
        }
        this.logger.log(this.label, 'Queue abgebrochen');
    }

    /**
     * Entfernt einen pending-Job.
     * @param {string} id
     * @returns {object|null} der entfernte Job (null, wenn nicht gefunden/nicht pending)
     */
    remove(id) {
        const job = this.jobs.get(id);
        if (!job) return null;
        if (job.status !== 'pending') {
            this.logger.log(this.label, 'Kann Job nicht entfernen (nicht pending)', { id, status: job.status });
            return null;
        }
        this.discardJob(id);
        this.emitChange('remove', job);
        return job;
    }

    /**
     * Verwirft einen Job (aus Queue, byPath, Retry-Timer).
     * @param {string} id
     */
    discardJob(id) {
        const job = this.jobs.get(id);
        if (!job) return;
        const timer = this.retryTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.retryTimers.delete(id);
        }
        if (this.byPath.get(job.path) === id) {
            this.byPath.delete(job.path);
        }
        this.jobs.delete(id);
        const idx = this.order.indexOf(id);
        if (idx !== -1) this.order.splice(idx, 1);
    }

    /**
     * Erzwingt das Queue-Cap: älteste pending-Jobs verwerfen + loggen.
     */
    enforceCap() {
        while (this.jobs.size > this.maxQueueSize) {
            let victimId = null;
            for (const id of this.order) {
                const job = this.jobs.get(id);
                if (job && job.status === 'pending') {
                    victimId = id;
                    break;
                }
            }
            if (!victimId) victimId = this.order[0];
            if (!victimId) break;
            this.discardJob(victimId);
            this.logger.log(this.label, 'Job verworfen (Queue-Cap)', { id: victimId });
        }
    }

    /**
     * Räumt auf: Timer stoppen, aktive Jobs abbrechen.
     */
    stop() {
        this.paused = true;
        this.aborted = true;
        for (const timer of this.retryTimers.values()) {
            clearTimeout(timer);
        }
        this.retryTimers.clear();
        for (const controller of this.activeControllers.values()) {
            controller.abort();
        }
    }

    /**
     * Alle Jobs, neueste zuerst.
     * @returns {object[]}
     */
    list() {
        return [...this.order].reverse().map((id) => this.jobs.get(id)).filter(Boolean);
    }

    /**
     * Job nach ID (oder null).
     * @param {string} id
     * @returns {object|null}
     */
    get(id) {
        return this.jobs.get(id) || null;
    }

    /**
     * Status-Zählungen.
     * @returns {{pending: number, processing: number, done: number, error: number, cancelled: number}}
     */
    stats() {
        const s = { pending: 0, processing: 0, done: 0, error: 0, cancelled: 0 };
        for (const job of this.jobs.values()) {
            if (s[job.status] !== undefined) s[job.status]++;
        }
        return s;
    }

    /**
     * Erzeugt ein neues Job-Objekt.
     * @param {string} path
     * @param {string} event
     * @returns {object}
     */
    createJob(path, event) {
        return {
            id: randomUUID(),
            path,
            event,
            status: 'pending',
            enqueuedAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            retries: 0,
            retryAt: null,
            error: null,
            result: null
        };
    }

    /**
     * Emittiert ein Change-Event.
     * @param {string} type
     * @param {object} job
     */
    emitChange(type, job) {
        this.emit('change', { type, job });
    }
}

export { FileQueue };
