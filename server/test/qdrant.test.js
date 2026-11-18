import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

const clientMock = vi.hoisted(() => ({
    versionInfo: vi.fn(),
    upsert: vi.fn(),
    query: vi.fn(),
    delete: vi.fn(),
    collectionExists: vi.fn(),
    createCollection: vi.fn(),
    getCollections: vi.fn(),
    getCollection: vi.fn()
}));

vi.mock('@qdrant/js-client-rest', () => ({
    QdrantClient: vi.fn().mockImplementation(() => clientMock)
}));

import { QdrantService } from '../src/Services/QdrantService.js';

describe('Qdrant', () => {
    beforeEach(() => {
        clientMock.versionInfo.mockReset().mockResolvedValue({ version: '1.12.0' });
        clientMock.upsert.mockReset().mockResolvedValue(undefined);
        clientMock.query.mockReset().mockResolvedValue({ points: [] });
        clientMock.delete.mockReset().mockResolvedValue(undefined);
        clientMock.collectionExists.mockReset().mockResolvedValue({ result: true });
        clientMock.createCollection.mockReset().mockResolvedValue(undefined);
        clientMock.getCollections.mockReset().mockResolvedValue({ collections: [] });
        clientMock.getCollection.mockReset().mockResolvedValue({});
    });

    it('upsert sends a deterministic id and a full payload', async () => {
        const q = new QdrantService({ url: 'http://q', port: 80, collection: 'research' });
        await q.upsert([0.1, 0.2], { text: 'hello', path: 'a.md', source: 'a.md' });

        expect(clientMock.upsert).toHaveBeenCalledTimes(1);
        const [collection, payload] = clientMock.upsert.mock.calls[0];
        expect(collection).toBe('research');

        const point = payload.points[0];
        const hex = createHash('sha256').update('hello\0a.md').digest('hex');
        const expectedId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
        expect(point.id).toBe(expectedId);
        expect(point.vector).toEqual([0.1, 0.2]);
        expect(point.payload).toEqual({
            text: 'hello',
            path: 'a.md',
            source: 'a.md'
        });
    });

    it('upsert auto-creates the collection on a not-found error, then upserts', async () => {
        clientMock.upsert
            .mockRejectedValueOnce({ status: 404, message: 'Collection not found' })
            .mockResolvedValueOnce(undefined);
        clientMock.collectionExists.mockResolvedValue({ result: false });

        const q = new QdrantService({ url: 'http://q', collection: 'research' });
        await q.upsert([0.1], { text: 'x', source: 'x.md' });

        expect(clientMock.collectionExists).toHaveBeenCalledTimes(1);
        expect(clientMock.createCollection).toHaveBeenCalledWith('research', {
            vectors: { size: 1, distance: 'Cosine' }
        });
        expect(clientMock.upsert).toHaveBeenCalledTimes(2);
    });

    it('search returns the matching points', async () => {
        clientMock.query.mockResolvedValue({ points: [{ payload: { text: 'a' } }] });
        const q = new QdrantService({ url: 'http://q', collection: 'c' });
        const results = await q.search([0.1], 5);
        expect(results).toHaveLength(1);
    });

    it('search returns an empty array when the collection is missing', async () => {
        clientMock.query.mockRejectedValue({ status: 404 });
        const q = new QdrantService({ url: 'http://q', collection: 'c' });
        expect(await q.search([0.1])).toEqual([]);
    });

    it('listCollections returns enriched collection infos', async () => {
        clientMock.getCollections.mockResolvedValue({ collections: [{ name: 'research' }] });
        clientMock.getCollection.mockResolvedValue({ points_count: 42 });
        const q = new QdrantService({ url: 'http://q', collection: 'c' });
        expect(await q.listCollections()).toEqual([{ name: 'research', points_count: 42 }]);
        expect(clientMock.getCollection).toHaveBeenCalledWith('research');
    });

    it('listCollections returns an empty array when no collections exist', async () => {
        clientMock.getCollections.mockResolvedValue({});
        const q = new QdrantService({ url: 'http://q', collection: 'c' });
        expect(await q.listCollections()).toEqual([]);
    });

    it('listCollections skips collections whose info fails', async () => {
        clientMock.getCollections.mockResolvedValue({ collections: [{ name: 'a' }, { name: 'b' }] });
        clientMock.getCollection
            .mockResolvedValueOnce({ name: 'a', points_count: 1 })
            .mockRejectedValueOnce(new Error('boom'));
        const q = new QdrantService({ url: 'http://q', collection: 'c' });
        expect(await q.listCollections()).toEqual([{ name: 'a', points_count: 1 }]);
    });

    it('deleteBySource deletes points filtered by source', async () => {
        const q = new QdrantService({ url: 'http://q', collection: 'c' });
        await q.deleteBySource('a.md');
        expect(clientMock.delete).toHaveBeenCalledWith('c', {
            filter: { must: [{ key: 'source', match: { value: 'a.md' } }] }
        });
    });

    it('deleteBySource ignores a missing collection', async () => {
        clientMock.delete.mockRejectedValue({ status: 404 });
        const q = new QdrantService({ url: 'http://q', collection: 'c' });
        await expect(q.deleteBySource('a.md')).resolves.toBeUndefined();
    });

    it('isCollectionNotFoundError detects 404 and not-found messages', () => {
        const q = new QdrantService({ url: 'http://q', collection: 'c' });
        expect(q.isCollectionNotFoundError({ status: 404 })).toBe(true);
        expect(q.isCollectionNotFoundError({ message: 'Collection not found' })).toBe(true);
        expect(q.isCollectionNotFoundError({ status: 500 })).toBe(false);
    });

    it('ensureCollection skips creation when the collection already exists', async () => {
        clientMock.collectionExists.mockResolvedValue({ result: true });
        const q = new QdrantService({ url: 'http://q', collection: 'c' });
        await q.ensureCollection([0.1, 0.2]);
        expect(clientMock.createCollection).not.toHaveBeenCalled();
    });

    it('ensureCollection treats a 409 as an already-existing collection', async () => {
        clientMock.collectionExists.mockResolvedValue({ result: false });
        clientMock.createCollection.mockRejectedValueOnce({ status: 409, message: 'collection already exists' });

        const q = new QdrantService({ url: 'http://q', collection: 'c' });
        await expect(q.ensureCollection([0.1])).resolves.toBeUndefined();
        expect(clientMock.createCollection).toHaveBeenCalledTimes(1);
    });
});

