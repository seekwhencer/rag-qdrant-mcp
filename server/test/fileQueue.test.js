import { describe, it, expect, vi, afterEach } from 'vitest';
import { FileQueue } from '../src/Services/File/FileQueue.js';

const baseConfig = {
    storage: { concurrency: 1, retryDelaySec: 5, maxRetries: 3 }
};

/** Mock-Processor: wartet optional, kann fehlschlagen, hört auf AbortSignal. */
function makeProcessor({ delay = 0, fail = false, onProcess = null } = {}) {
    const calls = [];
    return {
        calls,
        async process(job, signal) {
            calls.push({ id: job.id, path: job.path, event: job.event, at: Date.now() });
            if (onProcess) onProcess(job, signal);
            if (delay > 0) {
                await new Promise((resolve, reject) => {
                    const t = setTimeout(resolve, delay);
                    const onAbort = () => {
                        clearTimeout(t);
                        reject(new DOMException('Aborted', 'AbortError'));
                    };
                    if (signal) {
                        if (signal.aborted) {
                            onAbort();
                            return;
                        }
                        signal.addEventListener('abort', onAbort, { once: true });
                    }
                });
            }
            if (fail) throw new Error('boom');
            return { ok: true };
        }
    };
}

/** Microtasks + Event-Loop flushen (sicherer als nur Promise.resolve). */
async function flush() {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
}

afterEach(() => {
    vi.useRealTimers();
});

