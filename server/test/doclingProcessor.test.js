import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const axiosMock = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('axios', () => ({ default: axiosMock }));

import { DoclingProcessor } from '../src/Services/File/DoclingProcessor.js';

const dirs = [];

/** In-Memory-Fake-Store mit async Store-Interface (Merge-Semantik, latest-wins). */
function makeFakeStore() {
    const entries = new Map();
    return {
        async upsert(relPath, meta = {}) {
            const existing = entries.get(relPath) || {};
            const entry = { ...existing, ...meta, path: relPath, updatedAt: new Date().toISOString() };
            entries.set(relPath, entry);
            return entry;
        },
        async list() {
            return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
        },
        async get(relPath) {
            return entries.get(relPath) || null;
        },
        async close() {}
    };
}

/** Temp-Ordner als storage-Root + Fakes (embeddings/qdrant/store/logger). */
function makeEnv({ maxFileSizeMb = 1024 } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'doclingproc-'));
    dirs.push(dir);
    const config = {
        storage: { root: dir, maxFileSizeMb },
        docling: {
            url: 'http://docling:5001',
            apiKey: 'dk-test',
            timeoutSec: 300,
            maxTokens: 512,
            useMarkdownTables: true,
            useMarkdownImages: false,
            ocr: true
        }
    };
    const store = makeFakeStore();
    const embeddings = { embed: vi.fn().mockResolvedValue([0.1, 0.2]) };
    const qdrant = {
        upsert: vi.fn().mockResolvedValue(undefined),
        deleteBySource: vi.fn().mockResolvedValue(undefined)
    };
    const logger = { log: vi.fn(), error: vi.fn() };
    return { dir, config, store, embeddings, qdrant, logger };
}

function makeJob(path, event) {
    return { id: `job-${path}-${event}`, path, event, status: 'processing' };
}

