import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../src/Config.js';

const missingPath = () => join(tmpdir(), `cfg-missing-${Math.random()}.json`);

function withTempConfig(write) {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const cfgPath = join(dir, 'config.json');
    if (write) writeFileSync(cfgPath, JSON.stringify(write), 'utf8');
    return { dir, cfgPath };
}

describe('Config', () => {
    it('uses static defaults when no config.json and no env overrides are present', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        expect(config.serverPort).toBe(3000);
        expect(config.searchTopK).toBe(10);
        // Data-Ordner: eine Ebene über server/ (gleiche Ebene wie frontend/ und server/).
        expect(config.dataDir).toBe(join(__dirname, '..', '..', 'data'));
        expect(config.qdrant.collection).toBe('research');
        expect(config.qdrant.port).toBe(80);
        expect(config.qdrant.retryDelaySec).toBe(10);
        expect(config.qdrant.maxRetries).toBe(0);
        expect(config.embeddings.api).toBe('ollama');
        expect(config.embeddings.model).toBe('nomic-embed-text');
        expect(config.chat.api).toBe('ollama');
        expect(config.mcp.enabled).toBe(true);
        expect(config.mcp.path).toBe('/mcp');
        expect(config.mcp.allowedHosts).toEqual([]);
    });

    it('reads values from a config.json file referenced by CONFIG_PATH', () => {
        const { dir, cfgPath } = withTempConfig({
            serverPort: 4000,
            qdrant: { collection: 'mycol' },
            chat: { model: 'llama3.1' }
        });
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            expect(config.serverPort).toBe(4000);
            expect(config.qdrant.collection).toBe('mycol');
            expect(config.chat.model).toBe('llama3.1');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('lets env vars override values from config.json', () => {
        const { dir, cfgPath } = withTempConfig({
            serverPort: 4000,
            qdrant: { collection: 'mycol' },
            embeddings: { api: 'ollama' }
        });
        try {
            const config = new Config({
                CONFIG_PATH: cfgPath,
                SERVER_PORT: '5000',
                QDRANT_COLLECTION: 'envcol',
                EMBEDDINGS_API: 'openai'
            });
            expect(config.serverPort).toBe(5000);
            expect(config.qdrant.collection).toBe('envcol');
            expect(config.embeddings.api).toBe('openai');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('parses integer-valued fields', () => {
        const config = new Config({ CONFIG_PATH: missingPath(), QDRANT_PORT: '6333', SEARCH_TOP_K: '5' });
        expect(config.qdrant.port).toBe(6333);
        expect(config.searchTopK).toBe(5);
    });

    it('lets env vars override the qdrant retry settings', () => {
        const config = new Config({
            CONFIG_PATH: missingPath(),
            QDRANT_RETRY_DELAY_SEC: '25',
            QDRANT_MAX_RETRIES: '7'
        });
        expect(config.qdrant.retryDelaySec).toBe(25);
        expect(config.qdrant.maxRetries).toBe(7);
        expect(config.getSettings().envLocked.qdrant.retryDelaySec).toBe('QDRANT_RETRY_DELAY_SEC');
        expect(config.getSettings().envLocked.qdrant.maxRetries).toBe('QDRANT_MAX_RETRIES');
    });

    it('validateSettings rejects an invalid qdrant retryDelaySec', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, qdrant: { ...base.qdrant, retryDelaySec: -1 } })
            .some((e) => e.includes('qdrant.retryDelaySec'))).toBe(true);
    });

    it('validateSettings rejects maxRetries outside 0-100', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, qdrant: { ...base.qdrant, maxRetries: -1 } })
            .some((e) => e.includes('qdrant.maxRetries'))).toBe(true);
        expect(config.validateSettings({ ...base, qdrant: { ...base.qdrant, maxRetries: 101 } })
            .some((e) => e.includes('qdrant.maxRetries'))).toBe(true);
    });

    it('lets DATA_DIR override the data folder and locks it in the UI', () => {
        const config = new Config({ CONFIG_PATH: missingPath(), DATA_DIR: '/custom/data' });
        expect(config.dataDir).toBe('/custom/data');
        expect(config.getSettings().envLocked.root.dataDir).toBe('DATA_DIR');
    });

    it('parses MCP_ALLOWED_HOSTS as a comma-separated array', () => {
        const config = new Config({ CONFIG_PATH: missingPath(), MCP_ALLOWED_HOSTS: 'a.com, b.com' });
        expect(config.mcp.allowedHosts).toEqual(['a.com', 'b.com']);
    });

    it('can disable MCP via MCP_ENABLED=false', () => {
        const config = new Config({ CONFIG_PATH: missingPath(), MCP_ENABLED: 'false' });
        expect(config.mcp.enabled).toBe(false);
    });

    it('prefers CONFIG_PATH in resolvePath and falls back to the server config.json', () => {
        const custom = '/tmp/custom.json';
        expect(new Config({ CONFIG_PATH: custom }).resolvePath()).toBe(custom);
        const fallback = missingPath();
        expect(new Config({ CONFIG_PATH: fallback }).resolvePath()).toBe(fallback);
        expect(new Config({}).resolvePath()).toContain('config.json');
    });

    it('saveDefaults explicitly writes a nested config file', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath, SERVER_PORT: '8000' });
            config.saveDefaults();
            expect(existsSync(cfgPath)).toBe(true);
            const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(written.serverPort).toBe(8000);
            expect(written.dataDir).toBe(join(__dirname, '..', '..', 'data'));
            expect(written.qdrant).toEqual({ url: '', port: 80, collection: 'research', retryDelaySec: 10, maxRetries: 0 });
            expect(written.embeddings).toEqual({ api: 'ollama', url: '', host: '', model: 'nomic-embed-text' });
            expect(written.chat.api).toBe('ollama');
            expect(written.mcp).toEqual({ enabled: true, path: '/mcp', allowedHosts: [] });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('does not create a config.json during construction when none exists', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            new Config({ CONFIG_PATH: cfgPath });
            expect(existsSync(cfgPath)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('getSettings returns the full settings object with envLocked', () => {
        const config = new Config({ CONFIG_PATH: missingPath(), SERVER_PORT: '9000' });
        const settings = config.getSettings();
        expect(settings.serverPort).toBe(9000);
        expect(settings.envLocked.root.serverPort).toBe('SERVER_PORT');
        expect(settings.qdrant).toBeDefined();
        expect(settings.embeddings).toBeDefined();
        expect(settings.chat).toBeDefined();
        expect(settings.mcp).toBeDefined();
    });

    it('getSettings exposes the read-only configPath', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            expect(config.getSettings().configPath).toBe(cfgPath);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('updateSettings ignores a configPath patch (read-only)', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            config.updateSettings({ configPath: '/somewhere/else.json', searchTopK: 5 });
            expect(config.configPath).toBe(cfgPath);
            expect(config.searchTopK).toBe(5);
            const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(written.configPath).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('updateSettings applies a valid patch and persists it', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            const result = config.updateSettings({ searchTopK: 25, chat: { model: 'llama3.1' } });
            expect(result.applied).toContain('searchTopK');
            expect(result.applied).toContain('chat');
            expect(config.searchTopK).toBe(25);
            expect(config.chat.model).toBe('llama3.1');
            const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(written.searchTopK).toBe(25);
            expect(written.chat.model).toBe('llama3.1');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('updateSettings applies a dataDir patch and persists it', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            const result = config.updateSettings({ dataDir: '/new/data' });
            expect(result.applied).toContain('dataDir');
            expect(config.dataDir).toBe('/new/data');
            const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(written.dataDir).toBe('/new/data');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('validateSettings rejects an empty dataDir', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, dataDir: '   ' }).some((e) => e.includes('dataDir'))).toBe(true);
    });

    it('updateSettings rejects an invalid patch', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            expect(() => config.updateSettings({ serverPort: 'not-a-number' })).toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('updateSettings ignores env-locked keys', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath, SERVER_PORT: '9000' });
            config.updateSettings({ serverPort: 1234 });
            expect(config.serverPort).toBe(9000);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('Config storage group', () => {
    it('uses storage defaults when no config.json and no env overrides are present', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        expect(config.storage.enabled).toBe(true);
        expect(config.storage.root).toBe('./storage');
        expect(config.storage.concurrency).toBe(1);
        expect(config.storage.dummyDelaySec).toBe(2);
        expect(config.storage.retryDelaySec).toBe(5);
        expect(config.storage.maxRetries).toBe(3);
        expect(config.storage.maxFileSizeMb).toBe(1024);
        expect(config.storage.ignore).toEqual(['**/.git/**', '**/node_modules/**']);
        expect(config.storage.whitelist).toEqual([]);
    });

    it('lets env vars override storage values', () => {
        const config = new Config({
            CONFIG_PATH: missingPath(),
            STORAGE_ENABLED: 'false',
            STORAGE_ROOT: '/app/storage',
            STORAGE_CONCURRENCY: '4',
            STORAGE_DUMMY_DELAY_SEC: '1.5',
            STORAGE_RETRY_DELAY_SEC: '7',
            STORAGE_MAX_RETRIES: '0',
            STORAGE_MAX_FILE_SIZE_MB: '512'
        });
        expect(config.storage.enabled).toBe(false);
        expect(config.storage.root).toBe('/app/storage');
        expect(config.storage.concurrency).toBe(4);
        expect(config.storage.dummyDelaySec).toBe(1.5);
        expect(config.storage.retryDelaySec).toBe(7);
        expect(config.storage.maxRetries).toBe(0);
        expect(config.storage.maxFileSizeMb).toBe(512);
    });

    it('parses STORAGE_IGNORE as a comma-separated array', () => {
        const config = new Config({ CONFIG_PATH: missingPath(), STORAGE_IGNORE: '**/.git/**, **/tmp/**' });
        expect(config.storage.ignore).toEqual(['**/.git/**', '**/tmp/**']);
    });

    it('reads storage values from a config.json file', () => {
        const { dir, cfgPath } = withTempConfig({
            storage: { root: '/data/files', concurrency: 2, ignore: ['**/cache/**'] }
        });
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            expect(config.storage.root).toBe('/data/files');
            expect(config.storage.concurrency).toBe(2);
            expect(config.storage.ignore).toEqual(['**/cache/**']);
            expect(config.storage.enabled).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('saveDefaults writes the storage group', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            config.saveDefaults();
            const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(written.storage).toEqual({
                enabled: true,
                processor: 'docling',
                root: './storage',
                concurrency: 1,
                dummyDelaySec: 2,
                retryDelaySec: 5,
                maxRetries: 3,
                maxFileSizeMb: 1024,
                ignore: ['**/.git/**', '**/node_modules/**'],
                whitelist: []
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('getSettings includes storage and envLocked.storage', () => {
        const config = new Config({ CONFIG_PATH: missingPath(), STORAGE_ROOT: '/env/root' });
        const settings = config.getSettings();
        expect(settings.storage.root).toBe('/env/root');
        expect(settings.envLocked.storage.root).toBe('STORAGE_ROOT');
    });

    it('validateSettings accepts valid storage settings', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const errors = config.validateSettings(config.getSettings());
        expect(errors).toEqual([]);
    });

    it('validateSettings rejects an empty storage.root', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const errors = config.validateSettings({ ...config.getSettings(), storage: { ...config.storage, root: '   ' } });
        expect(errors.some((e) => e.includes('storage.root'))).toBe(true);
    });

    it('validateSettings rejects concurrency outside 1-16', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, storage: { ...base.storage, concurrency: 0 } })
            .some((e) => e.includes('storage.concurrency'))).toBe(true);
        expect(config.validateSettings({ ...base, storage: { ...base.storage, concurrency: 17 } })
            .some((e) => e.includes('storage.concurrency'))).toBe(true);
        expect(config.validateSettings({ ...base, storage: { ...base.storage, concurrency: 1.5 } })
            .some((e) => e.includes('storage.concurrency'))).toBe(true);
    });

    it('validateSettings rejects negative delays', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, storage: { ...base.storage, dummyDelaySec: -1 } })
            .some((e) => e.includes('storage.dummyDelaySec'))).toBe(true);
        expect(config.validateSettings({ ...base, storage: { ...base.storage, retryDelaySec: -0.5 } })
            .some((e) => e.includes('storage.retryDelaySec'))).toBe(true);
    });

    it('validateSettings rejects maxRetries outside 0-10', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, storage: { ...base.storage, maxRetries: -1 } })
            .some((e) => e.includes('storage.maxRetries'))).toBe(true);
        expect(config.validateSettings({ ...base, storage: { ...base.storage, maxRetries: 11 } })
            .some((e) => e.includes('storage.maxRetries'))).toBe(true);
    });

    it('validateSettings rejects maxFileSizeMb <= 0', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, storage: { ...base.storage, maxFileSizeMb: 0 } })
            .some((e) => e.includes('storage.maxFileSizeMb'))).toBe(true);
    });

    it('validateSettings rejects a non-string ignore entry', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, storage: { ...base.storage, ignore: ['**/.git/**', 42] } })
            .some((e) => e.includes('storage.ignore'))).toBe(true);
    });

    it('validateSettings rejects a non-string whitelist entry', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, storage: { ...base.storage, whitelist: ['**/*.md', 42] } })
            .some((e) => e.includes('storage.whitelist'))).toBe(true);
    });

    it('parses STORAGE_WHITELIST as a comma-separated array', () => {
        const config = new Config({ CONFIG_PATH: missingPath(), STORAGE_WHITELIST: '**/*.md, **/*.txt' });
        expect(config.storage.whitelist).toEqual(['**/*.md', '**/*.txt']);
    });

    it('updateSettings applies a valid storage patch and persists it', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            const result = config.updateSettings({ storage: { concurrency: 8, root: '/data' } });
            expect(result.applied).toContain('storage');
            expect(config.storage.concurrency).toBe(8);
            expect(config.storage.root).toBe('/data');
            const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(written.storage.concurrency).toBe(8);
            expect(written.storage.root).toBe('/data');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('updateSettings rejects an invalid storage patch', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            expect(() => config.updateSettings({ storage: { concurrency: 99 } })).toThrow();
            expect(config.storage.concurrency).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('updateSettings ignores env-locked storage keys', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath, STORAGE_ROOT: '/env/root' });
            config.updateSettings({ storage: { root: '/patched/root' } });
            expect(config.storage.root).toBe('/env/root');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('uses storage.processor default docling', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        expect(config.storage.processor).toBe('docling');
    });

    it('lets STORAGE_PROCESSOR override storage.processor and locks it in the UI', () => {
        const config = new Config({ CONFIG_PATH: missingPath(), STORAGE_PROCESSOR: 'dummy' });
        expect(config.storage.processor).toBe('dummy');
        expect(config.getSettings().envLocked.storage.processor).toBe('STORAGE_PROCESSOR');
    });

    it('validateSettings rejects an invalid storage.processor', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, storage: { ...base.storage, processor: 'bogus' } })
            .some((e) => e.includes('storage.processor'))).toBe(true);
        expect(config.validateSettings({ ...base, storage: { ...base.storage, processor: 42 } })
            .some((e) => e.includes('storage.processor'))).toBe(true);
    });
});

