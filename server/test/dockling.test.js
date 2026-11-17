import { describe, it, expect, beforeEach, vi } from 'vitest';

const axiosMock = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('axios', () => ({ default: axiosMock }));

import { DocklingService, STATUS_ENDPOINTS } from '../src/Services/DocklingService.js';

const BASE = 'http://docling:5001';

/** Fake-Config: docling-Gruppe + EventEmitter-Interface (on/off/emit). */
function makeConfig(docling = {}) {
    const listeners = new Map();
    return {
        docling: { url: BASE, apiKey: 'secret-key', statusPollIntervalSec: 30, ...docling },
        on: (event, fn) => { listeners.set(event, fn); },
        off: (event) => { listeners.delete(event); },
        emit: (event, payload) => { listeners.get(event)?.(payload); }
    };
}

/** Microtask-Queue leeren (Promise-Ketten der Mocks durchlaufen). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function okResponse(data) {
    return { status: 200, data };
}

describe('DocklingService', () => {
    beforeEach(() => {
        axiosMock.get.mockReset();
        axiosMock.get.mockImplementation((url) => {
            if (url.endsWith('/health')) return Promise.resolve(okResponse({ status: 'ok' }));
            if (url.endsWith('/ready')) return Promise.resolve(okResponse({ status: 'ok' }));
            if (url.endsWith('/v1/capabilities'))
                return Promise.resolve(okResponse({ sources: ['url', 'file'], targets: { allowed: ['inbody'], default: 'inbody' }, output_formats: ['md', 'json'] }));
            if (url.endsWith('/version')) return Promise.resolve(okResponse({ docling: '2.30.0', docling_serve: '1.38.2' }));
            if (url.endsWith('/v1/memory/stats')) return Promise.resolve(okResponse({ rss: 120.5, cgroup_total: 512 }));
            if (url.endsWith('/v1/memory/counts'))
                return Promise.resolve(okResponse({ objects: { total: 42 }, asyncio: { all_tasks: 3, pending_tasks: 1 } }));
            return Promise.reject(new Error(`unexpected url ${url}`));
        });
    });

    it('polls all six status endpoints and aggregates the result', async () => {
        const svc = new DocklingService({ config: makeConfig() });
        const status = await svc.poll();

        expect(axiosMock.get).toHaveBeenCalledTimes(6);
        const urls = axiosMock.get.mock.calls.map((c) => c[0]);
        for (const ep of STATUS_ENDPOINTS) {
            expect(urls).toContain(`${BASE}${ep.path}`);
        }
        expect(status.configured).toBe(true);
        expect(status.reachable).toBe(true);
        expect(status.ready).toBe(true);
        expect(Object.keys(status.endpoints).sort()).toEqual(
            ['capabilities', 'health', 'memoryCounts', 'memoryStats', 'ready', 'version']
        );
        expect(status.endpoints.health.data).toEqual({ status: 'ok' });
        expect(status.checkedAt).toBeTruthy();
    });

    it('sends the API key as Bearer header when configured', async () => {
        const svc = new DocklingService({ config: makeConfig() });
        await svc.poll();
        for (const call of axiosMock.get.mock.calls) {
            expect(call[1].headers).toEqual({ Authorization: 'Bearer secret-key' });
        }
    });

    it('sends no Authorization header without an API key', async () => {
        const svc = new DocklingService({ config: makeConfig({ apiKey: '' }) });
        await svc.poll();
        for (const call of axiosMock.get.mock.calls) {
            expect(call[1].headers).toEqual({});
        }
    });

    it('marks the instance unreachable when /health fails, keeps other endpoints', async () => {
        axiosMock.get.mockImplementation((url) => {
            if (url.endsWith('/health')) {
                return Promise.reject({
                    response: { status: 503, data: { detail: 'Models not yet loaded' } },
                    message: 'Request failed with status code 503'
                });
            }
            return Promise.resolve(okResponse({ status: 'ok' }));
        });
        const svc = new DocklingService({ config: makeConfig() });
        const status = await svc.poll();

        expect(status.reachable).toBe(false);
        expect(status.endpoints.health.ok).toBe(false);
        expect(status.endpoints.health.error).toBe('Models not yet loaded');
        expect(status.endpoints.ready.ok).toBe(true);
    });

    it('captures network errors per endpoint', async () => {
        axiosMock.get.mockRejectedValue({ message: 'timeout of 5000ms exceeded' });
        const svc = new DocklingService({ config: makeConfig() });
        const status = await svc.poll();

        expect(status.reachable).toBe(false);
        for (const key of Object.keys(status.endpoints)) {
            expect(status.endpoints[key].ok).toBe(false);
            expect(status.endpoints[key].error).toBe('timeout of 5000ms exceeded');
        }
    });

    it('does not poll when no URL is configured', async () => {
        const svc = new DocklingService({ config: makeConfig({ url: '' }) });
        svc.start();
        await flush();
        expect(axiosMock.get).not.toHaveBeenCalled();
        expect(svc.getStatus().configured).toBe(false);
        svc.stop();
    });

    it('polls immediately on start and on the configured interval', async () => {
        vi.useFakeTimers();
        try {
            const svc = new DocklingService({ config: makeConfig({ statusPollIntervalSec: 30 }) });
            svc.start();
            await vi.advanceTimersByTimeAsync(0);
            expect(axiosMock.get).toHaveBeenCalledTimes(6);

            await vi.advanceTimersByTimeAsync(30 * 1000);
            expect(axiosMock.get).toHaveBeenCalledTimes(12);
            svc.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('restarts polling when the docling config changes', async () => {
        const config = makeConfig();
        const svc = new DocklingService({ config });
        svc.start();
        await flush();
        expect(axiosMock.get).toHaveBeenCalledTimes(6);

        config.docling.url = 'http://other:5001';
        config.emit('change', { changed: ['docling'] });
        await flush();
        expect(axiosMock.get).toHaveBeenCalledTimes(12);
        expect(svc.getStatus().url).toBe('http://other:5001');
        svc.stop();
    });

    it('ignores config changes of other groups', async () => {
        const config = makeConfig();
        const svc = new DocklingService({ config });
        svc.start();
        await flush();
        expect(axiosMock.get).toHaveBeenCalledTimes(6);

        config.emit('change', { changed: ['qdrant'] });
        await flush();
        expect(axiosMock.get).toHaveBeenCalledTimes(6);
        svc.stop();
    });

    it('stop() clears the timer and the config listener', async () => {
        vi.useFakeTimers();
        try {
            const config = makeConfig();
            const svc = new DocklingService({ config });
            svc.start();
            await vi.advanceTimersByTimeAsync(0);
            expect(axiosMock.get).toHaveBeenCalledTimes(6);

            svc.stop();
            await vi.advanceTimersByTimeAsync(60 * 1000);
            expect(axiosMock.get).toHaveBeenCalledTimes(6);

            config.emit('change', { changed: ['docling'] });
            await vi.advanceTimersByTimeAsync(0);
            expect(axiosMock.get).toHaveBeenCalledTimes(6);
        } finally {
            vi.useRealTimers();
        }
    });
});
