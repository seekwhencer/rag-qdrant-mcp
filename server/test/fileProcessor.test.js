import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileStore } from '../src/Services/FileStore.js';
import { FileProcessor, DummyProcessor } from '../src/Services/FileProcessor.js';

const dirs = [];

/** Temp-Ordner als storage-Root + echter FileStore mit Temp-Pfad. */
function makeEnv({ dummyDelaySec = 0, maxFileSizeMb = 1024 } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'fileproc-'));
    dirs.push(dir);
    const config = { storage: { root: dir, dummyDelaySec, maxFileSizeMb } };
    const store = new FileStore({ filePath: join(dir, 'data', 'files.json') });
    const logger = { log: vi.fn(), error: vi.fn() };
    return { dir, config, store, logger };
}

function makeJob(path, event) {
    return { id: `job-${path}-${event}`, path, event, status: 'processing' };
}

afterEach(() => {
    vi.useRealTimers();
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('FileProcessor (Strategie-Interface)', () => {
    it('Basis-Processor wirft ohne Implementierung', async () => {
        const { config, store } = makeEnv();
        const processor = new FileProcessor({ config, store });
        await expect(processor.process(makeJob('a.txt', 'create'))).rejects.toThrow('must be implemented');
    });

    it('validiert Config und Store', () => {
        const { config, store } = makeEnv();
        expect(() => new DummyProcessor({ store })).toThrow('config');
        expect(() => new DummyProcessor({ config })).toThrow('store');
    });
});

describe('DummyProcessor', () => {
    it('dummy: wartet dummyDelaySec (aus Config, pro Job gelesen)', async () => {
        vi.useFakeTimers();
        const { dir, config, store } = makeEnv({ dummyDelaySec: 2 });
        const processor = new DummyProcessor({ config, store });
        writeFileSync(join(dir, 'a.txt'), 'hello');

        const promise = processor.process(makeJob('a.txt', 'create'));
        let settled = false;
        promise.then(() => { settled = true; }, () => { settled = true; });

        await vi.advanceTimersByTimeAsync(1999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const result = await promise;
        expect(result.status).toBe('done');

        // pro Job gelesen: Delay ändern → wirkt ab nächstem Job
        config.storage.dummyDelaySec = 0.5;
        writeFileSync(join(dir, 'b.txt'), 'world');
        const p2 = processor.process(makeJob('b.txt', 'create'));
        let settled2 = false;
        p2.then(() => { settled2 = true; }, () => { settled2 = true; });
        await vi.advanceTimersByTimeAsync(499);
        expect(settled2).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await p2;
    });

    it('create: Store-Eintrag mit size/mtime/ctime, status done', async () => {
        const { dir, config, store } = makeEnv();
        const processor = new DummyProcessor({ config, store });
        const abs = join(dir, 'docs', 'a.txt');
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, 'hello world');

        const result = await processor.process(makeJob('docs/a.txt', 'create'));

        expect(result.status).toBe('done');
        const entry = store.get('docs/a.txt');
        expect(entry.status).toBe('done');
        expect(entry.lastEvent).toBe('create');
        expect(entry.size).toBe(11);
        expect(entry.mtime).toBeTruthy();
        expect(entry.ctime).toBeTruthy();
        expect(entry.processedAt).toBeTruthy();
    });

    it('modify: aktualisiert Eintrag (lastEvent modify, neue size)', async () => {
        const { dir, config, store } = makeEnv();
        const processor = new DummyProcessor({ config, store });
        const abs = join(dir, 'a.txt');
        writeFileSync(abs, 'hello');
        await processor.process(makeJob('a.txt', 'create'));

        writeFileSync(abs, 'hello world, more');
        const result = await processor.process(makeJob('a.txt', 'modify'));

        expect(result.status).toBe('done');
        const entry = store.get('a.txt');
        expect(entry.lastEvent).toBe('modify');
        expect(entry.size).toBe(17);
        expect(entry.status).toBe('done');
    });

    it('delete: Tombstone (status deleted + deletedAt), Eintrag bleibt erhalten', async () => {
        const { dir, config, store } = makeEnv();
        const processor = new DummyProcessor({ config, store });
        writeFileSync(join(dir, 'a.txt'), 'hello');
        await processor.process(makeJob('a.txt', 'create'));

        const result = await processor.process(makeJob('a.txt', 'delete'));

        expect(result.status).toBe('deleted');
        const entry = store.get('a.txt');
        expect(entry.status).toBe('deleted');
        expect(entry.deletedAt).toBeTruthy();
        expect(store.list()).toHaveLength(1);
    });

    it('race: File während Processing gelöscht (ENOENT) → wie delete behandeln', async () => {
        const { dir, config, store } = makeEnv();
        const processor = new DummyProcessor({ config, store });
        const abs = join(dir, 'a.txt');
        writeFileSync(abs, 'hello');

        // File wird "während" der (Dummy-)Verarbeitung gelöscht
        const promise = processor.process(makeJob('a.txt', 'create'));
        rmSync(abs);
        const result = await promise;

        expect(result.status).toBe('deleted');
        const entry = store.get('a.txt');
        expect(entry.status).toBe('deleted');
        expect(entry.deletedAt).toBeTruthy();
    });

    it('size-limit: File > maxFileSizeMb → skipped (kein Fehler), loggen', async () => {
        const { dir, config, store, logger } = makeEnv({ maxFileSizeMb: 1 });
        const processor = new DummyProcessor({ config, store, logger });
        writeFileSync(join(dir, 'big.bin'), Buffer.alloc(1024 * 1024 + 1));

        const result = await processor.process(makeJob('big.bin', 'create'));

        expect(result.status).toBe('skipped');
        const entry = store.get('big.bin');
        expect(entry.status).toBe('skipped');
        expect(entry.size).toBe(1024 * 1024 + 1);
        expect(logger.log).toHaveBeenCalled();
    });

    it('size-limit: File genau bei maxFileSizeMb → verarbeitet (nicht skipped)', async () => {
        const { dir, config, store } = makeEnv({ maxFileSizeMb: 1 });
        const processor = new DummyProcessor({ config, store });
        writeFileSync(join(dir, 'exact.bin'), Buffer.alloc(1024 * 1024));

        const result = await processor.process(makeJob('exact.bin', 'create'));

        expect(result.status).toBe('done');
        expect(store.get('exact.bin').status).toBe('done');
    });

    it('abort: Dummy-Wartezeit hört auf AbortSignal (AbortError, kein Store-Update)', async () => {
        vi.useFakeTimers();
        const { dir, config, store } = makeEnv({ dummyDelaySec: 5 });
        const processor = new DummyProcessor({ config, store });
        writeFileSync(join(dir, 'a.txt'), 'hello');

        const controller = new AbortController();
        const promise = processor.process(makeJob('a.txt', 'create'), controller.signal);
        promise.catch(() => {});

        await vi.advanceTimersByTimeAsync(1000);
        controller.abort();

        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(store.list()).toHaveLength(0);
    });

    it('abort: bereits abgebrochenes Signal → sofort AbortError', async () => {
        const { dir, config, store } = makeEnv({ dummyDelaySec: 5 });
        const processor = new DummyProcessor({ config, store });
        writeFileSync(join(dir, 'a.txt'), 'hello');

        const controller = new AbortController();
        controller.abort();

        await expect(processor.process(makeJob('a.txt', 'create'), controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(store.list()).toHaveLength(0);
    });
});