describe('Config db group', () => {
    it('uses db defaults when no config.json and no env overrides are present', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        expect(config.db.host).toBe('127.0.0.1');
        expect(config.db.port).toBe(3306);
        expect(config.db.user).toBe('rag');
        expect(config.db.password).toBe('');
        expect(config.db.database).toBe('ragqdrant');
        expect(config.db.poolSize).toBe(5);
        expect(config.db.connectTimeoutMs).toBe(5000);
        expect(config.db.retryDelaySec).toBe(10);
        expect(config.db.maxRetries).toBe(0);
    });

    it('lets env vars override db values and locks them in the UI', () => {
        const config = new Config({
            CONFIG_PATH: missingPath(),
            DB_HOST: 'mariadb',
            DB_PORT: '3307',
            DB_USER: 'app',
            DB_PASSWORD: 's3cret',
            DB_NAME: 'mydb',
            DB_POOL_SIZE: '12',
            DB_CONNECT_TIMEOUT_MS: '8000',
            DB_RETRY_DELAY_SEC: '20',
            DB_MAX_RETRIES: '4'
        });
        expect(config.db.host).toBe('mariadb');
        expect(config.db.port).toBe(3307);
        expect(config.db.user).toBe('app');
        expect(config.db.password).toBe('s3cret');
        expect(config.db.database).toBe('mydb');
        expect(config.db.poolSize).toBe(12);
        expect(config.db.connectTimeoutMs).toBe(8000);
        expect(config.db.retryDelaySec).toBe(20);
        expect(config.db.maxRetries).toBe(4);
        const locked = config.getSettings().envLocked.db;
        expect(locked.host).toBe('DB_HOST');
        expect(locked.port).toBe('DB_PORT');
        expect(locked.user).toBe('DB_USER');
        expect(locked.password).toBe('DB_PASSWORD');
        expect(locked.database).toBe('DB_NAME');
        expect(locked.poolSize).toBe('DB_POOL_SIZE');
        expect(locked.connectTimeoutMs).toBe('DB_CONNECT_TIMEOUT_MS');
        expect(locked.retryDelaySec).toBe('DB_RETRY_DELAY_SEC');
        expect(locked.maxRetries).toBe('DB_MAX_RETRIES');
    });

    it('reads db values from a config.json file', () => {
        const { dir, cfgPath } = withTempConfig({
            db: { host: 'filehost', port: 3307, poolSize: 9, database: 'filedb' }
        });
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            expect(config.db.host).toBe('filehost');
            expect(config.db.port).toBe(3307);
            expect(config.db.poolSize).toBe(9);
            expect(config.db.database).toBe('filedb');
            // Unset keys fall back to defaults.
            expect(config.db.user).toBe('rag');
            expect(config.db.connectTimeoutMs).toBe(5000);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('saveDefaults writes the db group with an empty password placeholder', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            config.saveDefaults();
            const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(written.db).toEqual({
                host: '127.0.0.1',
                port: 3306,
                user: 'rag',
                password: '',
                database: 'ragqdrant',
                poolSize: 5,
                connectTimeoutMs: 5000,
                retryDelaySec: 10,
                maxRetries: 0
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('getSettings includes db and envLocked.db', () => {
        const config = new Config({ CONFIG_PATH: missingPath(), DB_HOST: '/env/host' });
        const settings = config.getSettings();
        expect(settings.db.host).toBe('/env/host');
        expect(settings.envLocked.db.host).toBe('DB_HOST');
    });

    it('getSettings masks db.password even when set via env', () => {
        const config = new Config({ CONFIG_PATH: missingPath(), DB_PASSWORD: 's3cret' });
        // Runtime-State hält den echten Wert (für die spätere DB-Verbindung).
        expect(config.db.password).toBe('s3cret');
        // Die UI sieht nur die Maske, nie den Klartext.
        expect(config.getSettings().db.password).toBe('••••••');
    });

    it('validateSettings accepts valid db settings', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const errors = config.validateSettings(config.getSettings());
        expect(errors).toEqual([]);
    });

    it('validateSettings rejects an empty db.host', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, db: { ...base.db, host: '   ' } })
            .some((e) => e.includes('db.host'))).toBe(true);
    });

    it('validateSettings rejects db.port outside 1-65535', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, db: { ...base.db, port: 0 } })
            .some((e) => e.includes('db.port'))).toBe(true);
        expect(config.validateSettings({ ...base, db: { ...base.db, port: 65536 } })
            .some((e) => e.includes('db.port'))).toBe(true);
        expect(config.validateSettings({ ...base, db: { ...base.db, port: 33.5 } })
            .some((e) => e.includes('db.port'))).toBe(true);
    });

    it('validateSettings rejects db.poolSize outside 1-50', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, db: { ...base.db, poolSize: 0 } })
            .some((e) => e.includes('db.poolSize'))).toBe(true);
        expect(config.validateSettings({ ...base, db: { ...base.db, poolSize: 51 } })
            .some((e) => e.includes('db.poolSize'))).toBe(true);
        expect(config.validateSettings({ ...base, db: { ...base.db, poolSize: 2.5 } })
            .some((e) => e.includes('db.poolSize'))).toBe(true);
    });

    it('validateSettings rejects db.connectTimeoutMs <= 0', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, db: { ...base.db, connectTimeoutMs: 0 } })
            .some((e) => e.includes('db.connectTimeoutMs'))).toBe(true);
        expect(config.validateSettings({ ...base, db: { ...base.db, connectTimeoutMs: -100 } })
            .some((e) => e.includes('db.connectTimeoutMs'))).toBe(true);
    });

    it('updateSettings applies a valid db patch and persists it', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            config.updateSettings({ db: { poolSize: 8, host: 'dbhost' } });
            expect(config.db.poolSize).toBe(8);
            expect(config.db.host).toBe('dbhost');
            const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(written.db.poolSize).toBe(8);
            expect(written.db.host).toBe('dbhost');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('updateSettings rejects an invalid db patch', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            expect(() => config.updateSettings({ db: { poolSize: 99 } })).toThrow();
            expect(config.db.poolSize).toBe(5);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('updateSettings ignores env-locked db keys', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath, DB_HOST: '/env/host' });
            config.updateSettings({ db: { host: '/patched/host' } });
            expect(config.db.host).toBe('/env/host');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('keeps the real db.password in runtime state but never persists it', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath, DB_PASSWORD: 's3cret' });
            // UI sendet den maskierten Wert zurück (leer gelassen = unverändert).
            config.updateSettings({ db: { poolSize: 8, password: '••••••' } });
            // Runtime-State behält den echten Env-Wert.
            expect(config.db.password).toBe('s3cret');
            expect(config.db.poolSize).toBe(8);
            // config.json enthält nie den Klartext, sondern den leeren Platzhalter.
            const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(written.db.password).toBe('');
            expect(written.db.poolSize).toBe(8);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('treats an empty db.password in a patch as unchanged', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath, DB_PASSWORD: 's3cret' });
            config.updateSettings({ db: { poolSize: 6, password: '' } });
            expect(config.db.password).toBe('s3cret');
            const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(written.db.password).toBe('');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('Config docling group', () => {
    it('uses docling defaults when no config.json and no env overrides are present', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        expect(config.docling.url).toBe('');
        expect(config.docling.apiKey).toBe('');
        expect(config.docling.statusPollIntervalSec).toBe(30);
    });

    it('lets env vars override docling values and locks them in the UI', () => {
        const config = new Config({
            CONFIG_PATH: missingPath(),
            DOCLING_URL: 'http://docling:5001',
            DOCLING_API_KEY: 'dk-123',
            DOCLING_STATUS_POLL_INTERVAL_SEC: '15'
        });
        expect(config.docling.url).toBe('http://docling:5001');
        expect(config.docling.apiKey).toBe('dk-123');
        expect(config.docling.statusPollIntervalSec).toBe(15);
        expect(config.getSettings().envLocked.docling.url).toBe('DOCLING_URL');
        expect(config.getSettings().envLocked.docling.apiKey).toBe('DOCLING_API_KEY');
        expect(config.getSettings().envLocked.docling.statusPollIntervalSec).toBe('DOCLING_STATUS_POLL_INTERVAL_SEC');
    });

    it('reads docling values from a config.json file', () => {
        const { dir, cfgPath } = withTempConfig({
            docling: { url: 'http://filehost:5001' }
        });
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            expect(config.docling.url).toBe('http://filehost:5001');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('saveDefaults writes the docling group with an empty apiKey placeholder', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            config.saveDefaults();
            const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(written.docling).toEqual({
                url: '',
                apiKey: '',
                statusPollIntervalSec: 30,
                timeoutSec: 300,
                maxTokens: 512,
                useMarkdownTables: true,
                useMarkdownImages: false,
                ocr: true
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('getSettings includes docling and envLocked.docling', () => {
        const config = new Config({ CONFIG_PATH: missingPath(), DOCLING_URL: 'http://envhost:5001' });
        const settings = config.getSettings();
        expect(settings.docling.url).toBe('http://envhost:5001');
        expect(settings.envLocked.docling.url).toBe('DOCLING_URL');
    });

    it('getSettings masks docling.apiKey even when set via env', () => {
        const config = new Config({ CONFIG_PATH: missingPath(), DOCLING_API_KEY: 'dk-123' });
        // Runtime-State hält den echten Wert (für die spätere API-Aufrufe).
        expect(config.docling.apiKey).toBe('dk-123');
        // Die UI sieht nur die Maske, nie den Klartext.
        expect(config.getSettings().docling.apiKey).toBe('••••••');
    });

    it('validateSettings rejects a non-string docling.url', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, docling: { url: 42 } })
            .some((e) => e.includes('docling.url'))).toBe(true);
    });

    it('validateSettings rejects a non-string docling.apiKey', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, docling: { url: 'http://x', apiKey: 42 } })
            .some((e) => e.includes('docling.apiKey'))).toBe(true);
    });

    it('validateSettings rejects an invalid docling.statusPollIntervalSec', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, docling: { url: 'http://x', apiKey: '', statusPollIntervalSec: 0 } })
            .some((e) => e.includes('docling.statusPollIntervalSec'))).toBe(true);
        expect(config.validateSettings({ ...base, docling: { url: 'http://x', apiKey: '', statusPollIntervalSec: 2.5 } })
            .some((e) => e.includes('docling.statusPollIntervalSec'))).toBe(true);
    });

    it('updateSettings applies a valid docling patch and persists it', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            const result = config.updateSettings({ docling: { url: 'http://newhost:5001' } });
            expect(result.applied).toContain('docling');
            expect(config.docling.url).toBe('http://newhost:5001');
            const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(written.docling.url).toBe('http://newhost:5001');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('updateSettings ignores env-locked docling keys', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath, DOCLING_URL: 'http://envhost:5001' });
            config.updateSettings({ docling: { url: 'http://patched:5001' } });
            expect(config.docling.url).toBe('http://envhost:5001');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('keeps the real docling.apiKey in runtime state but never persists it', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath, DOCLING_API_KEY: 'dk-123' });
            // UI sendet den maskierten Wert zurück (leer gelassen = unverändert).
            config.updateSettings({ docling: { url: 'http://newhost:5001', apiKey: '••••••' } });
            // Runtime-State behält den echten Env-Wert.
            expect(config.docling.apiKey).toBe('dk-123');
            expect(config.docling.url).toBe('http://newhost:5001');
            // config.json enthält nie den Klartext, sondern den leeren Platzhalter.
            const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(written.docling.apiKey).toBe('');
            expect(written.docling.url).toBe('http://newhost:5001');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('treats an empty docling.apiKey in a patch as unchanged', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath, DOCLING_API_KEY: 'dk-123' });
            config.updateSettings({ docling: { url: 'http://newhost:5001', apiKey: '' } });
            expect(config.docling.apiKey).toBe('dk-123');
            const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(written.docling.apiKey).toBe('');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('updateSettings applies a valid docling.statusPollIntervalSec patch and persists it', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath });
            const result = config.updateSettings({ docling: { statusPollIntervalSec: 45 } });
            expect(result.applied).toContain('docling');
            expect(config.docling.statusPollIntervalSec).toBe(45);
            const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(written.docling.statusPollIntervalSec).toBe(45);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('updateSettings ignores env-locked docling.statusPollIntervalSec', () => {
        const { dir, cfgPath } = withTempConfig();
        try {
            const config = new Config({ CONFIG_PATH: cfgPath, DOCLING_STATUS_POLL_INTERVAL_SEC: '15' });
            config.updateSettings({ docling: { statusPollIntervalSec: 99 } });
            expect(config.docling.statusPollIntervalSec).toBe(15);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('uses docling chunking defaults', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        expect(config.docling.timeoutSec).toBe(300);
        expect(config.docling.maxTokens).toBe(512);
        expect(config.docling.useMarkdownTables).toBe(true);
        expect(config.docling.useMarkdownImages).toBe(false);
        expect(config.docling.ocr).toBe(true);
    });

    it('lets env vars override the new docling fields and locks them in the UI', () => {
        const config = new Config({
            CONFIG_PATH: missingPath(),
            DOCLING_TIMEOUT_SEC: '600',
            DOCLING_MAX_TOKENS: '256',
            DOCLING_USE_MARKDOWN_TABLES: 'false',
            DOCLING_USE_MARKDOWN_IMAGES: 'true',
            DOCLING_OCR: 'false'
        });
        expect(config.docling.timeoutSec).toBe(600);
        expect(config.docling.maxTokens).toBe(256);
        expect(config.docling.useMarkdownTables).toBe(false);
        expect(config.docling.useMarkdownImages).toBe(true);
        expect(config.docling.ocr).toBe(false);
        expect(config.getSettings().envLocked.docling.timeoutSec).toBe('DOCLING_TIMEOUT_SEC');
        expect(config.getSettings().envLocked.docling.maxTokens).toBe('DOCLING_MAX_TOKENS');
        expect(config.getSettings().envLocked.docling.useMarkdownTables).toBe('DOCLING_USE_MARKDOWN_TABLES');
        expect(config.getSettings().envLocked.docling.useMarkdownImages).toBe('DOCLING_USE_MARKDOWN_IMAGES');
        expect(config.getSettings().envLocked.docling.ocr).toBe('DOCLING_OCR');
    });

    it('validateSettings rejects an invalid docling.timeoutSec', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, docling: { ...base.docling, timeoutSec: 0 } })
            .some((e) => e.includes('docling.timeoutSec'))).toBe(true);
        expect(config.validateSettings({ ...base, docling: { ...base.docling, timeoutSec: 2.5 } })
            .some((e) => e.includes('docling.timeoutSec'))).toBe(true);
    });

    it('validateSettings rejects a negative docling.maxTokens', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, docling: { ...base.docling, maxTokens: -1 } })
            .some((e) => e.includes('docling.maxTokens'))).toBe(true);
    });

    it('validateSettings rejects non-boolean docling markdown/ocr flags', () => {
        const config = new Config({ CONFIG_PATH: missingPath() });
        const base = config.getSettings();
        expect(config.validateSettings({ ...base, docling: { ...base.docling, useMarkdownTables: 'yes' } })
            .some((e) => e.includes('docling.useMarkdownTables'))).toBe(true);
        expect(config.validateSettings({ ...base, docling: { ...base.docling, useMarkdownImages: 1 } })
            .some((e) => e.includes('docling.useMarkdownImages'))).toBe(true);
        expect(config.validateSettings({ ...base, docling: { ...base.docling, ocr: 'true' } })
            .some((e) => e.includes('docling.ocr'))).toBe(true);
    });
});
