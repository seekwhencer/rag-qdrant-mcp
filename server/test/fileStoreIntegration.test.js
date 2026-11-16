import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { GenericContainer, Wait } from 'testcontainers';
import { Database } from '../src/Database.js';
import { FileStore } from '../src/Models/FileStore.js';

/**
 * Integration-Tests gegen eine ECHTE MariaDB (Plan-Abschnitt 12.2, Option A).
 *
 * - `testcontainers` startet pro Test-Run einen isolierten `mariadb:11`-Container
 *   (eigene Ports, eigenes Volume) — berührt die Dev-Umgebung NICHT.
 * - Läuft nur, wenn der Docker-Daemon erreichbar ist; sonst wird der gesamte
 *   Block sauber übersprungen (kein Failure bei fehlender DB-Umgebung).
 *
 * Abdeckung:
 *   1. connect() + Migration (001_init.sql angewendet, schema_migrations-Eintrag)
 *   2. Upsert-Roundtrip (Merge-Semantik, Row→Entry-Mapping)
 *   3. Tombstone (status='deleted' + deleted_at, Zeile bleibt erhalten)
 *   4. Reconnect nach pool.end() (close() → neuer connect() funktioniert)
 */

// Docker-Daemon erreichbar? (CLI + Daemon). Synchron, damit describe.skipIf es
// bei der Test-Sammlung auswerten kann.
function dockerAvailable() {
    try {
        execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore', timeout: 10000 });
        return true;
    } catch {
        return false;
    }
}

const DOCKER_OK = dockerAvailable();

const DB_ENV = {
    MARIADB_ROOT_PASSWORD: 'testroot',
    MARIADB_DATABASE: 'ragqdrant',
    MARIADB_USER: 'rag',
    MARIADB_PASSWORD: 'ragtest'
};

function dbConfig(port) {
    return {
        host: '127.0.0.1',
        port,
        user: 'rag',
        password: 'ragtest',
        database: 'ragqdrant',
        poolSize: 5,
        connectTimeoutMs: 5000
    };
}

const silentLogger = { log: () => {}, error: () => {} };

