import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileService } from '../src/Services/FileService.js';
import { FileQueue } from '../src/Services/File/FileQueue.js';
import { DoclingProcessor } from '../src/Services/File/DoclingProcessor.js';
import { DummyProcessor } from '../src/Services/File/FileProcessor.js';
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

function makeMockDatabase() {
    return {
        connect: () => Promise.resolve(),
        close: () => Promise.resolve()
    };
}

function makeMockStore(files = []) {
    return {
        list: () => Promise.resolve(files),
        upsert: () => Promise.resolve({})
    };
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

    it('buildet den Snapshot mit allen Feldern', async () => {
        const config = makeConfig();
        const store = makeMockStore([{ path: 'a.txt', status: 'done' }]);
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeMockWatcher();
        const service = new FileService({ config, database: makeMockDatabase(), store, processor, queue, watcher });

        const snap = await service.getSnapshot();
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

    it('Snapshot filtert Files nach Whitelist (nur passende erscheinen)', async () => {
        const config = makeConfig({ whitelist: ['**/*.md'] });
        const store = makeMockStore([
            { path: 'a.md', status: 'done' },
            { path: 'docs/b.md', status: 'done' },
            { path: 'c.txt', status: 'done' },
            { path: 'docs/d.txt', status: 'done' }
        ]);
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeMockWatcher();
        const service = new FileService({ config, database: makeMockDatabase(), store, processor, queue, watcher });

        const snap = await service.getSnapshot();
        expect(snap.files).toHaveLength(2);
        expect(snap.files.map((f) => f.path).sort()).toEqual(['a.md', 'docs/b.md']);
        expect(snap.stats.files).toBe(2);
    });

    it('Snapshot: leere Whitelist → alle Files erscheinen (kein Filter)', async () => {
        const config = makeConfig({ whitelist: [] });
        const store = makeMockStore([
            { path: 'a.md', status: 'done' },
            { path: 'c.txt', status: 'done' }
        ]);
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeMockWatcher();
        const service = new FileService({ config, database: makeMockDatabase(), store, processor, queue, watcher });

        const snap = await service.getSnapshot();
        expect(snap.files).toHaveLength(2);
        expect(snap.stats.files).toBe(2);
    });

    it('queue im Snapshot: neueste zuerst, cap 200', async () => {
        const config = makeConfig();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        queue.pause();

        for (let i = 0; i < 250; i++) {
            queue.enqueue(`f${i}.txt`, 'create');
        }

        const store = makeMockStore();
        const watcher = makeMockWatcher();
        const service = new FileService({ config, database: makeMockDatabase(), store, processor, queue, watcher });

        const snap = await service.getSnapshot();
        expect(snap.queue).toHaveLength(200);
        // neueste zuerst
        expect(snap.queue[0].path).toBe('f249.txt');
        expect(snap.queue[199].path).toBe('f50.txt');
    });

    it('pause/resume/abort/removeJob delegiert an Queue + refresh', async () => {
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
        const service = new FileService({ config, database: makeMockDatabase(), store, processor, queue, watcher });

        await service.pause();
        await service.resume();
        await service.abort();
        await service.removeJob('job123');

        expect(calls).toEqual(['pause', 'resume', 'abort', ['remove', 'job123']]);
    });

    it('Config-Change auf root → Watcher neu starten', async () => {
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
        const service = new FileService({ config, database: makeMockDatabase(), store, processor, queue, watcherFactory });

        await service.start();
        expect(watchers).toHaveLength(1);
        expect(watchers[0].started).toBe(1);
        expect(service._watcherRoot).toBe('/tmp/storage1');

        // Root ändern.
        config.storage.root = '/tmp/storage2';
        await service.onConfigChange();

        // Neuer Watcher erstellt + gestartet, alter gestoppt.
        expect(watchers).toHaveLength(2);
        expect(watchers[0].stopped).toBe(1);
        expect(watchers[1].started).toBe(1);
        expect(watchers[1].root).toBe('/tmp/storage2');
        expect(service._watcherRoot).toBe('/tmp/storage2');
    });

    it('Config-Change auf dataDir → Store.setPath mit neuem Pfad', async () => {
        const config = makeConfig();
        const setPathCalls = [];
        const store = {
            list: () => Promise.resolve([]),
            upsert: () => Promise.resolve({}),
            setPath: (p) => { setPathCalls.push(p); }
        };
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeMockWatcher();
        const service = new FileService({ config, database: makeMockDatabase(), store, processor, queue, watcher });
        await service.start();

        config.dataDir = '/tmp/data2';
        await service.onConfigChange({ changed: ['dataDir'] });

        expect(setPathCalls).toEqual([join('/tmp/data2', 'files.json')]);
    });

    it('enabled=false → Watcher + Queue stoppen; enabled=true → starten', async () => {
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
        const service = new FileService({ config, database: makeMockDatabase(), store, processor, queue, watcherFactory });

        await service.start();
        expect(watchers[0].started).toBe(1);

        // Deaktivieren.
        config.storage.enabled = false;
        await service.onConfigChange();
        expect(watchers[0].stopped).toBe(1);
        expect(queueStopped).toBe(1);

        // Aktivieren → Watcher läuft wieder (gleiche Instanz, Root unverändert).
        config.storage.enabled = true;
        await service.onConfigChange();
        expect(watchers[0].started).toBe(2);
        expect(watchers).toHaveLength(1);
    });

    it('Config-Event (updateSettings, root-Change) → Watcher neu starten', async () => {
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
        const service = new FileService({ config, database: makeMockDatabase(), store, processor, queue, watcherFactory });

        await service.start();
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

        await service.stop();
    });

    it('Config-Event (updateSettings, enabled=false) → Watcher gestoppt', async () => {
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
        const service = new FileService({ config, database: makeMockDatabase(), store, processor, queue, watcherFactory });

        await service.start();
        expect(watchers[0].started).toBe(1);

        // Deaktivieren über updateSettings() → 'change'-Event → onConfigChange.
        config.updateSettings({ storage: { enabled: false } });

        expect(watchers[0].stopped).toBe(1);
        expect(service._watcherActive).toBe(false);
        expect(queueStopped).toBe(1);

        await service.stop();
    });

    it('stop() abonniert Config-Event nicht mehr', async () => {
        const config = makeRealConfig();
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeSpyWatcher();
        const service = new FileService({ config, database: makeMockDatabase(), store, processor, queue, watcher });

        await service.start();
        expect(service._configHandler).not.toBeNull();

        await service.stop();
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
        const service = new FileService({ config, database: makeMockDatabase(), store, processor, queue, watcher, broadcastDebounceMs: 100 });

        const broadcasts = [];
        service.addListener((payload) => broadcasts.push(payload));

        // Mehrere refresh() innerhalb des Debounce-Fensters.
        await service.refresh();
        await service.refresh();
        await service.refresh();

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
        const service = new FileService({ config, database: makeMockDatabase(), store, processor, queue, watcher, logger });

        await service.start();

        // Ein Job enqueue → start + done.
        queue.enqueue('a.txt', 'create');
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        const messages = logs.map((l) => l.slice(1).join(' '));
        expect(messages.some((m) => m.includes('Job start'))).toBe(true);
        expect(messages.some((m) => m.includes('Job done'))).toBe(true);
    });

    it('stop() räumt Timer + Listener auf', async () => {
        const config = makeConfig();
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeMockWatcher();
        const service = new FileService({ config, database: makeMockDatabase(), store, processor, queue, watcher });

        await service.start();
        await service.refresh();

        service.addListener(() => {});
        expect(service.listeners.size).toBe(1);

        await service.stop();
        expect(service.listeners.size).toBe(0);
        expect(service._broadcastTimer).toBeNull();
        expect(service._queueHandler).toBeNull();
    });

    it('start() startet den Watcher nur wenn enabled', async () => {
        const config = makeConfig({ enabled: false });
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeSpyWatcher();
        const service = new FileService({ config, database: makeMockDatabase(), store, processor, queue, watcher });

        await service.start();
        expect(watcher.started).toBe(0);

        // enabled=true → Watcher startet.
        config.storage.enabled = true;
        await service.onConfigChange();
        expect(watcher.started).toBe(1);
    });
});

describe('FileService Processor-Auswahl (Schritt 4)', () => {
    function makeDoclingConfig(overrides = {}) {
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
                processor: 'docling',
                ...overrides
            },
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
    }

    function makeMockEmbeddings() {
        return { embed: async () => [0.1, 0.2] };
    }

    function makeMockQdrant() {
        return { upsert: async () => {}, deleteBySource: async () => {} };
    }

    function makeLogger(logs) {
        return {
            log: (label, ...args) => logs.push([label, ...args]),
            error: (label, ...args) => logs.push([label, ...args])
        };
    }

    it('docling + URL → DoclingProcessor wird erzeugt', () => {
        const config = makeDoclingConfig();
        const service = new FileService({
            config,
            database: makeMockDatabase(),
            store: makeMockStore(),
            embeddings: makeMockEmbeddings(),
            qdrant: makeMockQdrant(),
            watcher: makeMockWatcher()
        });
        expect(service.processor).toBeInstanceOf(DoclingProcessor);
    });

    it('docling ohne URL → DummyProcessor-Fallback + Error-Log', () => {
        const config = makeDoclingConfig();
        config.docling.url = '';
        const logs = [];
        const service = new FileService({
            config,
            database: makeMockDatabase(),
            store: makeMockStore(),
            embeddings: makeMockEmbeddings(),
            qdrant: makeMockQdrant(),
            watcher: makeMockWatcher(),
            logger: makeLogger(logs)
        });
        expect(service.processor).toBeInstanceOf(DummyProcessor);
        expect(logs.some((l) => l.slice(1).join(' ').includes('Fallback auf DummyProcessor'))).toBe(true);
    });

    it('docling + URL, aber embeddings/qdrant fehlen → DummyProcessor-Fallback + Error-Log', () => {
        const config = makeDoclingConfig();
        const logs = [];
        const service = new FileService({
            config,
            database: makeMockDatabase(),
            store: makeMockStore(),
            watcher: makeMockWatcher(),
            logger: makeLogger(logs)
        });
        expect(service.processor).toBeInstanceOf(DummyProcessor);
        expect(logs.some((l) => l.slice(1).join(' ').includes('Fallback auf DummyProcessor'))).toBe(true);
    });

    it('dummy → DummyProcessor', () => {
        const config = makeDoclingConfig({ processor: 'dummy' });
        const service = new FileService({
            config,
            database: makeMockDatabase(),
            store: makeMockStore(),
            embeddings: makeMockEmbeddings(),
            qdrant: makeMockQdrant(),
            watcher: makeMockWatcher()
        });
        expect(service.processor).toBeInstanceOf(DummyProcessor);
    });

    it('Config-Change docling → queue.processor wird neu erzeugt', async () => {
        const config = makeDoclingConfig();
        const queue = new FileQueue({ config, processor: makeMockProcessor() });
        const service = new FileService({
            config,
            database: makeMockDatabase(),
            store: makeMockStore(),
            embeddings: makeMockEmbeddings(),
            qdrant: makeMockQdrant(),
            queue,
            watcher: makeMockWatcher()
        });

        const before = service.processor;
        expect(before).toBeInstanceOf(DoclingProcessor);

        config.docling.url = 'http://docling:5002';
        await service.onConfigChange({ changed: ['docling'] });

        expect(service.processor).not.toBe(before);
        expect(service.processor).toBeInstanceOf(DoclingProcessor);
        expect(queue.processor).toBe(service.processor);
    });
});

