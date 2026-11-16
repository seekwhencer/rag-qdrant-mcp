import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '../src/db/migrate.js';

// Fake-Pool: simuliert den DB-Zustand.
// - `applied` = Versionen in `schema_migrations` (wird beim INSERT automatisch befüllt).
// - `pool.query` beantwortet `SELECT 1 FROM schema_migrations WHERE version = ?` daraus.
// - `conn` = Transaktions-Connection (beginTransaction/query/commit/rollback/release).
function makeFakePool() {
    const applied = new Set();
    const conn = {
        beginTransaction: vi.fn(),
        query: vi.fn(async (sql, params) => {
            if (/INSERT INTO schema_migrations \(version\) VALUES \(\?\)/.test(sql)) {
                applied.add(params[0]);
            }
            return [{ affectedRows: 1 }];
        }),
        commit: vi.fn(),
        rollback: vi.fn(),
        release: vi.fn()
    };
    const pool = {
        applied,
        query: vi.fn(async (sql, params) => {
            if (/SELECT 1 FROM schema_migrations WHERE version = \?/.test(sql)) {
                const version = params[0];
                return [applied.has(version) ? [{ 1: 1 }] : []];
            }
            return [[]];
        }),
        getConnection: vi.fn(async () => conn),
        end: vi.fn()
    };
    return { pool, conn };
}

const tempDirs = [];
function makeMigrationsDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
    tempDirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
}

describe('migrate()', () => {
    afterEach(() => {
        while (tempDirs.length) {
            fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
        }
    });

    it('creates the schema_migrations table before applying migrations', async () => {
        const { pool } = makeFakePool();
        await migrate(pool);
        expect(pool.query.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
        expect(pool.query.mock.calls[0][0]).toContain('version    VARCHAR(64) NOT NULL PRIMARY KEY');
        expect(pool.query.mock.calls[0][0]).toContain('applied_at DATETIME(3)');
    });

    it('applies 001_init.sql (files table: InnoDB, utf8mb4, uq_files_path)', async () => {
        const { pool, conn } = makeFakePool();
        await migrate(pool);

        const ddl = conn.query.mock.calls.find(([sql]) => sql.includes('CREATE TABLE IF NOT EXISTS files'));
        expect(ddl).toBeDefined();
        expect(ddl[0]).toContain('UNIQUE KEY uq_files_path (path)');
        expect(ddl[0]).toContain('KEY idx_files_status (status)');
        expect(ddl[0]).toContain('KEY idx_files_updated_at (updated_at)');
        expect(ddl[0]).toContain('ENGINE=InnoDB');
        expect(ddl[0]).toContain('utf8mb4');
    });

    it('is idempotent: running twice applies the migration only once', async () => {
        const { pool, conn } = makeFakePool();
        await migrate(pool); // 1. Lauf: 001_init.sql anwenden
        await migrate(pool); // 2. Lauf: 001_init.sql bereits in schema_migrations → skip

        const ddlCalls = conn.query.mock.calls.filter(([sql]) => sql.includes('CREATE TABLE IF NOT EXISTS files'));
        expect(ddlCalls).toHaveLength(1);

        const insertCalls = conn.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO schema_migrations'));
        expect(insertCalls).toHaveLength(1);

        // 2. Lauf: keine Transaktion für die Migration
        expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
        expect(conn.commit).toHaveBeenCalledTimes(1);
        expect(conn.rollback).not.toHaveBeenCalled();
        expect(pool.applied).toContain('001_init.sql');
    });

    it('applies migrations in lexicographic order (= version order)', async () => {
        const dir = makeMigrationsDir({
            '003_c.sql': 'CREATE TABLE c (id INT);',
            '001_a.sql': 'CREATE TABLE a (id INT);',
            '002_b.sql': 'CREATE TABLE b (id INT);'
        });
        const { pool, conn } = makeFakePool();
        await migrate(pool, { migrationsDir: dir });

        const ddlCalls = conn.query.mock.calls
            .filter(([sql]) => /CREATE TABLE [abc] /.test(sql))
            .map(([sql]) => sql.trim());
        expect(ddlCalls).toEqual([
            'CREATE TABLE a (id INT)',
            'CREATE TABLE b (id INT)',
            'CREATE TABLE c (id INT)'
        ]);
        expect([...pool.applied].sort()).toEqual(['001_a.sql', '002_b.sql', '003_c.sql']);
    });

    it('records the applied version in schema_migrations (within the transaction)', async () => {
        const { pool, conn } = makeFakePool();
        await migrate(pool);

        const insertCall = conn.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO schema_migrations'));
        expect(insertCall).toBeDefined();
        expect(insertCall[0]).toContain('INSERT INTO schema_migrations (version) VALUES (?)');
        expect(insertCall[1]).toEqual(['001_init.sql']);
        expect(pool.applied).toContain('001_init.sql');

        // Transaktionsfluss: begin → DDL → INSERT → commit → release
        expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
        expect(conn.commit).toHaveBeenCalledTimes(1);
        expect(conn.release).toHaveBeenCalledTimes(1);
    });

    it('skips already-applied migrations and applies only the new one', async () => {
        const dir = makeMigrationsDir({
            '001_a.sql': 'CREATE TABLE a (id INT);',
            '002_b.sql': 'CREATE TABLE b (id INT);'
        });
        const { pool, conn } = makeFakePool();
        pool.applied.add('001_a.sql'); // 001_a.sql ist bereits angewendet

        await migrate(pool, { migrationsDir: dir });

        const ddlCalls = conn.query.mock.calls
            .filter(([sql]) => /CREATE TABLE [ab] /.test(sql))
            .map(([sql]) => sql.trim());
        expect(ddlCalls).toEqual(['CREATE TABLE b (id INT)']);
        expect(pool.applied).toContain('002_b.sql');
    });

    it('rolls back and throws when a migration statement fails', async () => {
        const dir = makeMigrationsDir({
            '001_bad.sql': 'CREATE TABLE bad (id INT);'
        });
        const { pool, conn } = makeFakePool();
        conn.query.mockRejectedValueOnce(new Error('syntax error'));

        await expect(migrate(pool, { migrationsDir: dir })).rejects.toThrow('Migration 001_bad.sql failed');
        expect(conn.rollback).toHaveBeenCalledTimes(1);
        expect(conn.release).toHaveBeenCalledTimes(1);
        expect(pool.applied).not.toContain('001_bad.sql');
    });
});
