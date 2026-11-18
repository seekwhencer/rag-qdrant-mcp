import { EventEmitter } from 'node:events';
import { QdrantClient } from '@qdrant/js-client-rest';
import { sha256Hex, hashToUuid } from '../Utils/hash.js';
import { noopLogger } from '../Utils/logger.js';

/**
 * Qdrant client wrapper for upserting vectors, searching, and managing collections.
 *
 * Owns the connection lifecycle:
 *   - tries to connect on start and after every config change
 *   - retries on failure (wait `retryDelaySec`, up to `maxRetries` consecutive failures)
 *   - exposes a live status (attempts, next attempt, …) for the dashboard
 *   - emits a `status` event on every connection attempt
 */
class QdrantService extends EventEmitter {
    /**
     * @param {object} params - Configuration parameters
     * @param {string} params.url - Qdrant server URL
     * @param {number} [params.port=80] - Qdrant port
     * @param {string} [params.collection='research'] - Collection name
     * @param {number} [params.retryDelaySec=10] - Wait between connection attempts (seconds)
     * @param {number} [params.maxRetries=0] - Max consecutive failed attempts (0 = unlimited)
     * @param {Logger} [params.logger] - Logger instance
     */
    constructor({
        url,
        port = 80,
        collection = 'research',
        retryDelaySec = 10,
        maxRetries = 0,
        logger
    } = {}) {
        super();
        this.label = '[QdrantService]';
        this.logger = logger || noopLogger();

        this.url = url;
        this.port = port;
        this.collection = collection;
        this.retryDelaySec = retryDelaySec;
        this.maxRetries = maxRetries;

        this.client = this._createClient();

        // Live-Status (für das Dashboard).
        this.connected = false;
        this.version = null;
        this.error = null;
        this.attempts = 0;
        this.consecutiveFailures = 0;
        this.gaveUp = false;
        this.lastAttemptAt = null;
        this.nextAttemptAt = null;

        this._timer = null;
        this._connecting = false;
        this._stopped = false;

        this._scheduleNext(0); // sofortiger erster Verbindungsversuch
    }

    /** Erzeugt einen QdrantClient für die aktuelle URL/Port. */
    _createClient() {
        return new QdrantClient({
            url: this.url,
            port: this.port,
            checkCompatibility: false
        });
    }

    /** Plant den nächsten Verbindungsversuch nach `delayMs` Millisekunden. */
    _scheduleNext(delayMs) {
        if (this._stopped) return;
        if (this._timer) clearTimeout(this._timer);
        this.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
        this._timer = setTimeout(() => this._attempt(), delayMs);
        if (this._timer.unref) this._timer.unref();
    }

    /** Einmaliger Verbindungsversuch. Bei Fehler: nächsten planen (wenn erlaubt). */
    async _attempt() {
        if (this._connecting) return;
        this._connecting = true;
        try {
            if (!this.url) {
                // Keine URL konfiguriert → nichts zu verbinden.
                this.connected = false;
                this.version = null;
                this.error = 'no URL configured';
                this.nextAttemptAt = null;
                this._emitStatus();
                return;
            }

            this.attempts += 1;
            this.lastAttemptAt = new Date().toISOString();
            this.nextAttemptAt = null;

            try {
                const info = await this.client.versionInfo();
                this.version = info?.version || null;
                this.connected = true;
                this.error = null;
                this.consecutiveFailures = 0;
                this.gaveUp = false;
                this.logger.log(this.label, `Verbunden (Versuch ${this.attempts}), Version: ${this.version}`);
            } catch (err) {
                this.connected = false;
                this.version = null;
                this.error = err?.cause?.message || err?.message || 'unreachable';
                this.consecutiveFailures += 1;
                this.logger.error(this.label, `Qdrant nicht erreichbar (Versuch ${this.attempts}): ${this.error}`);

                if (this.maxRetries > 0 && this.consecutiveFailures >= this.maxRetries) {
                    this.gaveUp = true;
                    this.logger.error(this.label, `Max. ${this.maxRetries} Fehlversuche erreicht – Reconnect gestoppt.`);
                } else {
                    this._scheduleNext(this.retryDelaySec * 1000);
                }
            }
        } finally {
            this._connecting = false;
        }
        this._emitStatus();
    }

    /** `status`-Event an alle Listener senden. */
    _emitStatus() {
        this.emit('status', this.getStatus());
    }

    /**
     * Aktueller Verbindungs-Status (für das Dashboard).
     * @returns {object}
     */
    getStatus() {
        return {
            connected: this.connected,
            version: this.version,
            error: this.error,
            attempts: this.attempts,
            consecutiveFailures: this.consecutiveFailures,
            gaveUp: this.gaveUp,
            lastAttemptAt: this.lastAttemptAt,
            nextAttemptAt: this.nextAttemptAt,
            retryDelaySec: this.retryDelaySec,
            maxRetries: this.maxRetries
        };
    }