describe('FileQueue', () => {
    it('dedup: neues Event ersetzt den pending-Job desselben Pfads (latest-wins)', () => {
        const processor = makeProcessor();
        const queue = new FileQueue({ config: baseConfig, processor });
        queue.pause();

        const first = queue.enqueue('docs/a.txt', 'create');
        const second = queue.enqueue('docs/a.txt', 'modify');

        expect(queue.list()).toHaveLength(1);
        expect(second.id).not.toBe(first.id);
        expect(queue.get(second.id).event).toBe('modify');
        expect(queue.get(first.id)).toBeNull();
    });

    it('dedup: delete ersetzt immer den pending-Job', () => {
        const processor = makeProcessor();
        const queue = new FileQueue({ config: baseConfig, processor });
        queue.pause();

        queue.enqueue('docs/a.txt', 'create');
        const del = queue.enqueue('docs/a.txt', 'delete');

        expect(queue.list()).toHaveLength(1);
        expect(queue.get(del.id).event).toBe('delete');
    });

    it('dedup: Event während processing wird verworfen (max. 1 Job pro Pfad)', async () => {
        let release;
        const gate = new Promise((r) => (release = r));
        const processor = {
            async process(job) {
                if (job.path === 'docs/a.txt') await gate;
                return { ok: true };
            }
        };
        const queue = new FileQueue({ config: baseConfig, processor });

        const first = queue.enqueue('docs/a.txt', 'create');
        await flush();
        expect(queue.get(first.id).status).toBe('processing');

        const dropped = queue.enqueue('docs/a.txt', 'modify');
        expect(dropped).toBeNull();
        expect(queue.list()).toHaveLength(1);

        release();
        await flush();
        expect(queue.get(first.id).status).toBe('done');
    });

    it('pause: Dispatcher stoppt, aktive Jobs laufen zu Ende; resume setzt fort', async () => {
        let releaseFirst;
        const firstGate = new Promise((r) => (releaseFirst = r));
        let started = 0;
        const processor = {
            async process(job) {
                started++;
                if (started === 1) await firstGate;
                return { ok: true };
            }
        };
        const queue = new FileQueue({ config: baseConfig, processor });

        const jobA = queue.enqueue('a.txt', 'create');
        const jobB = queue.enqueue('b.txt', 'create');
        await flush();
        expect(started).toBe(1);
        expect(queue.get(jobA.id).status).toBe('processing');
        expect(queue.get(jobB.id).status).toBe('pending');

        queue.pause();
        releaseFirst();
        await flush();
        expect(queue.get(jobA.id).status).toBe('done');
        expect(started).toBe(1);
        expect(queue.get(jobB.id).status).toBe('pending');

        queue.resume();
        await flush();
        expect(started).toBe(2);
        expect(queue.get(jobB.id).status).toBe('done');
    });

    it('abort: pending → cancelled, aktive Jobs via AbortSignal abgebrochen', async () => {
        const processor = makeProcessor({ delay: 100 });
        const queue = new FileQueue({ config: baseConfig, processor });

        const jobA = queue.enqueue('a.txt', 'create');
        const jobB = queue.enqueue('b.txt', 'create');
        await flush();
        expect(queue.get(jobA.id).status).toBe('processing');
        expect(queue.get(jobB.id).status).toBe('pending');

        queue.abort();
        await flush();
        expect(queue.get(jobA.id).status).toBe('cancelled');
        expect(queue.get(jobB.id).status).toBe('cancelled');
        expect(queue.stats().cancelled).toBe(2);
    });

    it('remove: nur pending-Jobs löschbar', async () => {
        let release;
        const gate = new Promise((r) => (release = r));
        const processor = {
            async process(job) {
                await gate;
                return { ok: true };
            }
        };
        const queue = new FileQueue({ config: baseConfig, processor });

        const jobA = queue.enqueue('a.txt', 'create');
        const jobB = queue.enqueue('b.txt', 'create');
        await flush();

        // jobA läuft → remove schlägt fehl
        expect(queue.remove(jobA.id)).toBeNull();
        expect(queue.get(jobA.id)).toBeTruthy();

        // jobB ist pending → remove klappt
        expect(queue.remove(jobB.id)).toBeTruthy();
        expect(queue.get(jobB.id)).toBeNull();
        expect(queue.list()).toHaveLength(1);

        release();
        await flush();
    });

    it('retry: Fehler → nach retryDelaySec erneut, nach maxRetries endgültig error', async () => {
        vi.useFakeTimers();
        const config = { storage: { concurrency: 1, retryDelaySec: 5, maxRetries: 2 } };
        let attempts = 0;
        const processor = {
            async process() {
                attempts++;
                throw new Error('boom');
            }
        };
        const queue = new FileQueue({ config, processor });

        const job = queue.enqueue('a.txt', 'create');
        await vi.advanceTimersByTimeAsync(0);
        expect(attempts).toBe(1);
        expect(queue.get(job.id).status).toBe('pending');
        expect(queue.get(job.id).retries).toBe(1);

        await vi.advanceTimersByTimeAsync(5000);
        await vi.advanceTimersByTimeAsync(0);
        expect(attempts).toBe(2);
        expect(queue.get(job.id).retries).toBe(2);

        await vi.advanceTimersByTimeAsync(5000);
        await vi.advanceTimersByTimeAsync(0);
        expect(attempts).toBe(3);
        expect(queue.get(job.id).status).toBe('error');
        expect(queue.get(job.id).error).toBe('boom');
    });

    it('retry: Dispatcher überspringt Jobs mit retryAt in der Zukunft', async () => {
        vi.useFakeTimers();
        const config = { storage: { concurrency: 1, retryDelaySec: 10, maxRetries: 3 } };
        let attempts = 0;
        const processor = {
            async process() {
                attempts++;
                throw new Error('boom');
            }
        };
        const queue = new FileQueue({ config, processor });

        const job = queue.enqueue('a.txt', 'create');
        await vi.advanceTimersByTimeAsync(0);
        expect(attempts).toBe(1);

        // zu früh: kein zweiter Versuch
        await vi.advanceTimersByTimeAsync(5000);
        await vi.advanceTimersByTimeAsync(0);
        expect(attempts).toBe(1);

        // fällig: zweiter Versuch
        await vi.advanceTimersByTimeAsync(5000);
        await vi.advanceTimersByTimeAsync(0);
        expect(attempts).toBe(2);
        expect(queue.get(job.id).retries).toBe(2);
    });

    it('concurrency: 2 Worker parallel (concurrency=2)', async () => {
        const config = { storage: { concurrency: 2, retryDelaySec: 0, maxRetries: 0 } };
        let activeCount = 0;
        let maxActive = 0;
        const processor = {
            async process() {
                activeCount++;
                maxActive = Math.max(maxActive, activeCount);
                await new Promise((r) => setTimeout(r, 50));
                activeCount--;
                return { ok: true };
            }
        };
        const queue = new FileQueue({ config, processor });

        queue.enqueue('a.txt', 'create');
        queue.enqueue('b.txt', 'create');
        await new Promise((r) => setTimeout(r, 200));

        expect(maxActive).toBe(2);
        expect(queue.stats().done).toBe(2);
    });

    it('concurrency=1: nächster pending-Job startet automatisch nach Job-Ende (done)', async () => {
        const config = { storage: { concurrency: 1, retryDelaySec: 0, maxRetries: 0 } };
        let started = 0;
        const processor = {
            async process() {
                started++;
                await new Promise((r) => setTimeout(r, 20));
                return { ok: true };
            }
        };
        const queue = new FileQueue({ config, processor });

        const jobA = queue.enqueue('a.txt', 'create');
        const jobB = queue.enqueue('b.txt', 'create');
        await new Promise((r) => setTimeout(r, 100));

        expect(started).toBe(2);
        expect(queue.get(jobA.id).status).toBe('done');
        expect(queue.get(jobB.id).status).toBe('done');
        expect(queue.stats().done).toBe(2);
    });

    it('concurrency=1: nach endgültigem Fehler startet der nächste pending-Job', async () => {
        const config = { storage: { concurrency: 1, retryDelaySec: 0, maxRetries: 0 } };
        let started = 0;
        const processor = {
            async process(job) {
                started++;
                if (job.path === 'a.txt') throw new Error('boom');
                return { ok: true };
            }
        };
        const queue = new FileQueue({ config, processor });

        const jobA = queue.enqueue('a.txt', 'create');
        const jobB = queue.enqueue('b.txt', 'create');
        await new Promise((r) => setTimeout(r, 50));

        expect(started).toBe(2);
        expect(queue.get(jobA.id).status).toBe('error');
        expect(queue.get(jobB.id).status).toBe('done');
    });

    it('concurrency: Änderung in Config wirkt sofort (pro Tick gelesen)', async () => {
        const config = { storage: { concurrency: 1, retryDelaySec: 0, maxRetries: 0 } };
        let activeCount = 0;
        let maxActive = 0;
        const processor = {
            async process() {
                activeCount++;
                maxActive = Math.max(maxActive, activeCount);
                await new Promise((r) => setTimeout(r, 50));
                activeCount--;
                return { ok: true };
            }
        };
        const queue = new FileQueue({ config, processor });

        queue.enqueue('a.txt', 'create');
        queue.enqueue('b.txt', 'create');
        await new Promise((r) => setTimeout(r, 10));
        // concurrency=1 → nur 1 aktiv
        expect(maxActive).toBe(1);

        // concurrency erhöhen → zweiter Job startet sofort
        config.storage.concurrency = 2;
        queue.dispatch();
        await new Promise((r) => setTimeout(r, 200));
        expect(maxActive).toBe(2);
        expect(queue.stats().done).toBe(2);
    });

    it('queue-cap: Overflow verwirft älteste pending-Jobs', () => {
        const processor = makeProcessor();
        const queue = new FileQueue({ config: baseConfig, processor, maxQueueSize: 3 });
        queue.pause();

        queue.enqueue('a.txt', 'create');
        queue.enqueue('b.txt', 'create');
        queue.enqueue('c.txt', 'create');
        expect(queue.list()).toHaveLength(3);

        queue.enqueue('d.txt', 'create');
        expect(queue.list()).toHaveLength(3);
        expect(queue.get('a.txt')).toBeNull();
        expect(queue.list().map((j) => j.path)).toEqual(['d.txt', 'c.txt', 'b.txt']);
    });

    it('emittet change-Events (enqueue/start/done)', async () => {
        const processor = makeProcessor();
        const queue = new FileQueue({ config: baseConfig, processor });
        const changes = [];
        queue.on('change', (c) => changes.push(c.type));

        queue.enqueue('a.txt', 'create');
        await flush();

        expect(changes).toEqual(['enqueue', 'start', 'done']);
    });

    it('validiert das Event (create|modify|delete)', () => {
        const processor = makeProcessor();
        const queue = new FileQueue({ config: baseConfig, processor });
        expect(() => queue.enqueue('a.txt', 'rename')).toThrow('invalid event');
    });

    it('listPrioritized: processing > done > pending, jeweils neueste zuerst', async () => {
        let releaseB;
        const gateB = new Promise((r) => (releaseB = r));
        const processor = {
            async process(job) {
                if (job.path === 'b.txt') await gateB;
                return { ok: true };
            }
        };
        const queue = new FileQueue({ config: baseConfig, processor });

        queue.enqueue('a.txt', 'create'); // completes instantly → done
        queue.enqueue('b.txt', 'create'); // delayed → processing
        queue.enqueue('c.txt', 'create'); // pending
        queue.enqueue('d.txt', 'create'); // pending
        await flush();

        const byPath = Object.fromEntries(queue.list().map((j) => [j.path, j.status]));
        expect(byPath).toEqual({ 'a.txt': 'done', 'b.txt': 'processing', 'c.txt': 'pending', 'd.txt': 'pending' });

        // processing zuerst, dann done, dann pending (neueste zuerst)
        expect(queue.listPrioritized(10).map((j) => j.path)).toEqual(['b.txt', 'a.txt', 'd.txt', 'c.txt']);
    });

    it('listPrioritized: Cap begrenzt die Liste, processing/done bleiben sichtbar', async () => {
        const processor = makeProcessor();
        const queue = new FileQueue({ config: baseConfig, processor });
        queue.pause();

        // 5 pending + 1 done (manuell via Status-Setzen simuliert)
        queue.enqueue('p1.txt', 'create');
        queue.enqueue('p2.txt', 'create');
        queue.enqueue('p3.txt', 'create');
        queue.enqueue('p4.txt', 'create');
        queue.enqueue('p5.txt', 'create');
        const doneJob = queue.enqueue('done.txt', 'create');
        doneJob.status = 'done';

        // Cap=2: processing(0) + done(1) + pending(1) → done + neuestes pending
        const result = queue.listPrioritized(2);
        expect(result.map((j) => j.path)).toEqual(['done.txt', 'p5.txt']);
        expect(result.map((j) => j.status)).toEqual(['done', 'pending']);
    });
});