describe('FileService DB-Reconnect (Schritt 5)', () => {
    function makeReconnectConfig(dbOverrides = {}) {
        return {
            dataDir: '/tmp/data',
            storage: {
                enabled: false, // Watcher aus — Fokus auf Reconnect-Loop
                root: '/tmp/storage',
                concurrency: 1,
                dummyDelaySec: 0,
                retryDelaySec: 5,
                maxRetries: 3,
                maxFileSizeMb: 1024,
                ignore: []
            },
            db: {
                retryDelaySec: 10,
                maxRetries: 0,
                ...dbOverrides
            }
        };
    }

    function makeFailingDatabase({ failTimes = Infinity } = {}) {
        let connectCalls = 0;
        const database = {
            connect: async () => {
                connectCalls += 1;
                if (connectCalls <= failTimes) throw new Error('ECONNREFUSED');
            },
            close: () => Promise.resolve()
        };
        return { database, calls: () => connectCalls };
    }

    it('connect() schlägt fehl → Retry nach db.retryDelaySec → Erfolg + refresh()', async () => {
        vi.useFakeTimers();
        const config = makeReconnectConfig();
        const files = [{ path: 'a.txt', status: 'done' }];
        const { database, calls } = makeFailingDatabase({ failTimes: 1 });
        const store = makeMockStore(files);
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeMockWatcher();
        const service = new FileService({ config, database, store, processor, queue, watcher });

        // start() darf bei DB-Down NICHT werfen.
        await service.start();
        expect(calls()).toBe(1);
        expect(service._storeConnected).toBe(false);

        // Snapshot meldet store.connected = false (DB down).
        let snap = await service.getSnapshot();
        expect(snap.store.connected).toBe(false);

        // Retry nach db.retryDelaySec (10 s) → Erfolg.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(calls()).toBe(2);
        expect(service._storeConnected).toBe(true);
        expect(service._storeConsecutiveFailures).toBe(0);

        // refresh() nach erfolgreichem Reconnect → aktueller Stand im Snapshot.
        snap = await service.getSnapshot();
        expect(snap.store.connected).toBe(true);
        expect(snap.files).toEqual(files);

        await service.stop();
    });

    it('maxRetries erreicht → Reconnect gestoppt (gaveUp, kein weiterer Versuch)', async () => {
        vi.useFakeTimers();
        const config = makeReconnectConfig({ maxRetries: 2 });
        const { database, calls } = makeFailingDatabase();
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeMockWatcher();
        const service = new FileService({ config, database, store, processor, queue, watcher });

        await service.start();
        expect(calls()).toBe(1);
        expect(service._storeGaveUp).toBe(false);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(calls()).toBe(2);
        expect(service._storeGaveUp).toBe(true);
        expect(service._storeNextAttemptAt).toBeNull();

        // Kein weiterer Versuch mehr.
        await vi.advanceTimersByTimeAsync(120_000);
        expect(calls()).toBe(2);

        await service.stop();
    });

    it('stop() beendet den Reconnect-Loop (kein hängender Timer, Pool geschlossen)', async () => {
        vi.useFakeTimers();
        const config = makeReconnectConfig();
        const { database, calls } = makeFailingDatabase();
        let closeCalls = 0;
        database.close = async () => { closeCalls += 1; };
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeMockWatcher();
        const service = new FileService({ config, database, store, processor, queue, watcher });

        await service.start();
        expect(calls()).toBe(1);
        expect(service._storeReconnectTimer).not.toBeNull();

        await service.stop();
        expect(service._storeReconnectTimer).toBeNull();
        expect(service._storeNextAttemptAt).toBeNull();
        expect(closeCalls).toBe(1);

        // Kein Connect-Versuch mehr nach stop().
        await vi.advanceTimersByTimeAsync(120_000);
        expect(calls()).toBe(1);
    });

    it('stop() → start() → Reconnect-Loop läuft wieder (State-Reset)', async () => {
        vi.useFakeTimers();
        const config = makeReconnectConfig();
        const { database, calls } = makeFailingDatabase({ failTimes: 2 });
        const store = makeMockStore();
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeMockWatcher();
        const service = new FileService({ config, database, store, processor, queue, watcher });

        await service.start();
        expect(calls()).toBe(1);
        await service.stop();

        // Neustart: Loop muss wieder laufen (nicht dauerhaft gestoppt).
        await service.start();
        expect(calls()).toBe(2);
        expect(service._storeConnected).toBe(false);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(calls()).toBe(3);
        expect(service._storeConnected).toBe(true);

        await service.stop();
    });

    it('Snapshot bleibt bei DB-Down verfügbar (list() schlägt fehl → files=[], connected=false)', async () => {
        const config = makeReconnectConfig();
        const database = {
            connect: async () => { throw new Error('ECONNREFUSED'); },
            close: () => Promise.resolve()
        };
        const store = {
            list: async () => { throw new Error('ECONNREFUSED'); },
            upsert: () => Promise.resolve({})
        };
        const processor = makeMockProcessor();
        const queue = new FileQueue({ config, processor });
        const watcher = makeMockWatcher();
        const service = new FileService({ config, database, store, processor, queue, watcher });

        await service.start();
        const snap = await service.getSnapshot();
        expect(snap.store.connected).toBe(false);
        expect(snap.files).toEqual([]);
        expect(snap.stats.files).toBe(0);

        await service.stop();
    });
});
