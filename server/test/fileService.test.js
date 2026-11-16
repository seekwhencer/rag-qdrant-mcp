import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileService } from '../src/Services/FileService.js';
import { FileQueue } from '../src/Services/FileQueue.js';
import { Config } from '../src/Config.js';

function makeRealConfig() {
    const dir = mkdtempSync(join(tmpdir(), 'fileservice-cfg-'));
    return new Config({ CONFIG_PATH: join(dir, 'config.json') });
}

function makeConfig(overrides = {}) {
    return {
        dataDir: '/tmp/data',
        storage: {
            enabled: true,
            root: '/tmp/storage',
            concurrency: 1,
            dummyDelaySec: 0,
            retryDelaySec: 5,
            maxRetries: 3,
            maxFileSizeMb: 1024,
            ignore: [],
            ...overrides
        }
    };
}

function makeMockStore(files = []) {
    return { list: () => files, upsert: () => ({}) };
}

function makeMockProcessor() {
    return { process: async () => ({ ok: true }) };
}

function makeMockWatcher() {
    return { start: () => {}, stop: () => Promise.resolve() };
}

function makeSpyWatcher() {
    const w = {
        started: 0,
        stopped: 0,
        start: () => { w.started++; },
        stop: () => { w.stopped++; return Promise.resolve(); }
    };
    return w;
}

afterEach(() => {
    vi.useRealTimers();
});

