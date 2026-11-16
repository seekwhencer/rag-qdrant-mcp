import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../src/Services/FileStore.js';

// renameSync als Spy (Passthrough) → atomares Schreiben ist assertbar.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, renameSync: vi.fn((...args) => actual.renameSync(...args)) };
});

const dirs = [];

function makeStore() {
    const dir = mkdtempSync(join(tmpdir(), 'filestore-'));
    dirs.push(dir);
    const filePath = join(dir, 'data', 'files.json');
    return { dir, filePath, store: new FileStore({ filePath }) };
}

afterEach(() => {
    renameSync.mockClear();
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('FileStore', () => {
    it('starts empty when no files.json exists', () => {
        const { store } = makeStore();
        expect(store.list()).toEqual([]);
        expect(store.get('docs/report.pdf')).toBeNull();
    });

    it('upsert creates an entry with the schema fields and list() returns it', () => {
        const { store } = makeStore();
        const entry = store.upsert('docs/report.pdf', {
            size: 102400,
            mtime: '2026-11-15T22:00:00.000Z',
            ctime: '2026-11-15T21:59:00.000Z',
            status: 'done',
            lastEvent: 'create',
            processedAt: '2026-11-15T22:00:05.000Z'
        });

        expect(entry.path).toBe('docs/report.pdf');
        expect(entry.size).toBe(102400);
        expect(entry.status).toBe('done');
        expect(entry.lastEvent).toBe('create');
        expect(entry.updatedAt).toBeTruthy();

        expect(store.list()).toHaveLength(1);
        expect(store.get('docs/report.pdf')).toEqual(entry);
    });

    it('upsert merges into an existing entry (keeps untouched fields)', () => {
        const { store } = makeStore();
        store.upsert('docs/report.pdf', { size: 100, status: 'done', lastEvent: 'create' });
        const entry = store.upsert('docs/report.pdf', { size: 200, lastEvent: 'modify' });

        expect(entry.size).toBe(200);
        expect(entry.lastEvent).toBe('modify');
        expect(entry.status).toBe('done');
        expect(store.list()).toHaveLength(1);
    });

    it('keeps a tombstone on delete (status deleted + deletedAt, entry never removed)', () => {
        const { store } = makeStore();
        store.upsert('docs/report.pdf', { size: 100, status: 'done', lastEvent: 'create' });
        const deletedAt = '2026-11-15T23:00:00.000Z';
        const entry = store.upsert('docs/report.pdf', { status: 'deleted', deletedAt, lastEvent: 'delete' });

        expect(entry.status).toBe('deleted');
        expect(entry.deletedAt).toBe(deletedAt);
        expect(store.list()).toHaveLength(1);
        expect(store.get('docs/report.pdf').status).toBe('deleted');
    });

    it('saves atomically via tmp file + rename', () => {
        const { filePath, store } = makeStore();
        store.upsert('a/b.txt', { size: 1, status: 'done' });

        expect(renameSync).toHaveBeenCalledTimes(1);
        expect(renameSync).toHaveBeenCalledWith(`${filePath}.tmp`, filePath);
        expect(existsSync(`${filePath}.tmp`)).toBe(false);
        const written = JSON.parse(readFileSync(filePath, 'utf8'));
        expect(written.version).toBe(1);
        expect(written.files['a/b.txt'].size).toBe(1);
    });

    it('keeps the previous file intact when rename fails', () => {
        const { filePath, store } = makeStore();
        store.upsert('keep.txt', { size: 1, status: 'done' });
        const before = readFileSync(filePath, 'utf8');

        renameSync.mockImplementationOnce(() => {
            throw new Error('disk full');
        });
        expect(() => store.save()).toThrow('disk full');
        expect(readFileSync(filePath, 'utf8')).toBe(before);
        expect(existsSync(`${filePath}.tmp`)).toBe(false);
    });

    it('roundtrips through load/save with a fresh instance', () => {
        const { filePath, store } = makeStore();
        store.upsert('docs/report.pdf', { size: 102400, status: 'done', lastEvent: 'create' });
        store.upsert('docs/other.txt', { size: 5, status: 'error', lastEvent: 'modify' });
        store.upsert('docs/gone.txt', { status: 'deleted', deletedAt: '2026-11-15T23:00:00.000Z' });

        const reloaded = new FileStore({ filePath });
        expect(reloaded.list()).toHaveLength(3);
        expect(reloaded.get('docs/report.pdf').size).toBe(102400);
        expect(reloaded.get('docs/other.txt').status).toBe('error');
        expect(reloaded.get('docs/gone.txt').status).toBe('deleted');
    });

    it('falls back to an empty store when files.json is corrupt', () => {
        const dir = mkdtempSync(join(tmpdir(), 'filestore-'));
        dirs.push(dir);
        const filePath = join(dir, 'data', 'files.json');
        mkdirSync(join(dir, 'data'), { recursive: true });
        writeFileSync(filePath, '{ not json', 'utf8');

        const store = new FileStore({ filePath });
        expect(store.list()).toEqual([]);
        expect(store.get('x')).toBeNull();
    });

    it('resolves the default path one level above server (data/files.json)', () => {
        const store = new FileStore();
        expect(store.filePath).toBe(join(__dirname, '..', '..', 'data', 'files.json'));
        expect(store.filePath).not.toContain('storage');
    });

    it('setPath switches to another store file and reloads it', () => {
        const dir = mkdtempSync(join(tmpdir(), 'filestore-'));
        dirs.push(dir);
        const pathA = join(dir, 'a', 'files.json');
        const pathB = join(dir, 'b', 'files.json');
        const store = new FileStore({ filePath: pathA });
        store.upsert('a.txt', { size: 1, status: 'done' });

        store.setPath(pathB);
        expect(store.filePath).toBe(pathB);
        expect(store.list()).toEqual([]);

        store.upsert('b.txt', { size: 2, status: 'done' });
        const writtenB = JSON.parse(readFileSync(pathB, 'utf8'));
        expect(writtenB.files['b.txt'].size).toBe(2);
        const writtenA = JSON.parse(readFileSync(pathA, 'utf8'));
        expect(writtenA.files['a.txt'].size).toBe(1);
    });
});
