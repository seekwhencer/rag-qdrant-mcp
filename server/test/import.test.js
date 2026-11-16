import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `import.js` importiert `Database` (CLI-Pool) → `mysql2/promise` mocken,
// damit der Test ohne echte DB-Library läuft (Pattern: fileStore.test.js).
vi.mock('mysql2/promise', () => ({
    default: {
        createPool: vi.fn(() => ({}))
    }
}));

import { importFiles, entryToParams, loadFilesJson, DEFAULT_BATCH_SIZE } from '../src/db/import.js';

// Fake-Pool + Fake-Connection (Transaktions-API wie in migrate.test.js).
function makeFakePool() {
    const conn = {
        beginTransaction: vi.fn(),
        query: vi.fn(async () => [{ affectedRows: 1 }]),
        commit: vi.fn(),
        rollback: vi.fn(),
        release: vi.fn()
    };
    const pool = {
        query: vi.fn(async () => [[]]),
        getConnection: vi.fn(async () => conn),
        end: vi.fn()
    };
    return { pool, conn };
}

function makeFiles(n) {
    const files = {};
    for (let i = 0; i < n; i++) {
        files[`file-${i}.txt`] = {
            path: `file-${i}.txt`,
            size: i,
            mtime: '2026-11-15T22:00:00.000Z',
            ctime: '2026-11-15T21:59:00.000Z',
            status: 'done',
            lastEvent: 'create',
            processedAt: '2026-11-15T22:00:05.000Z',
            updatedAt: '2026-11-15T22:00:05.000Z'
        };
    }
    return files;
}

describe('importFiles()', () => {
    it('groups entries into batches of batchSize (1200 → 500/500/200)', async () => {
        const { pool, conn } = makeFakePool();
        const files = makeFiles(1200);
        const result = await importFiles(pool, files, { batchSize: 500 });

        expect(conn.beginTransaction).toHaveBeenCalledTimes(3);
        expect(conn.commit).toHaveBeenCalledTimes(3);
        expect(conn.rollback).not.toHaveBeenCalled();
        expect(conn.query).toHaveBeenCalledTimes(1200);
        expect(conn.release).toHaveBeenCalledTimes(3);
        expect(result).toEqual({ imported: 1200, skipped: 0, errors: 0 });
    });

    it('uses the ODKU upsert (idempotent, latest-wins) and re-runs cleanly', async () => {
        const { pool, conn } = makeFakePool();
        const files = makeFiles(10);

        const r1 = await importFiles(pool, files, { batchSize: 500 });
        const r2 = await importFiles(pool, files, { batchSize: 500 });

        expect(r1).toEqual({ imported: 10, skipped: 0, errors: 0 });
        expect(r2).toEqual({ imported: 10, skipped: 0, errors: 0 });
        // ODKU-Syntax (MariaDB-kompatibel, `VALUES(col)` — keine MySQL-8-Alias-Syntax)
        expect(conn.query.mock.calls[0][0]).toContain('INSERT INTO files');
        expect(conn.query.mock.calls[0][0]).toContain('ON DUPLICATE KEY UPDATE');
        expect(conn.query.mock.calls[0][0]).toContain('VALUES(size)');
        expect(conn.query.mock.calls[0][0]).not.toContain('AS new');
    });

    it('counts a failed batch as errors, rolls back, and continues with the next batch', async () => {
        const { pool, conn } = makeFakePool();
        const files = makeFiles(1200); // 3 Batches: 500 / 500 / 200

        let call = 0;
        conn.query.mockImplementation(async () => {
            call++;
            if (call === 501) throw new Error('db error'); // 1. Query des 2. Batches
            return [{ affectedRows: 1 }];
        });

        const logger = { log: vi.fn(), error: vi.fn() };
        const result = await importFiles(pool, files, { batchSize: 500, logger });

        // Batch 1 (500) committed, Batch 2 (500) rolled back, Batch 3 (200) committed.
        expect(result.imported).toBe(700);
        expect(result.errors).toBe(500);
        expect(result.skipped).toBe(0);
        expect(conn.commit).toHaveBeenCalledTimes(2);
        expect(conn.rollback).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalled();
    });

    it('skips malformed entries (not objects / no usable path) without touching the DB', async () => {
        const { pool, conn } = makeFakePool();
        const files = {
            'good.txt': { path: 'good.txt', size: 1 },
            'bad-string': 'not an object',
            'bad-null': null,
            'bad-array': [1, 2, 3]
        };
        const result = await importFiles(pool, files, { batchSize: 500 });

        expect(result).toEqual({ imported: 1, skipped: 3, errors: 0 });
        expect(conn.query).toHaveBeenCalledTimes(1);
        expect(conn.commit).toHaveBeenCalledTimes(1);
    });

    it('falls back to the map key when entry.path is missing', async () => {
        const { pool, conn } = makeFakePool();
        const files = { 'fallback.txt': { size: 5 } }; // kein `path`-Feld
        const result = await importFiles(pool, files, { batchSize: 500 });

        expect(result).toEqual({ imported: 1, skipped: 0, errors: 0 });
        expect(conn.query.mock.calls[0][1][0]).toBe('fallback.txt');
    });

    it('handles an empty files object (0 entries, no transaction)', async () => {
        const { pool, conn } = makeFakePool();
        const result = await importFiles(pool, {}, { batchSize: 500 });
        expect(result).toEqual({ imported: 0, skipped: 0, errors: 0 });
        expect(conn.beginTransaction).not.toHaveBeenCalled();
        expect(conn.query).not.toHaveBeenCalled();
    });
});