describe('FileService', () => {
    it('validiert die Config (storage-Gruppe erforderlich)', () => {
        expect(() => new FileService({})).toThrow(/config/);
        expect(() => new FileService({ config: {} })).toThrow(/config/);
    });

    it('buildet den Snapshot mit allen Feldern', () => {
        const config = makeConfig();
        const store = makeMockStore([{ path: 'a.txt', status: 'done' }]);
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeMockWatcher();
        const service = new FileService({ config, store, processor, queue, watcher });

        const snap = service.getSnapshot();
        expect(snap).toHaveProperty('ts');
        expect(snap.root).toBe('/tmp/storage');
        expect(snap.enabled).toBe(true);
        expect(snap.concurrency).toBe(1);
        expect(snap.dummyDelaySec).toBe(0);
        expect(snap.paused).toBe(false);
        expect(snap.stats).toEqual({
            pending: 0,
            processing: 0,
            done: 0,
            error: 0,
            cancelled: 0,
            files: 1
        });
        expect(Array.isArray(snap.queue)).toBe(true);
        expect(Array.isArray(snap.files)).toBe(true);
        expect(snap.files).toHaveLength(1);
    });

    it('queue im Snapshot: neueste zuerst, cap 200', () => {
        const config = makeConfig();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        queue.pause();

        for (let i = 0; i < 250; i++) {
            queue.enqueue(`f${i}.txt`, 'create');
        }

        const store = makeMockStore();
        const watcher = makeMockWatcher();
        const service = new FileService({ config, store, processor, queue, watcher });

        const snap = service.getSnapshot();
        expect(snap.queue).toHaveLength(200);
        // neueste zuerst
        expect(snap.queue[0].path).toBe('f249.txt');
        expect(snap.queue[199].path).toBe('f50.txt');
    });

    it('pause/resume/abort/removeJob delegiert an Queue + refresh', () => {
        const config = makeConfig();
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });

        const calls = [];
        const origPause = queue.pause.bind(queue);
        queue.pause = () => { calls.push('pause'); origPause(); };
        const origResume = queue.resume.bind(queue);
        queue.resume = () => { calls.push('resume'); origResume(); };
        const origAbort = queue.abort.bind(queue);
        queue.abort = () => { calls.push('abort'); origAbort(); };
        const origRemove = queue.remove.bind(queue);
        queue.remove = (id) => { calls.push(['remove', id]); return origRemove(id); };

        const watcher = makeMockWatcher();
        const service = new FileService({ config, store, processor, queue, watcher });

        service.pause();
        service.resume();
        service.abort();
        service.removeJob('job123');

        expect(calls).toEqual(['pause', 'resume', 'abort', ['remove', 'job123']]);
    });

    it('Config-Change auf root → Watcher neu starten', () => {
        const config = makeConfig({ root: '/tmp/storage1' });
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });

        const watchers = [];
        const watcherFactory = (cfg) => {
            const w = makeSpyWatcher();
            w.root = cfg.storage.root;
            watchers.push(w);
            return w;
        };
        const service = new FileService({ config, store, processor, queue, watcherFactory });

        service.start();
        expect(watchers).toHaveLength(1);
        expect(watchers[0].started).toBe(1);
        expect(service._watcherRoot).toBe('/tmp/storage1');

        // Root ändern.
        config.storage.root = '/tmp/storage2';
        service.onConfigChange();

        // Neuer Watcher erstellt + gestartet, alter gestoppt.
        expect(watchers).toHaveLength(2);
        expect(watchers[0].stopped).toBe(1);
        expect(watchers[1].started).toBe(1);
        expect(watchers[1].root).toBe('/tmp/storage2');
        expect(service._watcherRoot).toBe('/tmp/storage2');
    });

    it('Config-Change auf dataDir → Store.setPath mit neuem Pfad', () => {
        const config = makeConfig();
        const setPathCalls = [];
        const store = {
            list: () => [],
            upsert: () => ({}),
            setPath: (p) => { setPathCalls.push(p); }
        };
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeMockWatcher();
        const service = new FileService({ config, store, processor, queue, watcher });
        service.start();

        config.dataDir = '/tmp/data2';
        service.onConfigChange({ changed: ['dataDir'] });

        expect(setPathCalls).toEqual([join('/tmp/data2', 'files.json')]);
    });

    it('enabled=false → Watcher + Queue stoppen; enabled=true → starten', () => {
        const config = makeConfig();
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        let queueStopped = 0;
        const origStop = queue.stop.bind(queue);
        queue.stop = () => { queueStopped++; origStop(); };

        const watchers = [];
        const watcherFactory = (cfg) => {
            const w = makeSpyWatcher();
            watchers.push(w);
            return w;
        };
        const service = new FileService({ config, store, processor, queue, watcherFactory });

        service.start();
        expect(watchers[0].started).toBe(1);

        // Deaktivieren.
        config.storage.enabled = false;
        service.onConfigChange();
        expect(watchers[0].stopped).toBe(1);
        expect(queueStopped).toBe(1);

        // Aktivieren → Watcher läuft wieder (gleiche Instanz, Root unverändert).
        config.storage.enabled = true;
        service.onConfigChange();
        expect(watchers[0].started).toBe(2);
        expect(watchers).toHaveLength(1);
    });

    it('Config-Event (updateSettings, root-Change) → Watcher neu starten', () => {
        const config = makeRealConfig();
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });

        const watchers = [];
        const watcherFactory = (cfg) => {
            const w = makeSpyWatcher();
            w.root = cfg.storage.root;
            watchers.push(w);
            return w;
        };
        const service = new FileService({ config, store, processor, queue, watcherFactory });

        service.start();
        expect(watchers).toHaveLength(1);
        expect(watchers[0].started).toBe(1);

        // Config-Change über updateSettings() → 'change'-Event → onConfigChange.
        const newRoot = join(tmpdir(), 'new-storage-root');
        const result = config.updateSettings({ storage: { root: newRoot } });
        expect(result.applied).toContain('storage');

        // Neuer Watcher erstellt + gestartet, alter gestoppt.
        expect(watchers).toHaveLength(2);
        expect(watchers[0].stopped).toBe(1);
        expect(watchers[1].started).toBe(1);
        expect(watchers[1].root).toBe(newRoot);
        expect(service._watcherRoot).toBe(newRoot);

        service.stop();
    });

    it('Config-Event (updateSettings, enabled=false) → Watcher gestoppt', () => {
        const config = makeRealConfig();
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        let queueStopped = 0;
        const origStop = queue.stop.bind(queue);
        queue.stop = () => { queueStopped++; origStop(); };

        const watchers = [];
        const watcherFactory = (cfg) => {
            const w = makeSpyWatcher();
            watchers.push(w);
            return w;
        };
        const service = new FileService({ config, store, processor, queue, watcherFactory });

        service.start();
        expect(watchers[0].started).toBe(1);

        // Deaktivieren über updateSettings() → 'change'-Event → onConfigChange.
        config.updateSettings({ storage: { enabled: false } });

        expect(watchers[0].stopped).toBe(1);
        expect(service._watcherActive).toBe(false);
        expect(queueStopped).toBe(1);

        service.stop();
    });

    it('stop() abonniert Config-Event nicht mehr', () => {
        const config = makeRealConfig();
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeSpyWatcher();
        const service = new FileService({ config, store, processor, queue, watcher });

        service.start();
        expect(service._configHandler).not.toBeNull();

        service.stop();
        expect(service._configHandler).toBeNull();
        expect(config.listenerCount('change')).toBe(0);

        // Nach stop() reagiert der Service nicht mehr auf Config-Events.
        const startedBefore = watcher.started;
        const stoppedBefore = watcher.stopped;
        config.updateSettings({ storage: { root: '/tmp/irgendwo' } });
        expect(watcher.started).toBe(startedBefore);
        expect(watcher.stopped).toBe(stoppedBefore);
    });

    it('debounced Broadcast: mehrere Changes → ein Broadcast', async () => {
        vi.useFakeTimers();
        const config = makeConfig();
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeMockWatcher();
        const service = new FileService({ config, store, processor, queue, watcher, broadcastDebounceMs: 100 });

        const broadcasts = [];
        service.addListener((payload) => broadcasts.push(payload));

        // Mehrere refresh() innerhalb des Debounce-Fensters.
        service.refresh();
        service.refresh();
        service.refresh();

        // Noch kein Broadcast (debounced).
        expect(broadcasts).toHaveLength(0);

        // Debounce-Fenster ablaufen lassen.
        await vi.advanceTimersByTimeAsync(100);

        // Genau ein Broadcast.
        expect(broadcasts).toHaveLength(1);
        const parsed = JSON.parse(broadcasts[0]);
        expect(parsed.type).toBe('update');
        expect(parsed.data).toHaveProperty('ts');
    });

    it('Processing-Events (start/done) in das Log-System', async () => {
        const config = makeConfig();
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeMockWatcher();

        const logs = [];
        const logger = {
            log: (label, ...args) => logs.push([label, ...args]),
            error: (label, ...args) => logs.push([label, ...args])
        };
        const service = new FileService({ config, store, processor, queue, watcher, logger });

        service.start();

        // Ein Job enqueue → start + done.
        queue.enqueue('a.txt', 'create');
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        const messages = logs.map((l) => l.slice(1).join(' '));
        expect(messages.some((m) => m.includes('Job start'))).toBe(true);
        expect(messages.some((m) => m.includes('Job done'))).toBe(true);
    });

    it('stop() räumt Timer + Listener auf', () => {
        const config = makeConfig();
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeMockWatcher();
        const service = new FileService({ config, store, processor, queue, watcher });

        service.start();
        service.refresh();

        service.addListener(() => {});
        expect(service.listeners.size).toBe(1);

        service.stop();
        expect(service.listeners.size).toBe(0);
        expect(service._broadcastTimer).toBeNull();
        expect(service._queueHandler).toBeNull();
    });

    it('start() startet den Watcher nur wenn enabled', () => {
        const config = makeConfig({ enabled: false });
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeSpyWatcher();
        const service = new FileService({ config, store, processor, queue, watcher });

        service.start();
        expect(watcher.started).toBe(0);

        // enabled=true → Watcher startet.
        config.storage.enabled = true;
        service.onConfigChange();
        expect(watcher.started).toBe(1);
    });
});
