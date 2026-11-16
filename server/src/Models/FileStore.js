/**
 * Entry-Felder, die eigene DB-Spalten haben.
 * Alle übrigen Entry-Felder landen im `meta`-JSON (Fangnetz für arbitrary meta).
 * (Exportiert: `import.js` nutzt dieselbe Spalten-/Meta-Aufteilung.)
 */
export const KNOWN_FIELDS = new Set([
    'path', 'size', 'mtime', 'ctime', 'status',
    'lastEvent', 'processedAt', 'deletedAt', 'updatedAt'
]);

/**
 * DATETIME (Date) → ISO-String (UTC); null/undefined → null.
 * @param {Date | string | null | undefined} value
 * @returns {string | null}
 */
function toIso(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
}

/**
 * ISO-String/Date → MariaDB-DATETIME-Format (UTC, `YYYY-MM-DD HH:MM:SS.sss`).
 * MariaDB akzeptiert KEINE ISO-8601-Strings (`T`/`Z`) für DATETIME-Spalten.
 * null/undefined → null; nicht parsebar → unverändert (mysql2 meldet den Fehler).
 * (Exportiert: `import.js` nutzt dieselbe Konvertierung.)
 * @param {Date | string | null | undefined} value
 * @returns {string | null}
 */
export function toDbDatetime(value) {
    if (value === null || value === undefined) return null;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * DB-Zeile → Entry (Snapshot-Shape, identisch zum JSON-Store).
 * - `meta`-JSON wird in den Entry gespreizt.
 * - `id` / `created_at` werden NICHT übernommen (Snapshot-Shape bleibt stabil).
 * @param {object} row
 * @returns {object}
 */
function rowToEntry(row) {
    const entry = {};
    if (row.meta) {
        let meta;
        try {
            meta = typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta;
        } catch {
            meta = {};
        }
        if (meta && typeof meta === 'object') Object.assign(entry, meta);
    }
    entry.path = row.path;
    entry.size = row.size;
    entry.mtime = toIso(row.mtime);
    entry.ctime = toIso(row.ctime);
    entry.status = row.status;
    entry.lastEvent = row.last_event;
    entry.processedAt = toIso(row.processed_at);
    entry.deletedAt = toIso(row.deleted_at);
    entry.updatedAt = toIso(row.updated_at);
    return entry;
}

/**
 * Upsert mit Merge-Semantik (unberührte Felder bleiben, latest-wins).
 * Read-Modify-Write in einer Transaktion:
 *   SELECT ... FOR UPDATE → Merge in JS → INSERT ... ON DUPLICATE KEY UPDATE.
 * `VALUES(col)` = MariaDB-kompatible Syntax (die MySQL-8-Alias-Syntax
 * `INSERT … AS new` wird von MariaDB NICHT unterstützt — verifiziert auf 11.8).
 * (Exportiert: `import.js` nutzt dieselbe ODKU-Syntax für den Batch-Import.)
 */
export const UPSERT_SQL = `
    INSERT INTO files (path, size, mtime, ctime, status, last_event, processed_at, deleted_at, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
        size = VALUES(size), mtime = VALUES(mtime), ctime = VALUES(ctime),
        status = VALUES(status), last_event = VALUES(last_event),
        processed_at = VALUES(processed_at), deleted_at = VALUES(deleted_at),
        meta = VALUES(meta)
`;

/**
 * Model für die File-Struktur (Tabelle `files`, ersetzt den JSON-Store `files.json`).
 *
 * - Nutzt die zentrale `Database`-Instanz (Pool-Eigentümer) — dieses Model
 *   besitzt KEINEN eigenen Pool und kennt kein connect()/close().
 * - Einträge werden NIE gelöscht: ein delete-Event setzt `status: "deleted"`
 *   + `deletedAt` (Tombstone). Es gibt bewusst kein remove().
 *
 * Store-Interface (async):
 *   upsert(relPath, meta) → Promise<entry>
 *   list()               → Promise<entry[]>
 *   get(relPath)          → Promise<entry | null>
 */
class FileStore {
    /**
     * @param {object} params
     * @param {Database} params.db - zentrale Database-Instanz (eigener Pool)
     * @param {Logger} [params.logger]
     */
    constructor({ db, logger } = {}) {
        if (!db || !db.pool) {
            throw new Error('FileStore requires a Database instance with a pool');
        }
        this.label = '[FileStore]';
        this.logger = logger || { log: () => {}, error: () => {} };
        this.db = db;
    }

    /**
     * Legt einen Eintrag an oder aktualisiert ihn (latest-wins, Merge).
     * Ein delete-Event ruft dies mit `{ status: 'deleted', deletedAt }` auf
     * (Tombstone) — der Eintrag bleibt erhalten.
     * @param {string} relPath - Pfad relativ zum storage-Root (POSIX-Slashes)
     * @param {object} [meta] - size, mtime, ctime, status, lastEvent, processedAt, deletedAt, …
     * @returns {Promise<object>} der aktualisierte Eintrag
     */
    async upsert(relPath, meta = {}) {
        const now = new Date().toISOString();
        let conn;
        try {
            conn = await this.db.pool.getConnection();
            await conn.beginTransaction();
            const [rows] = await conn.query('SELECT * FROM files WHERE path = ? FOR UPDATE', [relPath]);
            const existing = rows.length ? rowToEntry(rows[0]) : {};
            // Merge-Semantik (Plan 6.2): `{ ...existing, ...meta, path, updatedAt: now }`.
            // `...existing` spreizt ALLE Felder (inkl. `meta`-JSON-Felder) — unangetastete
            // Felder bleiben erhalten, `...meta` gewinnt (latest-wins).
            const entry = {
                ...existing,
                size: existing.size ?? null,
                mtime: existing.mtime ?? null,
                ctime: existing.ctime ?? null,
                status: existing.status ?? 'done',
                lastEvent: existing.lastEvent ?? null,
                processedAt: existing.processedAt ?? null,
                deletedAt: existing.deletedAt ?? null,
                updatedAt: existing.updatedAt ?? null,
                ...meta,
                path: relPath,
                updatedAt: now
            };
            const metaJson = {};
            for (const [k, v] of Object.entries(entry)) {
                if (!KNOWN_FIELDS.has(k)) metaJson[k] = v;
            }
            await conn.query(UPSERT_SQL, [
                relPath, entry.size, toDbDatetime(entry.mtime), toDbDatetime(entry.ctime), entry.status,
                entry.lastEvent, toDbDatetime(entry.processedAt), toDbDatetime(entry.deletedAt), JSON.stringify(metaJson)
            ]);
            await conn.commit();
            return entry;
        } catch (err) {
            if (conn) {
                try { await conn.rollback(); } catch { /* ignore */ }
            }
            this.logger.error(this.label, `upsert failed for ${relPath}`, { error: err.message });
            throw err;
        } finally {
            if (conn) conn.release();
        }
    }

    /**
     * Alle Einträge (inkl. Tombstones) als Array, sortiert nach `path`.
     * @returns {Promise<object[]>}
     */
    async list() {
        try {
            const [rows] = await this.db.pool.query('SELECT * FROM files ORDER BY path');
            return rows.map(rowToEntry);
        } catch (err) {
            this.logger.error(this.label, 'list failed', { error: err.message });
            throw err;
        }
    }

    /**
     * Eintrag nach Pfad (oder null, wenn nicht vorhanden).
     * @param {string} relPath
     * @returns {Promise<object | null>}
     */
    async get(relPath) {
        try {
            const [rows] = await this.db.pool.query('SELECT * FROM files WHERE path = ?', [relPath]);
            return rows.length ? rowToEntry(rows[0]) : null;
        } catch (err) {
            this.logger.error(this.label, `get failed for ${relPath}`, { error: err.message });
            throw err;
        }
    }
}

export { FileStore };