describe.skipIf(!DOCKER_OK)('FileStore Integration (echte MariaDB via testcontainers)', () => {
    let container;
    let database;
    let store;
    let port;

    beforeAll(async () => {
        container = await new GenericContainer('mariadb:11')
            .withExposedPorts(3306)
            .withEnvironment(DB_ENV)
            .withWaitStrategy(Wait.forListeningPorts())
            .withStartupTimeout(120000)
            .start();
        port = container.getMappedPort(3306);
        database = new Database({ db: dbConfig(port), logger: silentLogger });
        store = new FileStore({ db: database, logger: silentLogger });

        // Retry: Der DB-User kann kurz nach Port-Öffnung noch angelegt werden
        // (mariadb-Entrypoint). connect() ist idempotent (SELECT 1 + migrate).
        const t0 = Date.now();
        let lastErr;
        while (Date.now() - t0 < 60000) {
            try {
                await database.connect();
                return;
            } catch (e) {
                lastErr = e;
                await new Promise((r) => setTimeout(r, 1000));
            }
        }
        throw lastErr || new Error('database.connect() retry timeout');
    }, 180000);

    afterAll(async () => {
        if (database) { try { await database.close(); } catch { /* bereits geschlossen */ } }
        if (container) { try { await container.stop(); } catch { /* ignore */ } }
    }, 30000);

    it('connect() + Migration: 001_init.sql angewendet, schema_migrations-Eintrag vorhanden', async () => {
        const [tables] = await database.pool.query(
            "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('files','schema_migrations') ORDER BY TABLE_NAME",
            ['ragqdrant']
        );
        expect(tables.map((t) => t.TABLE_NAME)).toEqual(['files', 'schema_migrations']);

        const [cols] = await database.pool.query(
            'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
            ['ragqdrant', 'files']
        );
        const names = cols.map((c) => c.COLUMN_NAME);
        for (const col of ['id', 'path', 'size', 'mtime', 'ctime', 'status', 'last_event', 'processed_at', 'deleted_at', 'meta', 'created_at', 'updated_at']) {
            expect(names).toContain(col);
        }

        const [migs] = await database.pool.query('SELECT version FROM schema_migrations ORDER BY version');
        expect(migs.map((m) => m.version)).toContain('001_init.sql');
    });

    it('Upsert-Roundtrip: Merge-Semantik + Row→Entry-Mapping', async () => {
        const e1 = await store.upsert('int/a.txt', {
            size: 100,
            mtime: '2026-11-16T10:00:00.000Z',
            ctime: '2026-11-16T09:00:00.000Z',
            status: 'done',
            lastEvent: 'create',
            processedAt: '2026-11-16T10:00:05.000Z',
            customField: 'hello'
        });
        expect(e1.path).toBe('int/a.txt');
        expect(e1.size).toBe(100);
        expect(e1.mtime).toBe('2026-11-16T10:00:00.000Z');
        expect(e1.customField).toBe('hello');

        // Read-back via get(): Row→Entry-Mapping (DATETIME→ISO, meta-Spreizung, kein id/created_at)
        const got = await store.get('int/a.txt');
        expect(got.size).toBe(100);
        expect(got.mtime).toBe('2026-11-16T10:00:00.000Z');
        expect(got.ctime).toBe('2026-11-16T09:00:00.000Z');
        expect(got.status).toBe('done');
        expect(got.lastEvent).toBe('create');
        expect(got.processedAt).toBe('2026-11-16T10:00:05.000Z');
        expect(got.customField).toBe('hello');
        expect(got.id).toBeUndefined();
        expect(got.created_at).toBeUndefined();

        // Merge: nur size + lastEvent ändern, unangetastete Felder bleiben
        const e2 = await store.upsert('int/a.txt', { size: 200, lastEvent: 'modify' });
        expect(e2.size).toBe(200);
        expect(e2.lastEvent).toBe('modify');
        expect(e2.mtime).toBe('2026-11-16T10:00:00.000Z'); // unverändert
        expect(e2.status).toBe('done'); // unverändert
        expect(e2.customField).toBe('hello'); // meta bleibt erhalten

        const got2 = await store.get('int/a.txt');
        expect(got2.size).toBe(200);
        expect(got2.lastEvent).toBe('modify');
        expect(got2.mtime).toBe('2026-11-16T10:00:00.000Z');
        expect(got2.customField).toBe('hello');
    });

    it('Tombstone: status=deleted + deleted_at, Zeile bleibt erhalten', async () => {
        await store.upsert('int/b.txt', { size: 10, status: 'done' });
        const del = await store.upsert('int/b.txt', { status: 'deleted', deletedAt: '2026-11-16T12:00:00.000Z' });
        expect(del.status).toBe('deleted');
        expect(del.deletedAt).toBe('2026-11-16T12:00:00.000Z');

        const got = await store.get('int/b.txt');
        expect(got.status).toBe('deleted');
        expect(got.deletedAt).toBe('2026-11-16T12:00:00.000Z');
        expect(got.size).toBe(10); // Zeile NICHT gelöscht

        const list = await store.list();
        expect(list.some((e) => e.path === 'int/b.txt')).toBe(true);
    });

    it('Reconnect nach pool.end(): close() → neuer connect() funktioniert, Daten bleiben', async () => {
        await database.close();
        // Alter Store: Pool geschlossen → Queries schlagen fehl
        await expect(store.list()).rejects.toThrow();

        // Neue Database-Instanz (neuer Pool) + Model gegen denselben Container
        const database2 = new Database({ db: dbConfig(port), logger: silentLogger });
        const store2 = new FileStore({ db: database2, logger: silentLogger });
        await database2.connect();
        const got = await store2.get('int/a.txt');
        expect(got).not.toBeNull();
        expect(got.size).toBe(200);
        expect(got.lastEvent).toBe('modify');
        await database2.close();
    });
});