beforeEach(() => {
    axiosMock.post.mockReset();
});

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('DoclingProcessor', () => {
    it('validiert embeddings und qdrant im Konstruktor', () => {
        const { config, store } = makeEnv();
        expect(() => new DoclingProcessor({ config, store })).toThrow('embeddings');
        expect(() => new DoclingProcessor({ config, store, embeddings: { embed: vi.fn() } })).toThrow('qdrant');
        expect(() => new DoclingProcessor({ config, store, embeddings: { embed: vi.fn() }, qdrant: {} })).toThrow('qdrant');
    });

    it('create: Happy Path (chunk → embed → upsert, Store done + chunkCount)', async () => {
        const { dir, config, store, embeddings, qdrant } = makeEnv();
        writeFileSync(join(dir, 'a.pdf'), 'pdf-content');
        axiosMock.post.mockResolvedValue({ data: { chunks: [
            { text: 'chunk1', headings: ['H1'], page_numbers: [1], chunk_index: 0, captions: [] },
            { text: 'chunk2', headings: ['H2'], page_numbers: [2], chunk_index: 1, captions: ['c'] }
        ] } });

        const processor = new DoclingProcessor({ config, store, embeddings, qdrant });
        const result = await processor.process(makeJob('a.pdf', 'create'));

        expect(result.status).toBe('done');
        expect(axiosMock.post).toHaveBeenCalledTimes(1);
        const [url, , cfg] = axiosMock.post.mock.calls[0];
        expect(url).toBe('http://docling:5001/v1/chunk/hybrid/file');
        expect(cfg.headers['X-Api-Key']).toBe('dk-test');
        expect(embeddings.embed).toHaveBeenCalledTimes(2);
        expect(embeddings.embed).toHaveBeenNthCalledWith(1, 'chunk1');
        expect(embeddings.embed).toHaveBeenNthCalledWith(2, 'chunk2');
        expect(qdrant.upsert).toHaveBeenCalledTimes(2);
        expect(qdrant.upsert).toHaveBeenNthCalledWith(1, [0.1, 0.2], {
            text: 'chunk1', path: 'a.pdf', source: 'a.pdf',
            headings: ['H1'], page_numbers: [1], chunk_index: 0, captions: []
        });
        expect(qdrant.upsert).toHaveBeenNthCalledWith(2, [0.1, 0.2], {
            text: 'chunk2', path: 'a.pdf', source: 'a.pdf',
            headings: ['H2'], page_numbers: [2], chunk_index: 1, captions: ['c']
        });
        const entry = await store.get('a.pdf');
        expect(entry.status).toBe('done');
        expect(entry.chunkCount).toBe(2);
    });

    it('modify: Orphan-Schutz (deleteBySource vor den upserts)', async () => {
        const { dir, config, store, embeddings, qdrant } = makeEnv();
        writeFileSync(join(dir, 'a.pdf'), 'pdf-content');
        axiosMock.post.mockResolvedValue({ data: { chunks: [{ text: 'chunk1' }] } });

        const processor = new DoclingProcessor({ config, store, embeddings, qdrant });
        await processor.process(makeJob('a.pdf', 'modify'));

        expect(qdrant.deleteBySource).toHaveBeenCalledTimes(1);
        expect(qdrant.deleteBySource).toHaveBeenCalledWith('a.pdf');
        expect(qdrant.deleteBySource.mock.invocationCallOrder[0]).toBeLessThan(qdrant.upsert.mock.invocationCallOrder[0]);
    });

    it('delete: Chunks entfernen + Tombstone', async () => {
        const { config, store, qdrant } = makeEnv();
        const processor = new DoclingProcessor({ config, store, embeddings: { embed: vi.fn() }, qdrant });
        const result = await processor.process(makeJob('a.pdf', 'delete'));

        expect(result.status).toBe('deleted');
        expect(qdrant.deleteBySource).toHaveBeenCalledWith('a.pdf');
        const entry = await store.get('a.pdf');
        expect(entry.status).toBe('deleted');
        expect(entry.deletedAt).toBeTruthy();
    });

    it('ENOENT-Race: Datei weg → wie delete behandeln', async () => {
        const { dir, config, store, qdrant } = makeEnv();
        const abs = join(dir, 'a.pdf');
        writeFileSync(abs, 'content');
        const processor = new DoclingProcessor({ config, store, embeddings: { embed: vi.fn() }, qdrant });
        rmSync(abs);
        const result = await processor.process(makeJob('a.pdf', 'create'));

        expect(result.status).toBe('deleted');
        expect(qdrant.deleteBySource).toHaveBeenCalledWith('a.pdf');
        const entry = await store.get('a.pdf');
        expect(entry.status).toBe('deleted');
    });

    it('Size-Limit: > maxFileSizeMb → skipped (kein docling-Call)', async () => {
        const { dir, config, store, qdrant } = makeEnv({ maxFileSizeMb: 1 });
        writeFileSync(join(dir, 'big.bin'), Buffer.alloc(1024 * 1024 + 1));
        const processor = new DoclingProcessor({ config, store, embeddings: { embed: vi.fn() }, qdrant });
        const result = await processor.process(makeJob('big.bin', 'create'));

        expect(result.status).toBe('skipped');
        expect(axiosMock.post).not.toHaveBeenCalled();
        expect(qdrant.upsert).not.toHaveBeenCalled();
        const entry = await store.get('big.bin');
        expect(entry.status).toBe('skipped');
    });

    it('docling 500: process() rejectet (retrybar, kein noRetry)', async () => {
        const { dir, config, store, embeddings, qdrant } = makeEnv();
        writeFileSync(join(dir, 'a.pdf'), 'content');
        axiosMock.post.mockRejectedValue(Object.assign(new Error('Internal Server Error'), { response: { status: 500 } }));

        const processor = new DoclingProcessor({ config, store, embeddings, qdrant });
        const err = await processor.process(makeJob('a.pdf', 'create')).catch((e) => e);
        expect(err.response.status).toBe(500);
        expect(err.noRetry).toBeUndefined();
    });

    it('docling 422: process() rejectet + noRetry', async () => {
        const { dir, config, store, embeddings, qdrant } = makeEnv();
        writeFileSync(join(dir, 'a.pdf'), 'content');
        axiosMock.post.mockRejectedValue(Object.assign(new Error('Unprocessable Entity'), { response: { status: 422 } }));

        const processor = new DoclingProcessor({ config, store, embeddings, qdrant });
        await expect(processor.process(makeJob('a.pdf', 'create'))).rejects.toMatchObject({ noRetry: true });
    });

    it('Abort: abgebrochenes Signal → AbortError + Signal an axios übergeben', async () => {
        const { dir, config, store, embeddings, qdrant } = makeEnv();
        writeFileSync(join(dir, 'a.pdf'), 'content');
        axiosMock.post.mockResolvedValue({ data: { chunks: [{ text: 'chunk1' }] } });

        const processor = new DoclingProcessor({ config, store, embeddings, qdrant });
        const controller = new AbortController();
        controller.abort();
        await expect(processor.process(makeJob('a.pdf', 'create'), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        const [, , cfg] = axiosMock.post.mock.calls[0];
        expect(cfg.signal).toBe(controller.signal);
    });

    it('0 Chunks: done, chunkCount 0, kein embed/upsert', async () => {
        const { dir, config, store, embeddings, qdrant } = makeEnv();
        writeFileSync(join(dir, 'empty.pdf'), 'content');
        axiosMock.post.mockResolvedValue({ data: { chunks: [] } });

        const processor = new DoclingProcessor({ config, store, embeddings, qdrant });
        const result = await processor.process(makeJob('empty.pdf', 'create'));

        expect(result.status).toBe('done');
        expect(embeddings.embed).not.toHaveBeenCalled();
        expect(qdrant.upsert).not.toHaveBeenCalled();
        const entry = await store.get('empty.pdf');
        expect(entry.chunkCount).toBe(0);
    });
});