describe('Qdrant reconnect', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('connects on the first attempt when reachable', async () => {
        clientMock.versionInfo.mockResolvedValue({ version: '1.12.0' });
        const q = new QdrantService({ url: 'http://q', port: 80, collection: 'research', retryDelaySec: 10, maxRetries: 0 });
        await vi.advanceTimersByTimeAsync(1);
        expect(q.connected).toBe(true);
        expect(q.version).toBe('1.12.0');
        expect(q.attempts).toBe(1);
        expect(q.nextAttemptAt).toBeNull();
        q.stop();
    });

    it('retries on failure and gives up after maxRetries consecutive failures', async () => {
        clientMock.versionInfo.mockRejectedValue({ message: 'ECONNREFUSED' });
        const q = new QdrantService({ url: 'http://q', port: 80, collection: 'research', retryDelaySec: 10, maxRetries: 3 });
        await vi.advanceTimersByTimeAsync(1);
        expect(q.connected).toBe(false);
        expect(q.attempts).toBe(1);
        expect(q.nextAttemptAt).not.toBeNull();
        await vi.advanceTimersByTimeAsync(10 * 1000);
        expect(q.attempts).toBe(2);
        await vi.advanceTimersByTimeAsync(10 * 1000);
        expect(q.attempts).toBe(3);
        expect(q.gaveUp).toBe(true);
        expect(q.nextAttemptAt).toBeNull();
        q.stop();
    });

    it('keeps retrying while maxRetries is 0 (unlimited)', async () => {
        clientMock.versionInfo.mockRejectedValue({ message: 'ECONNREFUSED' });
        const q = new QdrantService({ url: 'http://q', port: 80, collection: 'research', retryDelaySec: 10, maxRetries: 0 });
        await vi.advanceTimersByTimeAsync(1);
        expect(q.attempts).toBe(1);
        expect(q.gaveUp).toBe(false);
        await vi.advanceTimersByTimeAsync(10 * 1000);
        expect(q.attempts).toBe(2);
        expect(q.gaveUp).toBe(false);
        await vi.advanceTimersByTimeAsync(10 * 1000);
        expect(q.attempts).toBe(3);
        expect(q.gaveUp).toBe(false);
        q.stop();
    });

    it('does not attempt when no URL is configured', async () => {
        const q = new QdrantService({ url: '', port: 80, collection: 'research', retryDelaySec: 10, maxRetries: 0 });
        await vi.advanceTimersByTimeAsync(1);
        expect(q.connected).toBe(false);
        expect(q.error).toBe('no URL configured');
        expect(q.attempts).toBe(0);
        expect(q.nextAttemptAt).toBeNull();
        q.stop();
    });

    it('updateConfig resets the state and reconnects with the new settings', async () => {
        clientMock.versionInfo.mockRejectedValue({ message: 'ECONNREFUSED' });
        const q = new QdrantService({ url: 'http://old', port: 80, collection: 'research', retryDelaySec: 10, maxRetries: 0 });
        await vi.advanceTimersByTimeAsync(1);
        expect(q.attempts).toBe(1);
        expect(q.connected).toBe(false);

        clientMock.versionInfo.mockResolvedValue({ version: '1.13.0' });
        q.updateConfig({ url: 'http://new', port: 6333, collection: 'research', retryDelaySec: 5, maxRetries: 0 });
        expect(q.attempts).toBe(0);
        expect(q.connected).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(q.connected).toBe(true);
        expect(q.version).toBe('1.13.0');
        expect(q.attempts).toBe(1);
        q.stop();
    });

    it('emits a status event on each attempt', async () => {
        clientMock.versionInfo.mockRejectedValue({ message: 'ECONNREFUSED' });
        const q = new QdrantService({ url: 'http://q', port: 80, collection: 'research', retryDelaySec: 10, maxRetries: 0 });
        const events = [];
        q.on('status', (st) => events.push(st));
        await vi.advanceTimersByTimeAsync(1);
        expect(events.length).toBe(1);
        expect(events[0].connected).toBe(false);
        expect(events[0].attempts).toBe(1);
        q.stop();
    });

    it('getStatus returns the full status object', async () => {
        clientMock.versionInfo.mockResolvedValue({ version: '1.12.0' });
        const q = new QdrantService({ url: 'http://q', port: 80, collection: 'research', retryDelaySec: 10, maxRetries: 5 });
        await vi.advanceTimersByTimeAsync(1);
        const st = q.getStatus();
        expect(st.connected).toBe(true);
        expect(st.version).toBe('1.12.0');
        expect(st.attempts).toBe(1);
        expect(st.retryDelaySec).toBe(10);
        expect(st.maxRetries).toBe(5);
        expect(st.gaveUp).toBe(false);
        q.stop();
    });
});
