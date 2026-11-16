import mysql from 'mysql2/promise';
import { migrate } from './db/migrate.js';

/**
 * Zentrale Database-Klasse (MariaDB).
 *
 * - Einziger Pool-Eigentümer: Models (z. B. `FileStore`) bekommen diese
 *   Instanz und nutzen `db.pool` für ihre Queries.
 * - Zeitstempel: immer UTC (Pool-Config `timezone: 'Z'`, `DATETIME(3)`).
 *
 * Interface (async):
 *   connect() → Promise<void>  (SELECT 1 + Migrations, idempotent)
 *   close()   → Promise<void>  (Pool schließen)
 */
class Database {
    /**
     * @param {object} params
     * @param {object} params.db - `config.db` (host, port, user, password, database, poolSize, connectTimeoutMs, …)
     * @param {Logger} [params.logger]
     */
    constructor({ db, logger } = {}) {
        if (!db || typeof db !== 'object') {
            throw new Error('Database requires a db config object');
        }
        this.label = '[Database]';
        this.logger = logger || { log: () => {}, error: () => {} };
        this.pool = mysql.createPool({
            host: db.host,
            port: db.port,
            user: db.user,
            password: db.password,
            database: db.database,
            waitForConnections: true,
            connectionLimit: db.poolSize,
            queueLimit: 0,
            connectTimeout: db.connectTimeoutMs,
            timezone: 'Z',
            namedPlaceholders: false,
            charset: 'utf8mb4'
        });
    }

    /**
     * Start-Readiness: DB erreichbar + Schema aktuell.
     * Schritt 1: `SELECT 1` (DB erreichbar?).
     * Schritt 2: `migrate(this.pool)` (Schema sicherstellen, idempotent).
     * @returns {Promise<void>}
     */
    async connect() {
        try {
            await this.pool.query('SELECT 1');
            await migrate(this.pool);
        } catch (err) {
            this.logger.error(this.label, 'connect failed', { error: err.message });
            throw err;
        }
    }

    /**
     * Pool schließen (sauberer Shutdown).
     * @returns {Promise<void>}
     */
    async close() {
        try {
            await this.pool.end();
        } catch (err) {
            this.logger.error(this.label, 'close failed', { error: err.message });
            throw err;
        }
    }
}

export { Database };
