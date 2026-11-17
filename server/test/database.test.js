import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake-Pool für `mysql2/promise` + `migrate`-Mock (via vi.hoisted, damit sie
// vor dem Mock-Factory-Call existieren).
const { fakePool, migrateMock } = vi.hoisted(() => {
    const fakePool = {
        query: vi.fn(),
        end: vi.fn()
    };
    const migrateMock = vi.fn();
    return { fakePool, migrateMock };
});

vi.mock('mysql2/promise', () => ({
    default: {
        createPool: vi.fn(() => fakePool)
    }
}));

vi.mock('../src/db/migrate.js', () => ({
    migrate: migrateMock
}));

import mysql from 'mysql2/promise';
import { Database } from '../src/Database.js';

const db = {
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

const silentLogger = { log: vi.fn(), error: vi.fn() };

describe('Database', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('erzeugt den Pool mit der db-Config (UTC, utf8mb4)', () => {
        new Database({ db, logger: silentLogger });
        expect(mysql.createPool).toHaveBeenCalledWith(expect.objectContaining({
            host: '127.0.0.1',
            port: 3306,
            user: 'rag',
            password: 'secret',
            database: 'ragqdrant',
            connectionLimit: 5,
            connectTimeout: 5000,
            timezone: 'Z',
            charset: 'utf8mb4'
        }));
    });

    it('validiert die db-Config', () => {
        expect(() => new Database({})).toThrow(/db config/);
        expect(() => new Database({ db: null })).toThrow(/db config/);
    });

    it('connect() führt SELECT 1 + migrate(pool) aus', async () => {
        fakePool.query.mockResolvedValueOnce([[1]]);
        migrateMock.mockResolvedValueOnce(undefined);
        const database = new Database({ db, logger: silentLogger });
        await database.connect();

        expect(fakePool.query).toHaveBeenCalledTimes(1);
        expect(fakePool.query.mock.calls[0][0]).toContain('SELECT 1');
        expect(migrateMock).toHaveBeenCalledTimes(1);
        expect(migrateMock).toHaveBeenCalledWith(fakePool);
    });

    it('connect() wirft bei DB-Fehler weiter (und loggt)', async () => {
        fakePool.query.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        const database = new Database({ db, logger: silentLogger });
        await expect(database.connect()).rejects.toThrow('ECONNREFUSED');
        expect(migrateMock).not.toHaveBeenCalled();
        expect(silentLogger.error).toHaveBeenCalled();
    });

    it('close() ruft pool.end() auf', async () => {
        fakePool.end.mockResolvedValueOnce(undefined);
        const database = new Database({ db, logger: silentLogger });
        await database.close();
        expect(fakePool.end).toHaveBeenCalledTimes(1);
    });

    it('close() wirft bei Pool-Fehler weiter (und loggt)', async () => {
        fakePool.end.mockRejectedValueOnce(new Error('pool error'));
        const database = new Database({ db, logger: silentLogger });
        await expect(database.close()).rejects.toThrow('pool error');
        expect(silentLogger.error).toHaveBeenCalled();
    });

    it('getStatus() meldet initial nicht erreichbar', () => {
        const database = new Database({ db, logger: silentLogger });
        expect(database.getStatus()).toEqual({
            reachable: false,
            error: null,
            lastAttemptAt: null
        });
    });

    it('getStatus() meldet nach connect() erreichbar + Zeitstempel', async () => {
        fakePool.query.mockResolvedValueOnce([[1]]);
        migrateMock.mockResolvedValueOnce(undefined);
        const database = new Database({ db, logger: silentLogger });
        await database.connect();
        const st = database.getStatus();
        expect(st.reachable).toBe(true);
        expect(st.error).toBeNull();
        expect(st.lastAttemptAt).toBeTruthy();
    });

    it('getStatus() meldet nach fehlgeschlagenem connect() nicht erreichbar + Fehler', async () => {
        fakePool.query.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        const database = new Database({ db, logger: silentLogger });
        await database.connect().catch(() => {});
        const st = database.getStatus();
        expect(st.reachable).toBe(false);
        expect(st.error).toBe('ECONNREFUSED');
    });

    it('getStatus() meldet nach close() nicht erreichbar', async () => {
        fakePool.query.mockResolvedValueOnce([[1]]);
        migrateMock.mockResolvedValueOnce(undefined);
        fakePool.end.mockResolvedValueOnce(undefined);
        const database = new Database({ db, logger: silentLogger });
        await database.connect();
        await database.close();
        expect(database.getStatus().reachable).toBe(false);
    });
});
