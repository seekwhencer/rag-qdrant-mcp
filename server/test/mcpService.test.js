import { describe, it, expect, vi } from 'vitest';

const registered = vi.hoisted(() => ({}));

vi.mock('@modelcontextprotocol/server', () => ({
    McpServer: vi.fn().mockImplementation(() => ({
        registerTool: vi.fn((name, config, handler) => {
            registered[name] = { config, handler };
        })
    }))
}));

import { McpService } from '../src/Services/McpService.js';

const makeService = () => new McpService({
    search: { qdrant: { listCollections: vi.fn() } },
    logger: { log: () => {}, error: () => {} }
});

describe('McpService', () => {
    it('registers ask, search and get_collections', () => {
        const svc = makeService();
        svc.createServer();
        expect(Object.keys(registered).sort()).toEqual(['ask', 'get_collections', 'search']);
    });

    it('get_collections returns formatted collection rows', async () => {
        const svc = makeService();
        svc.search.qdrant.listCollections.mockResolvedValue([
            {
                name: 'research',
                points_count: 42,
                config: { params: { vectors: { size: 384, distance: 'Cosine' } } }
            }
        ]);
        svc.createServer();

        const res = await registered.get_collections.handler({});
        expect(res.isError).toBeUndefined();
        expect(JSON.parse(res.content[0].text)).toEqual([
            { name: 'research', points: 42, distance: 'Cosine' }
        ]);
    });

    it('get_collections reads distance from named vectors', async () => {
        const svc = makeService();
        svc.search.qdrant.listCollections.mockResolvedValue([
            {
                name: 'multi',
                points_count: 7,
                config: { params: { vectors: { main: { size: 8, distance: 'Dot' } } } }
            }
        ]);
        svc.createServer();

        const res = await registered.get_collections.handler({});
        expect(JSON.parse(res.content[0].text)[0].distance).toBe('Dot');
    });

    it('get_collections returns a friendly message for an empty list', async () => {
        const svc = makeService();
        svc.search.qdrant.listCollections.mockResolvedValue([]);
        svc.createServer();

        const res = await registered.get_collections.handler({});
        expect(res.isError).toBe(false);
        expect(res.content[0].text).toBe('Keine Collections gefunden. Qdrant ist leer.');
    });

    it('get_collections returns isError when Qdrant fails', async () => {
        const svc = makeService();
        svc.search.qdrant.listCollections.mockRejectedValue(new Error('ECONNREFUSED'));
        svc.createServer();

        const res = await registered.get_collections.handler({});
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain('ECONNREFUSED');
    });
});
