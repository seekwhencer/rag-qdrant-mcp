import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Schema-Version der Store-Datei. */
const VERSION = 1;

/**
 * Struktur-Spiegel ("Datenbank") der verarbeiteten Files.
 *
 * - JSON-Datei `data/files.json` im Data-Ordner (eine Ebene über server/,
 *   AUSSERHALB des storage-Roots, sonst würde der Watcher die eigene DB-Datei
 *   beobachten → Loop). Der Data-Ordner ist per Settings änderbar (dataDir).
 * - Atomares Schreiben: tmp-Datei + rename() (kein halb geschriebenes JSON).
 * - Kein natives Modul (kein better-sqlite3) → Docker-Build bleibt einfach.
 * - Einträge werden NIE gelöscht: ein delete-Event setzt `status: "deleted"`
 *   + `deletedAt` (Tombstone). Es gibt bewusst kein remove().
 *
 * Schema (version 1):
 * {
 *   "version": 1,
 *   "files": {
 *     "docs/report.pdf": {
 *       "path": "docs/report.pdf",
 *       "size": 102400,
 *       "mtime": "2026-11-15T22:00:00.000Z",
 *       "ctime": "2026-11-15T21:59:00.000Z",
 *       "status": "done",
 *       "lastEvent": "modify",
 *       "processedAt": "2026-11-15T22:00:05.000Z",
 *       "updatedAt": "2026-11-15T22:00:05.000Z"
 *     }
 *   }
 * }
 *
 * `status`: done | error | deleted
 */
class FileStore {
    /**
     * @param {object} [params]
     * @param {string} [params.filePath] - Pfad der JSON-Datei (Default: <repo>/data/files.json)
     * @param {Logger} [params.logger]
     */
    constructor({ filePath, logger } = {}) {
        this.label = '[FileStore]';
        this.logger = logger || { log: () => {}, error: () => {} };
        // Default: Data-Ordner eine Ebene über server/ (gleiche Ebene wie frontend/ und server/).
        this.filePath = filePath || join(__dirname, '..', '..', '..', 'data', 'files.json');
        this.data = { version: VERSION, files: {} };
        this.load();
    }

    /**
     * Zeigt auf eine andere Store-Datei (Runtime-Wechsel des Data-Ordners).
     * Lädt die neue Datei defensive (fehlt/defekt → leerer Store).
     * @param {string} newPath - Neuer absoluter Pfad der JSON-Datei
     * @returns {FileStore} this
     */
    setPath(newPath) {
        this.filePath = newPath;
        this.load();
        return this;
    }

    /**
     * Lädt die Store-Datei in den Speicher (defensive: fehlt/defekt → leerer Store).
     * @returns {{version: number, files: Record<string, object>}}
     */
    load() {
        if (!existsSync(this.filePath)) {
            this.data = { version: VERSION, files: {} };
            return this.data;
        }
        try {
            const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
            this.data = {
                version: typeof raw?.version === 'number' ? raw.version : VERSION,
                files: raw?.files && typeof raw.files === 'object' && !Array.isArray(raw.files) ? raw.files : {}
            };
        } catch (err) {
            this.logger.error(this.label, 'files.json konnte nicht gelesen werden', { error: err.message });
            this.data = { version: VERSION, files: {} };
        }
        return this.data;
    }

    /**
     * Schreibt den Store atomar: tmp-Datei + rename().
     */
    save() {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const tmpPath = `${this.filePath}.tmp`;
        try {
            writeFileSync(tmpPath, JSON.stringify(this.data, null, 4), 'utf8');
            renameSync(tmpPath, this.filePath);
        } catch (err) {
            try {
                unlinkSync(tmpPath);
            } catch {
                // tmp-Datei war nie da → nichts zu räumen
            }
            throw err;
        }
    }

    /**
     * Legt einen Eintrag an oder aktualisiert ihn (latest-wins, Merge).
     * Ein delete-Event ruft dies mit `{ status: 'deleted', deletedAt }` auf
     * (Tombstone) — der Eintrag bleibt erhalten.
     * @param {string} relPath - Pfad relativ zum storage-Root (POSIX-Slashes)
     * @param {object} [meta] - size, mtime, ctime, status, lastEvent, processedAt, deletedAt, ...
     * @returns {object} der aktualisierte Eintrag
     */
    upsert(relPath, meta = {}) {
        const now = new Date().toISOString();
        const existing = this.data.files[relPath] || {};
        const entry = {
            path: relPath,
            size: existing.size ?? null,
            mtime: existing.mtime ?? null,
            ctime: existing.ctime ?? null,
            status: existing.status ?? 'done',
            lastEvent: existing.lastEvent ?? null,
            processedAt: existing.processedAt ?? null,
            updatedAt: existing.updatedAt ?? null,
            ...meta,
            path: relPath,
            updatedAt: now
        };
        this.data.files[relPath] = entry;
        this.save();
        return entry;
    }

    /**
     * Alle Einträge (inkl. Tombstones) als Array.
     * @returns {object[]}
     */
    list() {
        return Object.values(this.data.files);
    }

    /**
     * Eintrag nach Pfad (oder null, wenn nicht vorhanden).
     * @param {string} relPath
     * @returns {object | null}
     */
    get(relPath) {
        return this.data.files[relPath] || null;
    }
}

export { FileStore, VERSION };
