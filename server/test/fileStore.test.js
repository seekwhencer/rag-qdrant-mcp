import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake-Pool + Fake-Connection für `mysql2/promise` (via vi.hoisted, damit sie
// vor dem Mock-Factory-Call existieren).
const { fakePool, fakeConn } = vi.hoisted(() => {
    const fakeConn = {
        beginTransaction: vi.fn(),
        query: vi.fn(),
        commit: vi.fn(),
        rollback: vi.fn(),
        release: vi.fn()
    };
    const fakePool = {
        query: vi.fn(),
        getConnection: vi.fn(() => fakeConn),
        end: vi.fn()
    };
    return { fakePool, fakeConn };
});

vi.mock('mysql2/promise', () => ({
    default: {
        createPool: vi.fn(() => fakePool)
    }
}));

import { Database } from '../src/Database.js';
import { FileStore } from '../src/Models/FileStore.js';

const dbConfig = {
    host: '127.0.0.1',
    port: 3306,
    user: 'rag',
    password: 'secret',
    database: 'ragqdrant',
    poolSize: 5,
    connectTimeoutMs: 5000,
    retryDelaySec: 10,
    maxRetries: 0
};

function makeStore() {
    const logger = { log: vi.fn(), error: vi.fn() };
    const database = new Database({ db: dbConfig, logger });
    return new FileStore({ db: database, logger });
}

describe('FileStore', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('upsert passes the correct parameters (INSERT ... ON DUPLICATE KEY UPDATE)', async () => {
        const store = makeStore();
        fakeConn.query
            .mockResolvedValueOnce([[]]) // SELECT ... FOR UPDATE (keine existing-Zeile)
            .mockResolvedValueOnce([{ affectedRows: 1 }]); // INSERT
        await store.upsert('docs/report.pdf', {
            size: 102400,
            mtime: '2026-11-15T22:00:00.000Z',
            ctime: '2026-11-15T21:59:00.000Z',
            status: 'done',
            lastEvent: 'create',
            processedAt: '2026-11-15T22:00:05.000Z'
        });

        // SELECT ... FOR UPDATE zuerst
        expect(fakeConn.query.mock.calls[0][0]).toContain('SELECT * FROM files WHERE path = ? FOR UPDATE');
        expect(fakeConn.query.mock.calls[0][1]).toEqual(['docs/report.pdf']);

        // INSERT mit korrekten Parametern
        // (DATETIME-Spalten: MariaDB-Format `YYYY-MM-DD HH:MM:SS.sss` UTC, keine ISO-8601)
        const [sql, params] = fakeConn.query.mock.calls[1];
        expect(sql).toContain('INSERT INTO files');
        expect(sql).toContain('ON DUPLICATE KEY UPDATE');
        expect(sql).toContain('VALUES(size)');
        expect(params).toEqual([
            'docs/report.pdf',
            102400,
            '2026-11-15 22:00:00.000',
            '2026-11-15 21:59:00.000',
            'done',
            'create',
            '2026-11-15 22:00:05.000',
            null, // deletedAt
            '{}'  // meta-JSON (leer)
        ]);

        // Transaktion: begin + commit
        expect(fakeConn.beginTransaction).toHaveBeenCalledTimes(1);
        expect(fakeConn.commit).toHaveBeenCalledTimes(1);
        expect(fakeConn.release).toHaveBeenCalledTimes(1);
    });

    it('upsert returns the entry with ISO datetimes (Snapshot-Shape bleibt stabil)', async () => {
        const store = makeStore();
        fakeConn.query
            .mockResolvedValueOnce([[]]) // SELECT ... FOR UPDATE (keine existing-Zeile)
            .mockResolvedValueOnce([{ affectedRows: 1 }]); // INSERT
        const entry = await store.upsert('a.txt', {
            mtime: '2026-11-15T22:00:00.000Z',
            ctime: '2026-11-15T21:59:00.000Z',
            processedAt: '2026-11-15T22:00:05.000Z'
        });

        // Entry (API/Snapshot) behält ISO-Strings — nur die SQL-Parameter sind im DB-Format.
        expect(entry.mtime).toBe('2026-11-15T22:00:00.000Z');
        expect(entry.ctime).toBe('2026-11-15T21:59:00.000Z');
        expect(entry.processedAt).toBe('2026-11-15T22:00:05.000Z');
    });

    it('upsert merges into an existing entry (keeps untouched fields, latest-wins)', async () => {
        const store = makeStore();
        const existingRow = {
            id: 1,
            path: 'docs/report.pdf',
            size: 100,
            mtime: new Date('2026-11-15T20:00:00.000Z'),
            ctime: new Date('2026-11-15T19:00:00.000Z'),
            status: 'done',
            last_event: 'create',
            processed_at: new Date('2026-11-15T20:00:05.000Z'),
            deleted_at: null,
            meta: null,
            created_at: new Date('2026-11-15T19:00:00.000Z'),
            updated_at: new Date('2026-11-15T20:00:05.000Z')
        };
        fakeConn.query
            .mockResolvedValueOnce([[existingRow]]) // SELECT ... FOR UPDATE
            .mockResolvedValueOnce([{ affectedRows: 2 }]); // INSERT (update)
        const entry = await store.upsert('docs/report.pdf', { size: 200, lastEvent: 'modify' });

        // latest-wins: size + lastEvent aus meta
        expect(entry.size).toBe(200);
        expect(entry.lastEvent).toBe('modify');
        // unangetastete Felder bleiben (aus existing)
        expect(entry.status).toBe('done');
        expect(entry.mtime).toBe('2026-11-15T20:00:00.000Z');
        expect(entry.ctime).toBe('2026-11-15T19:00:00.000Z');
        expect(entry.processedAt).toBe('2026-11-15T20:00:05.000Z');
        // updatedAt wird neu gesetzt
        expect(entry.updatedAt).toBeTruthy();
    });

    it('maps a row to an entry (DATETIME→ISO, meta-Spreizung, kein id/created_at)', async () => {
        const store = makeStore();
        const row = {
            id: 42,
            path: 'docs/report.pdf',
            size: 102400,
            mtime: new Date('2026-11-15T22:00:00.000Z'),
            ctime: new Date('2026-11-15T21:59:00.000Z'),
            status: 'done',
            last_event: 'create',
            processed_at: new Date('2026-11-15T22:00:05.000Z'),
            deleted_at: null,
            meta: JSON.stringify({ customField: 'value' }),
            created_at: new Date('2026-11-15T21:00:00.000Z'),
            updated_at: new Date('2026-11-15T22:00:05.000Z')
        };
        fakePool.query.mockResolvedValueOnce([[row]]);
        const entry = await store.get('docs/report.pdf');

        // DATETIME → ISO-String (UTC)
        expect(entry.mtime).toBe('2026-11-15T22:00:00.000Z');
        expect(entry.ctime).toBe('2026-11-15T21:59:00.000Z');
        expect(entry.processedAt).toBe('2026-11-15T22:00:05.000Z');
        expect(entry.updatedAt).toBe('2026-11-15T22:00:05.000Z');
        // meta-JSON wird gespreizt
        expect(entry.customField).toBe('value');
        // id / created_at werden NICHT übernommen
        expect(entry.id).toBeUndefined();
        expect(entry.created_at).toBeUndefined();
        expect(entry.createdAt).toBeUndefined();
    });

    it('list() returns all rows (SQL hat ORDER BY path)', async () => {
        const store = makeStore();
        const rows = [
            { id: 1, path: 'a.txt', size: 1, mtime: null, ctime: null, status: 'done', last_event: null, processed_at: null, deleted_at: null, meta: null, created_at: null, updated_at: null },
            { id: 2, path: 'b.txt', size: 2, mtime: null, ctime: null, status: 'done', last_event: null, processed_at: null, deleted_at: null, meta: null, created_at: null, updated_at: null }
        ];
        fakePool.query.mockResolvedValueOnce([[rows[0], rows[1]]]);
        const entries = await store.list();

        expect(entries).toHaveLength(2);
        expect(entries[0].path).toBe('a.txt');
        expect(entries[1].path).toBe('b.txt');
        expect(fakePool.query.mock.calls[0][0]).toContain('ORDER BY path');
    });

    it('get() returns null when no row exists', async () => {
        const store = makeStore();
        fakePool.query.mockResolvedValueOnce([[]]);
        const entry = await store.get('nonexistent.txt');
        expect(entry).toBeNull();
    });
});