    /**
     * Konfiguration (URL/Port/Collection/Retry) zur Laufzeit ändern und sofort neu verbinden.
     * @param {{url?: string, port?: number, collection?: string, retryDelaySec?: number, maxRetries?: number}} cfg
     */
    updateConfig(cfg = {}) {
        if (cfg.url !== undefined) this.url = cfg.url;
        if (cfg.port !== undefined) this.port = cfg.port;
        if (cfg.collection !== undefined) this.collection = cfg.collection;
        if (cfg.retryDelaySec !== undefined) this.retryDelaySec = cfg.retryDelaySec;
        if (cfg.maxRetries !== undefined) this.maxRetries = cfg.maxRetries;

        this.client = this._createClient();

        // Status zurücksetzen → frischer Start mit der neuen Konfiguration.
        this.connected = false;
        this.version = null;
        this.error = null;
        this.attempts = 0;
        this.consecutiveFailures = 0;
        this.gaveUp = false;
        this.lastAttemptAt = null;

        this._scheduleNext(0); // sofortiger Verbindungsversuch
    }

    /** Erzwingt einen sofortigen Verbindungsversuch (ohne Konfig-Änderung). */
    reconnect() {
        this.gaveUp = false;
        this._scheduleNext(0);
    }

    /** Stoppt den Reconnect-Loop und entfernt alle Listener. */
    stop() {
        this._stopped = true;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this.nextAttemptAt = null;
        this.removeAllListeners();
    }

    /**
     * Upserts a single vector point with text payload into the collection.
     * Auto-creates the collection if it does not exist.
     * @param {number[]} vector - The embedding vector
     * @param {{text: string, source?: string}} meta - Point metadata (path alias = source)
     * @returns {Promise<void>}
     */
    async upsert(vector, { text: chunkText = '', path, source = '' } = {}) {
        const hex = sha256Hex(`${chunkText}\0${source}`);
        // Qdrant requires point IDs to be unsigned integers or UUIDs; a raw hex hash is neither.
        const id = hashToUuid(hex);

        // path ist Alias für source (Kompatibilität mit searchAndReturnChunks)
        const payloadPath = (path ?? source) || '';

        const payload = {
            points: [
                {
                    id,
                    vector: vector,
                    payload: {
                        text: chunkText,
                        path: payloadPath,
                        source: String(source) || ''
                    }
                }
            ]
        };

        try {
            await this.client.upsert(this.collection, payload);
        } catch (err) {
            if (this.isCollectionNotFoundError(err)) {
                await this.ensureCollection(vector);
                await this.client.upsert(this.collection, payload);
                return;
            }
            throw err;
        }
    }

    /**
     * Searches for the most similar vectors to the query vector.
     * @param {number[]} vector - The query embedding vector
     * @param {number} [limit=3] - Maximum number of results
     * @returns {Promise<Array<object>>} Array of matching points with payloads
     */
    async search(vector, limit = 3) {
        try {
            const results = await this.client.query(this.collection, {
                query: vector,
                limit: limit,
                with_payload: true
            });
            return results?.points || [];
        } catch (err) {
            if (this.isCollectionNotFoundError(err)) return [];
            throw err;
        }
    }

    /**
     * Deletes all points in the collection that match the given source path.
     * @param {string} source - Source file path to match
     * @returns {Promise<void>}
     */
    async deleteBySource(source) {
        try {
            await this.client.delete(this.collection, {
                filter: {
                    must: [{ key: 'source', match: { value: source } }]
                }
            });
        } catch (err) {
            if (!this.isCollectionNotFoundError(err)) throw err;
        }
    }

    /**
     * Checks whether an error indicates a missing collection.
     * @param {object} err - The error object
     * @returns {boolean}
     */
    isCollectionNotFoundError(err) {
        return err?.status === 404 || String(err?.message ?? '').toLowerCase().includes('not found');
    }

    /**
     * Creates the collection if it does not already exist.
     * @param {number[]} vector - Embedding vector (used to determine vector size)
     * @returns {Promise<void>}
     */
    async ensureCollection(vector) {
        const { result } = await this.client.collectionExists(this.collection);
        if (result) return;

        let created = false;
        try {
            await this.client.createCollection(this.collection, {
                vectors: { size: vector.length, distance: 'Cosine' }
            });
            created = true;
        } catch (err) {
            const alreadyExists =
                err?.status === 409 ||
                String(err?.message ?? '').toLowerCase().includes('already exists');
            if (!alreadyExists) throw err;
        }

        if (created) {
            this.logger.log(this.label, `Collection '${this.collection}' created (size=${vector.length}, distance=Cosine)`);
        }
    }
}

export { QdrantService };