describe('entryToParams()', () => {
    it('maps known fields to columns (DATETIME → MariaDB-Format) and rest to meta-JSON', () => {
        const params = entryToParams('docs/report.pdf', {
            path: 'docs/report.pdf',
            size: 102400,
            mtime: '2026-11-15T22:00:00.000Z',
            ctime: '2026-11-15T21:59:00.000Z',
            status: 'done',
            lastEvent: 'create',
            processedAt: '2026-11-15T22:00:05.000Z',
            updatedAt: '2026-11-15T22:00:05.000Z',
            customField: 'value'
        });
        expect(params).toEqual([
            'docs/report.pdf',
            102400,
            '2026-11-15 22:00:00.000',
            '2026-11-15 21:59:00.000',
            'done',
            'create',
            '2026-11-15 22:00:05.000',
            null, // deletedAt
            JSON.stringify({ customField: 'value' })
        ]);
    });

    it('defaults missing known fields (status → done, datetimes → null)', () => {
        const params = entryToParams('a.txt', { path: 'a.txt' });
        expect(params).toEqual([
            'a.txt',
            null, // size
            null, // mtime
            null, // ctime
            'done', // status
            null, // lastEvent
            null, // processedAt
            null, // deletedAt
            '{}' // meta-JSON (leer)
        ]);
    });
});

describe('loadFilesJson()', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-test-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns null for a missing file', () => {
        expect(loadFilesJson('/nonexistent/files.json')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
        const file = path.join(dir, 'files.json');
        fs.writeFileSync(file, '{ not valid json');
        expect(loadFilesJson(file)).toBeNull();
    });

    it('defensively normalizes the structure (missing/malformed files → {})', () => {
        const noFiles = path.join(dir, 'no-files.json');
        fs.writeFileSync(noFiles, JSON.stringify({ version: 1 }));
        expect(loadFilesJson(noFiles)).toEqual({ version: 1, files: {} });

        const arrayFiles = path.join(dir, 'array-files.json');
        fs.writeFileSync(arrayFiles, JSON.stringify({ version: 1, files: [1, 2] }));
        expect(loadFilesJson(arrayFiles)).toEqual({ version: 1, files: {} });

        const good = path.join(dir, 'good.json');
        fs.writeFileSync(good, JSON.stringify({ version: 1, files: { 'a.txt': { path: 'a.txt' } } }));
        expect(loadFilesJson(good)).toEqual({ version: 1, files: { 'a.txt': { path: 'a.txt' } } });
    });
});

describe('DEFAULT_BATCH_SIZE', () => {
    it('is 500 (Plan 8)', () => {
        expect(DEFAULT_BATCH_SIZE).toBe(500);
    });
});
