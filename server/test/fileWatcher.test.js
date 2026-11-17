import { describe, it, expect, afterEach } from 'vitest';
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
    appendFileSync,
    unlinkSync,
    mkdirSync,
    rmdirSync,
    existsSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWatcher } from '../src/Services/File/FileWatcher.js';

const dirs = [];

function makeConfig(root) {
    return {
        storage: {
            enabled: true,
            root,
            concurrency: 1,
            dummyDelaySec: 0,
            retryDelaySec: 0,
            maxRetries: 0,
            maxFileSizeMb: 1024,
            ignore: ['**/.git/**', '**/node_modules/**']
        }
    };
}

function track() {
    const events = [];
    const handler = (relPath, event) => events.push({ relPath, event });
    return { events, handler };
}

async function waitFor(fn, timeout = 5000, interval = 50) {
    const start = Date.now();
    for (;;) {
        if (fn()) return true;
        if (Date.now() - start >= timeout) return false;
        await new Promise((r) => setTimeout(r, interval));
    }
}

function makeRoot() {
    const root = mkdtempSync(join(tmpdir(), 'filewatcher-'));
    dirs.push(root);
    return root;
}

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('FileWatcher', () => {
    it('maps add/change/unlink to create/modify/delete', async () => {
        const root = makeRoot();
        const { events, handler } = track();
        const w = new FileWatcher({ config: makeConfig(root), handler });
        w.start();
        await w.whenReady();

        writeFileSync(join(root, 'a.txt'), 'hello');
        await waitFor(() => events.some((e) => e.event === 'create' && e.relPath === 'a.txt'));

        appendFileSync(join(root, 'a.txt'), ' world');
        await waitFor(() => events.some((e) => e.event === 'modify' && e.relPath === 'a.txt'));

        unlinkSync(join(root, 'a.txt'));
        await waitFor(() => events.some((e) => e.event === 'delete' && e.relPath === 'a.txt'));

        await w.stop();
        expect(events).toEqual(expect.arrayContaining([
            { relPath: 'a.txt', event: 'create' },
            { relPath: 'a.txt', event: 'modify' },
            { relPath: 'a.txt', event: 'delete' }
        ]));
    });

    it('initial scan enqueues existing files as create (self-heal after restart)', async () => {
        const root = makeRoot();
        mkdirSync(join(root, 'docs'), { recursive: true });
        writeFileSync(join(root, 'docs', 'a.txt'), 'x');
        writeFileSync(join(root, 'b.txt'), 'y');

        const { events, handler } = track();
        const w = new FileWatcher({ config: makeConfig(root), handler });
        w.start();
        await w.whenReady();
        await waitFor(() => events.length >= 2);
        await w.stop();

        expect(events).toEqual(expect.arrayContaining([
            { relPath: 'docs/a.txt', event: 'create' },
            { relPath: 'b.txt', event: 'create' }
        ]));
    });

    it('ignores addDir/unlinkDir (directories produce no events)', async () => {
        const root = makeRoot();
        const { events, handler } = track();
        const w = new FileWatcher({ config: makeConfig(root), handler });
        w.start();
        await w.whenReady();

        mkdirSync(join(root, 'newdir'));
        await new Promise((r) => setTimeout(r, 700));
        expect(events).toEqual([]);

        rmdirSync(join(root, 'newdir'));
        await new Promise((r) => setTimeout(r, 700));
        expect(events).toEqual([]);

        await w.stop();
    });

    it('creates a missing root on start', async () => {
        const base = makeRoot();
        const root = join(base, 'nested', 'storage');
        expect(existsSync(root)).toBe(false);

        const { handler } = track();
        const w = new FileWatcher({ config: makeConfig(root), handler });
        w.start();
        expect(existsSync(root)).toBe(true);
        await w.stop();
    });

    it('path guard: accepts paths inside root, rejects traversal / absolute-outside', () => {
        const root = makeRoot();
        const { handler } = track();
        const w = new FileWatcher({ config: makeConfig(root), handler });

        // inside root → normalized POSIX path
        expect(w.toRelPath(join(root, 'docs', 'a.txt'))).toBe('docs/a.txt');
        expect(w.toRelPath(join(root, 'b.txt'))).toBe('b.txt');

        // outside root (traversal) → null
        expect(w.toRelPath(join(root, '..', 'outside.txt'))).toBeNull();
        expect(w.toRelPath(join(root, 'a', '..', '..', 'x.txt'))).toBeNull();

        // absolute path outside root → null
        expect(w.toRelPath('/etc/passwd')).toBeNull();

        // root itself / empty → null
        expect(w.toRelPath(root)).toBeNull();
    });

    it('requires a config with a storage group and a handler function', () => {
        expect(() => new FileWatcher({})).toThrow(/config/);
        const root = makeRoot();
        expect(() => new FileWatcher({ config: makeConfig(root) })).toThrow(/handler/);
    });

    it('whitelist: only matching files are forwarded (others dropped)', async () => {
        const root = makeRoot();
        const config = makeConfig(root);
        config.storage.whitelist = ['**/*.md'];
        const { events, handler } = track();
        const w = new FileWatcher({ config, handler });
        w.start();
        await w.whenReady();

        // .md → forwarded, .txt → dropped by whitelist.
        writeFileSync(join(root, 'keep.md'), 'hello');
        writeFileSync(join(root, 'drop.txt'), 'world');
        await waitFor(() => events.some((e) => e.relPath === 'keep.md'));
        // Kurze Wartezeit, um sicherzustellen, dass drop.txt NICHT kommt.
        await new Promise((r) => setTimeout(r, 400));

        await w.stop();
        expect(events).toEqual(expect.arrayContaining([{ relPath: 'keep.md', event: 'create' }]));
        expect(events.some((e) => e.relPath === 'drop.txt')).toBe(false);
    });

    it('whitelist: nested .md matches **/*.md, nested .txt does not', async () => {
        const root = makeRoot();
        mkdirSync(join(root, 'docs'), { recursive: true });
        const config = makeConfig(root);
        config.storage.whitelist = ['**/*.md'];
        const { events, handler } = track();
        const w = new FileWatcher({ config, handler });
        w.start();
        await w.whenReady();

        writeFileSync(join(root, 'docs', 'keep.md'), 'x');
        writeFileSync(join(root, 'docs', 'drop.txt'), 'y');
        await waitFor(() => events.some((e) => e.relPath === 'docs/keep.md'));
        await new Promise((r) => setTimeout(r, 400));

        await w.stop();
        expect(events).toEqual(expect.arrayContaining([{ relPath: 'docs/keep.md', event: 'create' }]));
        expect(events.some((e) => e.relPath === 'docs/drop.txt')).toBe(false);
    });

    it('whitelist: empty whitelist forwards everything (no filter)', async () => {
        const root = makeRoot();
        const config = makeConfig(root);
        config.storage.whitelist = [];
        const { events, handler } = track();
        const w = new FileWatcher({ config, handler });
        w.start();
        await w.whenReady();

        writeFileSync(join(root, 'a.txt'), 'hello');
        await waitFor(() => events.some((e) => e.relPath === 'a.txt'));
        await w.stop();
        expect(events).toEqual(expect.arrayContaining([{ relPath: 'a.txt', event: 'create' }]));
    });
});
