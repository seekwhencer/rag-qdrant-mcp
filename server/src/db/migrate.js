import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Entfernt Kommentare und zerlegt eine SQL-Datei in einzelne Statements.
 * Der Pool hat KEIN `multipleStatements`, daher wird jedes Statement
 * einzeln ausgeführt (eine Migration = eine Transaktion).
 * @param {string} sql
 * @returns {string[]}
 */
function splitStatements(sql) {
    const cleaned = sql
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*--.*$/gm, '');
    return cleaned
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

/**
 * Migration-Runner (kein externes Tool — Plan-Abschnitt 7).
 *
 * - Stellt die `schema_migrations`-Tabelle sicher
 *   (`version VARCHAR(64)` PK, `applied_at DATETIME(3)`).
 * - Liest `migrations/*.sql` lexikografisch sortiert (= Versionsreihenfolge).
 * - Pro Datei: `SELECT 1 FROM schema_migrations WHERE version = ?` → fehlt:
 *   in einer Transaktion anwenden + Version eintragen.
 * - Idempotent, sicher bei jedem Server-Start (läuft in `Database.connect()`).
 * - Spätere Schema-Änderungen = neue Datei `002_….sql`. Bestehende Migrations NICHT anfassen.
 *
 * @param {object} pool - mysql2/promise-Pool
 * @param {object} [options]
 * @param {string} [options.migrationsDir] - Verzeichnis mit den *.sql-Dateien
 *   (Default: `server/src/db/migrations`; für Tests injizierbar)
 * @returns {Promise<void>}
 */
export async function migrate(pool, { migrationsDir = DEFAULT_MIGRATIONS_DIR } = {}) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    VARCHAR(64) NOT NULL PRIMARY KEY,
            applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        )
    `);

    const files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

    for (const file of files) {
        const [rows] = await pool.query('SELECT 1 FROM schema_migrations WHERE version = ?', [file]);
        if (rows.length > 0) continue; // bereits angewendet

        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        const statements = splitStatements(sql);

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            for (const stmt of statements) {
                await conn.query(stmt);
            }
            await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
            await conn.commit();
        } catch (err) {
            try { await conn.rollback(); } catch { /* ignore */ }
            throw new Error(`Migration ${file} failed: ${err.message}`);
        } finally {
            conn.release();
        }
    }
}
