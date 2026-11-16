import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Config } from '../Config.js';
import { Logger } from '../Logger.js';
import { Database } from '../Database.js';
import { KNOWN_FIELDS, toDbDatetime, UPSERT_SQL } from '../Models/FileStore.js';

/** Batch-Größe: Zeilen pro Transaktion (Plan 8). */
export const DEFAULT_BATCH_SIZE = 500;

/**
 * Liest `files.json` defensiv.
 * - `files` fehlt / kein Objekt / Array → leeres Objekt.
 * - Datei fehlt oder JSON defekt → null (CLI meldet den Fehler, Exit 1).
 * @param {string} filePath
 * @param {Logger} [logger]
 * @returns {{version: number, files: Record<string, object>} | null}
 */
export function loadFilesJson(filePath, logger) {
    const log = logger || { log: () => {}, error: () => {} };
    if (!existsSync(filePath)) return null;
    try {
        const raw = JSON.parse(readFileSync(filePath, 'utf8'));
        return {
            version: typeof raw?.version === 'number' ? raw.version : 1,
            files: raw?.files && typeof raw.files === 'object' && !Array.isArray(raw.files) ? raw.files : {}
        };
    } catch (err) {
        log.error('[Import]', 'files.json konnte nicht gelesen werden', { error: err.message });
        return null;
    }
}

/**
 * Baut die SQL-Parameter für einen Entry (bekannte Felder → Spalten, Rest → `meta`-JSON).
 * Reihenfolge = Spalten-Reihenfolge in `UPSERT_SQL`.
 * @param {string} relPath
 * @param {object} entry
 * @returns {Array}
 */
export function entryToParams(relPath, entry) {
    const metaJson = {};
    for (const [k, v] of Object.entries(entry)) {
        if (!KNOWN_FIELDS.has(k)) metaJson[k] = v;
    }
    return [
        relPath,
        entry.size ?? null,
        toDbDatetime(entry.mtime),
        toDbDatetime(entry.ctime),
        entry.status ?? 'done',
        entry.lastEvent ?? null,
        toDbDatetime(entry.processedAt),
        toDbDatetime(entry.deletedAt),
        JSON.stringify(metaJson)
    ];
}

/**
 * Importiert die Einträge aus `files.json` in die DB (Plan 8).
 *
 * - Batch-Upsert: `batchSize` Zeilen pro Transaktion (ODKU aus 6.2, `VALUES(col)`-Syntax).
 * - Idempotent: ODKU → wiederholbar, latest-wins (JSON-Eintrag gewinnt).
 * - Ungültige Einträge (kein Objekt / kein Pfad) → `skipped`, nie in die DB.
 * - Batch-Fehler → Rollback, Batch wird als `errors` gezählt, Import fährt mit dem
 *   nächsten Batch fort (Teil-Erfolg statt Totalausfall).
 *
 * @param {object} pool - mysql2/promise-Pool
 * @param {Record<string, object>} files - `files`-Objekt aus `files.json`
 * @param {object} [options]
 * @param {number} [options.batchSize=500]
 * @param {Logger} [options.logger]
 * @returns {Promise<{imported: number, skipped: number, errors: number}>}
 */
export async function importFiles(pool, files, { batchSize = DEFAULT_BATCH_SIZE, logger } = {}) {
    const log = logger || { log: () => {}, error: () => {} };
    let imported = 0;
    let skipped = 0;
    let errors = 0;

    const entries = Object.entries(files || {});
    for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);

        // Validieren + Parameter bauen (ungültige Einträge überspringen).
        const rows = [];
        for (const [key, entry] of batch) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                skipped++;
                continue;
            }
            const relPath = typeof entry.path === 'string' && entry.path ? entry.path : key;
            if (!relPath) {
                skipped++;
                continue;
            }
            rows.push(entryToParams(relPath, entry));
        }
        if (rows.length === 0) continue;

        // Ein Batch = eine Transaktion (ODKU pro Zeile).
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            for (const params of rows) {
                await conn.query(UPSERT_SQL, params);
            }
            await conn.commit();
            imported += rows.length;
        } catch (err) {
            try { await conn.rollback(); } catch { /* ignore */ }
            errors += rows.length;
            log.error('[Import]', `Batch fehlgeschlagen (${rows.length} Einträge)`, { error: err.message });
        } finally {
            conn.release();
        }
    }

    return { imported, skipped, errors };
}

/**
 * CLI: `node src/db/import.js --from <pfad-zu-files.json>`
 *
 * - DB-Verbindung aus Config (`db`-Gruppe).
 * - Migrations laufen vor dem Import (`store.connect()` = SELECT 1 + `migrate()`).
 * - `files.json` bleibt als Backup erhalten (wird NUR gelesen).
 * - Exit-Code: 0 = Erfolg, 1 = Fehler (fehlende/defekte Datei, DB-Fehler, Batch-Fehler).
 */
async function main() {
    const args = process.argv.slice(2);
    const fromIdx = args.indexOf('--from');
    const fromPath = fromIdx !== -1 ? args[fromIdx + 1] : undefined;
    if (!fromPath) {
        console.error('Usage: node src/db/import.js --from <pfad-zu-files.json>');
        process.exit(1);
    }

    const config = new Config();
    const logger = new Logger({ verbose: config.verbose });

    const data = loadFilesJson(fromPath, logger);
    if (data === null) {
        logger.error('[Import]', `files.json nicht lesbar: ${fromPath}`);
        process.exit(1);
    }

    const database = new Database({ db: config.db, logger });
    let exitCode = 0;
    try {
        await database.connect(); // SELECT 1 + Migrations (idempotent)
        const { imported, skipped, errors } = await importFiles(database.pool, data.files, {
            batchSize: DEFAULT_BATCH_SIZE,
            logger
        });
        logger.log('[Import]', `importiert: ${imported}, übersprungen: ${skipped}, fehler: ${errors}`);
        if (errors > 0) exitCode = 1;
    } catch (err) {
        logger.error('[Import]', 'Import fehlgeschlagen', { error: err.message });
        exitCode = 1;
    } finally {
        try { await database.close(); } catch { /* ignore */ }
    }
    process.exit(exitCode);
}

// CLI nur bei direkter Ausführung (nicht bei Import in Tests).
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
    main().catch((err) => {
        console.error('[Import] Unerwarteter Fehler:', err);
        process.exit(1);
    });
}
