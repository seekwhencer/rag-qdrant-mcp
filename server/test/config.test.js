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
        expect(config.qdrant.collection).toBe('research');
        expect(config.qdrant.port).toBe(80);
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
            expect(written.qdrant).toEqual({ url: '', port: 80, collection: 'research' });
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
