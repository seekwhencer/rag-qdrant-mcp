import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Qdrant-Parameter (Vektordatenbank).
 *
 * Jede Zeile:
 *   env     – Umgebungsvariable, die den Wert überschreibt
 *   type    – 'string' | 'integer'
 *   default – Standardwert (wird in config.json geschrieben)
 *
 * Die Reihenfolge bestimmt die Reihenfolge in der UI.
 */
const QDRANT_PARAMS = {
    url: { env: 'QDRANT_URL', type: 'string', default: '' },
    port: { env: 'QDRANT_PORT', type: 'integer', default: 80 },
    collection: { env: 'QDRANT_COLLECTION', type: 'string', default: 'research' },
    // Reconnect: Wartezeit zwischen Verbindungsversuchen (Sekunden).
    retryDelaySec: { env: 'QDRANT_RETRY_DELAY_SEC', type: 'number', default: 10 },
    // Reconnect: max. aufeinanderfolgende Fehlversuche (0 = unbegrenzt).
    maxRetries: { env: 'QDRANT_MAX_RETRIES', type: 'integer', default: 0 },
};

/**
 * Embeddings-Parameter (OpenAI-kompatible API / Ollama).
 */
const EMBEDDINGS_PARAMS = {
    api: { env: 'EMBEDDINGS_API', type: 'string', default: 'ollama' },
    url: { env: 'EMBEDDINGS_URL', type: 'string', default: '' },
    host: { env: 'EMBEDDINGS_HOST', type: 'string', default: '' },
    model: { env: 'EMBEDDINGS_MODEL', type: 'string', default: 'nomic-embed-text' },
};

/**
 * Chat-Parameter (OpenAI-kompatible API / Ollama).
 */
const CHAT_PARAMS = {
    api: { env: 'CHAT_API', type: 'string', default: 'ollama' },
    url: { env: 'CHAT_URL', type: 'string', default: '' },
    model: { env: 'CHAT_MODEL', type: 'string', default: '' },
    systemPrompt: {
        env: 'LLM_SYSTEM_PROMPT',
        type: 'string',
        default: "You are a helpful research assistant. Answer in markdown format the user's question precisely and full, based solely on the following context:"
    },
};

/**
 * Vision-Parameter (OpenAI-kompatible API / Ollama).
 * Vision-Modell wird wie das Chat-Modell konfiguriert (gleicher Endpunkt).
 */
const VISION_PARAMS = {
    api: { env: 'VISION_API', type: 'string', default: 'ollama' },
    url: { env: 'VISION_URL', type: 'string', default: '' },
    model: { env: 'VISION_MODEL', type: 'string', default: '' },
};

/**
 * MCP-Parameter (Model Context Protocol).
 */
const MCP_PARAMS = {
    enabled: { env: 'MCP_ENABLED', type: 'boolean', default: true },
    path: { env: 'MCP_PATH', type: 'string', default: '/mcp' },
    allowedHosts: { env: 'MCP_ALLOWED_HOSTS', type: 'array', default: [] },
};

/**
 * Storage-Parameter (Datei-Verwaltung: Watcher + Queue).
 */
const STORAGE_PARAMS = {
    enabled: { env: 'STORAGE_ENABLED', type: 'boolean', default: true },
    processor: { env: 'STORAGE_PROCESSOR', type: 'string', default: 'docling' },
    root: { env: 'STORAGE_ROOT', type: 'string', default: './storage' },
    concurrency: { env: 'STORAGE_CONCURRENCY', type: 'integer', default: 1 },
    dummyDelaySec: { env: 'STORAGE_DUMMY_DELAY_SEC', type: 'number', default: 2 },
    retryDelaySec: { env: 'STORAGE_RETRY_DELAY_SEC', type: 'number', default: 5 },
    maxRetries: { env: 'STORAGE_MAX_RETRIES', type: 'integer', default: 3 },
    maxFileSizeMb: { env: 'STORAGE_MAX_FILE_SIZE_MB', type: 'number', default: 1024 },
    ignore: { env: 'STORAGE_IGNORE', type: 'array', default: ['**/.git/**', '**/node_modules/**'] },
    // Whitelist: nur Files, die min. ein Pattern erfüllen, werden berücksichtigt.
    // Leer = kein Filter (alle Files). Glob-Patterns (z. B. `**/*.md`).
    whitelist: { env: 'STORAGE_WHITELIST', type: 'array', default: [] },
};

/**
 * Database-Parameter (MariaDB: Verbindung + Pool + Reconnect).
 *
 * `password` ist ein Secret: der echte Wert kommt ausschließlich aus der Env
 * (`DB_PASSWORD`) und wird nie in config.json persistiert (siehe Passwort-Hygiene).
 */
const DB_PARAMS = {
    host: { env: 'DB_HOST', type: 'string', default: '127.0.0.1' },
    port: { env: 'DB_PORT', type: 'integer', default: 3306 },
    user: { env: 'DB_USER', type: 'string', default: 'rag' },
    password: { env: 'DB_PASSWORD', type: 'string', default: '' },
    database: { env: 'DB_NAME', type: 'string', default: 'ragqdrant' },
    poolSize: { env: 'DB_POOL_SIZE', type: 'integer', default: 5 },
    connectTimeoutMs: { env: 'DB_CONNECT_TIMEOUT_MS', type: 'integer', default: 5000 },
    // Reconnect: Wartezeit zwischen Verbindungsversuchen (Sekunden).
    retryDelaySec: { env: 'DB_RETRY_DELAY_SEC', type: 'number', default: 10 },
    // Reconnect: max. aufeinanderfolgende Fehlversuche (0 = unbegrenzt).
    maxRetries: { env: 'DB_MAX_RETRIES', type: 'integer', default: 0 },
};

/**
 * Docling-Parameter (Dokumenten-Parsing via docling-serve).
 *
 * `apiKey` ist ein Secret: der echte Wert kommt ausschließlich aus der Env
 * (`DOCLING_API_KEY`) und wird nie in config.json persistiert (siehe Passwort-Hygiene).
 */
const DOCLING_PARAMS = {
    url: { env: 'DOCLING_URL', type: 'string', default: '' },
    apiKey: { env: 'DOCLING_API_KEY', type: 'string', default: '' },
    // Status-Polling: Abstand zwischen Status-Abfragen der docling-serve-Instanz (Sekunden).
    statusPollIntervalSec: { env: 'DOCLING_STATUS_POLL_INTERVAL_SEC', type: 'integer', default: 30 },
    timeoutSec: { env: 'DOCLING_TIMEOUT_SEC', type: 'integer', default: 300 },
    maxTokens: { env: 'DOCLING_MAX_TOKENS', type: 'integer', default: 512 },
    useMarkdownTables: { env: 'DOCLING_USE_MARKDOWN_TABLES', type: 'boolean', default: true },
    useMarkdownImages: { env: 'DOCLING_USE_MARKDOWN_IMAGES', type: 'boolean', default: false },
    ocr: { env: 'DOCLING_OCR', type: 'boolean', default: true },
};

/**
 * Search-Parameter (Rerank + Zitat, config-driven).
 */
const SEARCH_PARAMS = {
    rerankEnabled: { env: 'SEARCH_RERANK_ENABLED', type: 'boolean', default: true },
    rerankBoost: { env: 'SEARCH_RERANK_BOOST', type: 'number', default: 0.05 },
    citationEnabled: { env: 'SEARCH_CITATION_ENABLED', type: 'boolean', default: true },
};

/**
 * Loads and manages server configuration from environment variables and a config.json file.
 *
 * Erbt von EventEmitter: `updateSettings()` feuert ein `change`-Event
 * (`{ changed, settings }`), damit Services (z. B. FileService) reagieren können.
 */
class Config extends EventEmitter {
    /** @type {Record<string, string | number>} */
    static defaults = {
        serverPort: 3000,
        verbose: false,
        searchTopK: 10,
        // Data-Ordner: eine Ebene über server/ (gleiche Ebene wie frontend/ und server/).
        dataDir: join(__dirname, '..', '..', 'data')
    };

    /** Keys, die ohne Neustart wirksam werden. */
    static runtimeKeys = ['verbose', 'searchTopK', 'dataDir', 'qdrant', 'embeddings', 'chat', 'vision', 'mcp', 'storage', 'docling', 'search'];

    /** Keys, die einen Neustart erfordern. */
    static restartKeys = ['serverPort'];

    constructor(env = process.env, logger) {
        super();
        this.env = env;
        this.configPath = this.resolvePath();
        this.label = '[Config]';
        this.logger = logger || { log: () => {}, error: () => {} };

        const loaded = existsSync(this.configPath) ? this.readConfigFile() : null;

        this.serverPort = parseInt(env.SERVER_PORT, 10) || loaded?.serverPort || Config.defaults.serverPort;
        this.verbose = env.VERBOSE === 'true' || loaded?.verbose || Config.defaults.verbose;
        this.searchTopK = parseInt(env.SEARCH_TOP_K, 10) || loaded?.searchTopK || Config.defaults.searchTopK;
        this.dataDir = env.DATA_DIR || loaded?.dataDir || Config.defaults.dataDir;

        // Env-gelockte Felder: key → Name der Umgebungsvariable.
        // Diese Werte sind in der UI nicht änderbar (Env hat immer Vorrang).
        this.envLocked = { root: {}, qdrant: {}, embeddings: {}, chat: {}, vision: {}, mcp: {}, storage: {}, db: {}, docling: {}, search: {} };
        if (parseInt(env.SERVER_PORT, 10)) this.envLocked.root.serverPort = 'SERVER_PORT';
        if (env.VERBOSE === 'true') this.envLocked.root.verbose = 'VERBOSE';
        if (parseInt(env.SEARCH_TOP_K, 10)) this.envLocked.root.searchTopK = 'SEARCH_TOP_K';
        if (env.DATA_DIR) this.envLocked.root.dataDir = 'DATA_DIR';

        // Parameter-Gruppen: env > config.json > Default
        this.qdrant = this.resolveParams(QDRANT_PARAMS, loaded?.qdrant, 'qdrant');
        this.embeddings = this.resolveParams(EMBEDDINGS_PARAMS, loaded?.embeddings, 'embeddings');
        this.chat = this.resolveParams(CHAT_PARAMS, loaded?.chat, 'chat');
        this.vision = this.resolveParams(VISION_PARAMS, loaded?.vision, 'vision');
        this.mcp = this.resolveParams(MCP_PARAMS, loaded?.mcp, 'mcp');
        this.storage = this.resolveParams(STORAGE_PARAMS, loaded?.storage, 'storage');
        this.db = this.resolveParams(DB_PARAMS, loaded?.db, 'db');
        this.docling = this.resolveParams(DOCLING_PARAMS, loaded?.docling, 'docling');
        this.search = this.resolveParams(SEARCH_PARAMS, loaded?.search, 'search');
    }

    /**
     * Resolves the path to the configuration file.
     * @returns {string}
     */
    resolvePath() {
        return this.env.CONFIG_PATH || join(__dirname, '..', 'config.json');
    }

    /**
     * Liest die config.json (defensive: fehlerhafte Datei → null).
     * @returns {Record<string, unknown> | null}
     */
    readConfigFile() {
        try {
            return JSON.parse(readFileSync(this.configPath, 'utf8'));
        } catch (err) {
            this.logger.error(this.label, 'config.json konnte nicht gelesen werden', { error: err.message });
            return null;
        }
    }

    /**
     * Parst einen Env-Wert gemäß Typ. Liefert undefined, wenn der Wert leer/ungültig ist.
     * @param {unknown} raw
     * @param {string} type
     * @returns {unknown}
     */
    parseEnvValue(raw, type) {
        if (raw === undefined || raw === null || raw === '') return undefined;
        switch (type) {
            case 'boolean':
                return raw === 'true' || raw === '1';
            case 'integer': {
                const n = parseInt(raw, 10);
                return Number.isNaN(n) ? undefined : n;
            }
            case 'number': {
                const n = parseFloat(raw);
                return Number.isNaN(n) ? undefined : n;
            }
            case 'array': {
                try {
                    const parsed = JSON.parse(raw);
                    return Array.isArray(parsed) ? parsed : undefined;
                } catch {
                    // Komma-getrennt → Strings (z. B. Allowed-Hosts)
                    return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
                }
            }
            case 'object': {
                try {
                    const parsed = JSON.parse(raw);
                    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
                } catch {
                    return undefined;
                }
            }
            default:
                return String(raw);
        }
    }

    /**
     * Ermittelt eine Parameter-Gruppe: env > config.json > Default.
     * @param {Record<string, {env: string, type: string, default: unknown}>} params
     * @param {Record<string, unknown> | undefined} loadedGroup
     * @param {string} group
     * @returns {Record<string, unknown>}
     */
    resolveParams(params, loadedGroup, group) {
        const out = {};
        for (const [key, spec] of Object.entries(params)) {
            const fromEnv = this.parseEnvValue(this.env[spec.env], spec.type);
            if (fromEnv !== undefined) this.envLocked[group][key] = spec.env;
            const fromFile = loadedGroup?.[key];
            out[key] =
                fromEnv !== undefined ? fromEnv
                    : fromFile !== undefined ? fromFile
                        : spec.default;
        }
        return out;
    }

    /**
     * Schreibt die Default-Konfiguration explizit (Setup-Schritt, z. B. --init-config).
     */
    saveDefaults() {
        const defaults = {
            serverPort: parseInt(this.env.SERVER_PORT, 10) || Config.defaults.serverPort,
            verbose: this.env.VERBOSE === 'true' || Config.defaults.verbose,
            searchTopK: parseInt(this.env.SEARCH_TOP_K, 10) || Config.defaults.searchTopK,
            dataDir: this.env.DATA_DIR || Config.defaults.dataDir,
            qdrant: Object.fromEntries(Object.entries(QDRANT_PARAMS).map(([key, spec]) => [key, spec.default])),
            embeddings: Object.fromEntries(Object.entries(EMBEDDINGS_PARAMS).map(([key, spec]) => [key, spec.default])),
            chat: Object.fromEntries(Object.entries(CHAT_PARAMS).map(([key, spec]) => [key, spec.default])),
            vision: Object.fromEntries(Object.entries(VISION_PARAMS).map(([key, spec]) => [key, spec.default])),
            mcp: Object.fromEntries(Object.entries(MCP_PARAMS).map(([key, spec]) => [key, spec.default])),
            storage: Object.fromEntries(Object.entries(STORAGE_PARAMS).map(([key, spec]) => [key, spec.default])),
            // Passwort-Hygiene: `password` bleibt ein leerer Platzhalter (Secret kommt nur aus der Env).
            db: Object.fromEntries(Object.entries(DB_PARAMS).map(([key, spec]) => [key, spec.default])),
            docling: Object.fromEntries(Object.entries(DOCLING_PARAMS).map(([key, spec]) => [key, spec.default])),
            search: Object.fromEntries(Object.entries(SEARCH_PARAMS).map(([key, spec]) => [key, spec.default]))
        };
        writeFileSync(this.configPath, JSON.stringify(defaults, null, 4), 'utf8');
    }

    /**
     * Liefert die aktuellen Settings für die UI.
     * @returns {Record<string, unknown>}
     */
    getSettings() {
        return {
            serverPort: this.serverPort,
            verbose: this.verbose,
            searchTopK: this.searchTopK,
            dataDir: this.dataDir,
            // Read-only: Pfad der Config-Datei (CONFIG_PATH oder Default). Nur Anzeige in der UI.
            configPath: this.configPath,
            qdrant: { ...this.qdrant },
            embeddings: { ...this.embeddings },
            chat: { ...this.chat },
            vision: { ...this.vision },
            mcp: { ...this.mcp },
            storage: { ...this.storage },
            // Passwort-Hygiene: `db.password` wird maskiert zurückgegeben, nie der Klartext.
            db: { ...this.db, password: '••••••' },
            // Secret-Hygiene: `docling.apiKey` wird maskiert zurückgegeben, nie der Klartext.
            docling: { ...this.docling, apiKey: '••••••' },
            search: { ...this.search },
            envLocked: {
                root: { ...this.envLocked.root },
                qdrant: { ...this.envLocked.qdrant },
                embeddings: { ...this.envLocked.embeddings },
                chat: { ...this.envLocked.chat },
                vision: { ...this.envLocked.vision },
                mcp: { ...this.envLocked.mcp },
                storage: { ...this.envLocked.storage },
                db: { ...this.envLocked.db },
                docling: { ...this.envLocked.docling },
                search: { ...this.envLocked.search }
            }
        };
    }

    /**
     * Validiert ein vollständiges Settings-Objekt.
     * @param {Record<string, unknown>} s
     * @returns {string[]} Fehlerliste (leer = gültig)
     */
    validateSettings(s) {
        const errors = [];
        if (!Number.isInteger(s.serverPort) || s.serverPort < 1 || s.serverPort > 65535)
            errors.push('serverPort muss eine Ganzzahl zwischen 1 und 65535 sein');
        if (typeof s.verbose !== 'boolean')
            errors.push('verbose muss ein Boolean sein');
        if (!Number.isInteger(s.searchTopK) || s.searchTopK < 1)
            errors.push('searchTopK muss eine Ganzzahl >= 1 sein');
        if (typeof s.dataDir !== 'string' || s.dataDir.trim() === '')
            errors.push('dataDir muss ein nicht-leerer String sein');

        const q = s.qdrant || {};
        if (typeof q.url !== 'string') errors.push('qdrant.url muss ein String sein');
        if (!Number.isInteger(q.port) || q.port < 1 || q.port > 65535)
            errors.push('qdrant.port muss eine Ganzzahl zwischen 1 und 65535 sein');
        if (typeof q.collection !== 'string' || q.collection.trim() === '')
            errors.push('qdrant.collection muss ein nicht-leerer String sein');
        if (typeof q.retryDelaySec !== 'number' || q.retryDelaySec < 0)
            errors.push('qdrant.retryDelaySec muss eine Zahl >= 0 sein');
        if (!Number.isInteger(q.maxRetries) || q.maxRetries < 0 || q.maxRetries > 100)
            errors.push('qdrant.maxRetries muss eine Ganzzahl zwischen 0 und 100 sein');

        const e = s.embeddings || {};
        if (typeof e.api !== 'string' || !['openai', 'ollama'].includes(e.api))
            errors.push('embeddings.api muss "openai" oder "ollama" sein');
        if (typeof e.url !== 'string') errors.push('embeddings.url muss ein String sein');
        if (typeof e.host !== 'string') errors.push('embeddings.host muss ein String sein');
        if (typeof e.model !== 'string') errors.push('embeddings.model muss ein String sein');

        const c = s.chat || {};
        if (typeof c.api !== 'string' || !['openai', 'ollama'].includes(c.api))
            errors.push('chat.api muss "openai" oder "ollama" sein');
        if (typeof c.url !== 'string') errors.push('chat.url muss ein String sein');
        if (typeof c.model !== 'string') errors.push('chat.model muss ein String sein');
        if (typeof c.systemPrompt !== 'string') errors.push('chat.systemPrompt muss ein String sein');

        const v = s.vision || {};
        if (typeof v.api !== 'string' || !['openai', 'ollama'].includes(v.api))
            errors.push('vision.api muss "openai" oder "ollama" sein');
        if (typeof v.url !== 'string') errors.push('vision.url muss ein String sein');
        if (typeof v.model !== 'string') errors.push('vision.model muss ein String sein');

        const m = s.mcp || {};
        if (typeof m.enabled !== 'boolean') errors.push('mcp.enabled muss ein Boolean sein');
        if (typeof m.path !== 'string' || !m.path.startsWith('/'))
            errors.push('mcp.path muss ein String mit führendem "/" sein');
        if (!Array.isArray(m.allowedHosts) || m.allowedHosts.some((h) => typeof h !== 'string'))
            errors.push('mcp.allowedHosts muss ein Array aus Strings sein');

        const st = s.storage || {};
        if (typeof st.enabled !== 'boolean') errors.push('storage.enabled muss ein Boolean sein');
        if (typeof st.processor !== 'string' || !['docling', 'dummy'].includes(st.processor))
            errors.push('storage.processor muss "docling" oder "dummy" sein');
        if (typeof st.root !== 'string' || st.root.trim() === '')
            errors.push('storage.root muss ein nicht-leerer String sein');
        if (!Number.isInteger(st.concurrency) || st.concurrency < 1 || st.concurrency > 16)
            errors.push('storage.concurrency muss eine Ganzzahl zwischen 1 und 16 sein');
        if (typeof st.dummyDelaySec !== 'number' || st.dummyDelaySec < 0)
            errors.push('storage.dummyDelaySec muss eine Zahl >= 0 sein');
        if (typeof st.retryDelaySec !== 'number' || st.retryDelaySec < 0)
            errors.push('storage.retryDelaySec muss eine Zahl >= 0 sein');
        if (!Number.isInteger(st.maxRetries) || st.maxRetries < 0 || st.maxRetries > 10)
            errors.push('storage.maxRetries muss eine Ganzzahl zwischen 0 und 10 sein');
        if (typeof st.maxFileSizeMb !== 'number' || st.maxFileSizeMb <= 0)
            errors.push('storage.maxFileSizeMb muss eine Zahl > 0 sein');
        if (!Array.isArray(st.ignore) || st.ignore.some((p) => typeof p !== 'string'))
            errors.push('storage.ignore muss ein Array aus Strings sein');
        if (!Array.isArray(st.whitelist) || st.whitelist.some((p) => typeof p !== 'string'))
            errors.push('storage.whitelist muss ein Array aus Strings sein');

        const d = s.db || {};
        if (typeof d.host !== 'string' || d.host.trim() === '')
            errors.push('db.host muss ein nicht-leerer String sein');
        if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535)
            errors.push('db.port muss eine Ganzzahl zwischen 1 und 65535 sein');
        if (typeof d.user !== 'string' || d.user.trim() === '')
            errors.push('db.user muss ein nicht-leerer String sein');
        if (typeof d.password !== 'string')
            errors.push('db.password muss ein String sein');
        if (typeof d.database !== 'string' || d.database.trim() === '')
            errors.push('db.database muss ein nicht-leerer String sein');
        if (!Number.isInteger(d.poolSize) || d.poolSize < 1 || d.poolSize > 50)
            errors.push('db.poolSize muss eine Ganzzahl zwischen 1 und 50 sein');
        if (!Number.isInteger(d.connectTimeoutMs) || d.connectTimeoutMs <= 0)
            errors.push('db.connectTimeoutMs muss eine Ganzzahl > 0 sein');
        if (typeof d.retryDelaySec !== 'number' || d.retryDelaySec < 0)
            errors.push('db.retryDelaySec muss eine Zahl >= 0 sein');
        if (!Number.isInteger(d.maxRetries) || d.maxRetries < 0 || d.maxRetries > 100)
            errors.push('db.maxRetries muss eine Ganzzahl zwischen 0 und 100 sein');

        const dl = s.docling || {};
        if (typeof dl.url !== 'string') errors.push('docling.url muss ein String sein');
        if (typeof dl.apiKey !== 'string') errors.push('docling.apiKey muss ein String sein');
        if (!Number.isInteger(dl.statusPollIntervalSec) || dl.statusPollIntervalSec < 1)
            errors.push('docling.statusPollIntervalSec muss eine Ganzzahl >= 1 sein');
        if (!Number.isInteger(dl.timeoutSec) || dl.timeoutSec < 1)
            errors.push('docling.timeoutSec muss eine Ganzzahl >= 1 sein');
        if (!Number.isInteger(dl.maxTokens) || dl.maxTokens < 0)
            errors.push('docling.maxTokens muss eine Ganzzahl >= 0 sein');
        if (typeof dl.useMarkdownTables !== 'boolean')
            errors.push('docling.useMarkdownTables muss ein Boolean sein');
        if (typeof dl.useMarkdownImages !== 'boolean')
            errors.push('docling.useMarkdownImages muss ein Boolean sein');
        if (typeof dl.ocr !== 'boolean')
            errors.push('docling.ocr muss ein Boolean sein');

        const se = s.search || {};
        if (typeof se.rerankEnabled !== 'boolean')
            errors.push('search.rerankEnabled muss ein Boolean sein');
        if (typeof se.rerankBoost !== 'number' || se.rerankBoost < 0)
            errors.push('search.rerankBoost muss eine Zahl >= 0 sein');
        if (typeof se.citationEnabled !== 'boolean')
            errors.push('search.citationEnabled muss ein Boolean sein');

        return errors;
    }

    /**
     * Entfernt Env-gelockte Keys aus einem Patch-Objekt (Env hat immer Vorrang).
     * @param {Record<string, unknown> | undefined} obj
     * @param {string} group
     * @returns {Record<string, unknown>}
     */
    stripEnvLocked(obj, group) {
        if (!obj || typeof obj !== 'object') return {};
        const locked = this.envLocked[group] || {};
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            if (Object.prototype.hasOwnProperty.call(locked, k)) continue;
            out[k] = v;
        }
        return out;
    }

    /**
     * Wendet einen Partial-Patch an: validieren → mergen → persistieren → klassifizieren.
     * Env-gelockte Felder werden ignoriert (Env hat immer Vorrang).
     * @param {Record<string, unknown>} patch
     * @returns {{ applied: string[], restartRequired: string[] }}
     */
    updateSettings(patch) {
        const current = this.getSettings();

        // Env-gelockte Keys aus dem Patch entfernen (UI sendet ggf. komplette Drafts).
        const p = { ...patch };
        // configPath ist read-only (nur per CONFIG_PATH-Env änderbar) → immer verwerfen.
        delete p.configPath;
        for (const k of Object.keys(this.envLocked.root)) delete p[k];
        p.qdrant = this.stripEnvLocked(patch.qdrant, 'qdrant');
        p.embeddings = this.stripEnvLocked(patch.embeddings, 'embeddings');
        p.chat = this.stripEnvLocked(patch.chat, 'chat');
        p.vision = this.stripEnvLocked(patch.vision, 'vision');
        p.mcp = this.stripEnvLocked(patch.mcp, 'mcp');
        p.storage = this.stripEnvLocked(patch.storage, 'storage');
        p.db = this.stripEnvLocked(patch.db, 'db');
        p.docling = this.stripEnvLocked(patch.docling, 'docling');
        p.search = this.stripEnvLocked(patch.search, 'search');
        // Passwort-Hygiene: leerer oder maskierter Passwort-Wert = "unverändert"
        // (der echte Wert kommt ausschließlich aus der Env, nie aus der UI).
        if (p.db && (p.db.password === '' || p.db.password === '••••••')) delete p.db.password;
        // Secret-Hygiene: leerer oder maskierter API-Key = "unverändert"
        // (der echte Wert kommt ausschließlich aus der Env, nie aus der UI).
        if (p.docling && (p.docling.apiKey === '' || p.docling.apiKey === '••••••')) delete p.docling.apiKey;

        // Deep-Merge für die verschachtelten Objekte
        const next = {
            ...current,
            ...p,
            qdrant: { ...current.qdrant, ...(p.qdrant || {}) },
            embeddings: { ...current.embeddings, ...(p.embeddings || {}) },
            chat: { ...current.chat, ...(p.chat || {}) },
            vision: { ...current.vision, ...(p.vision || {}) },
            mcp: { ...current.mcp, ...(p.mcp || {}) },
            storage: { ...current.storage, ...(p.storage || {}) },
            db: { ...current.db, ...(p.db || {}) },
            docling: { ...current.docling, ...(p.docling || {}) },
            search: { ...current.search, ...(p.search || {}) }
        };

        const errors = this.validateSettings(next);
        if (errors.length > 0) {
            const err = new Error(errors.join('; '));
            err.status = 400;
            err.code = 'invalid_settings';
            throw err;
        }

        // Runtime-State aktualisieren
        this.serverPort = next.serverPort;
        this.verbose = next.verbose;
        this.searchTopK = next.searchTopK;
        this.dataDir = next.dataDir;
        this.qdrant = { ...next.qdrant };
        this.embeddings = { ...next.embeddings };
        this.chat = { ...next.chat };
        this.vision = { ...next.vision };
        this.mcp = { ...next.mcp };
        this.storage = { ...next.storage };
        // Passwort-Hygiene: der echte Passwort-Wert (aus der Env) bleibt erhalten;
        // der maskierte UI-Wert darf den Runtime-State nicht überschreiben.
        this.db = { ...next.db, password: this.db.password };
        // Secret-Hygiene: der echte API-Key (aus der Env) bleibt erhalten;
        // der maskierte UI-Wert darf den Runtime-State nicht überschreiben.
        this.docling = { ...next.docling, apiKey: this.docling.apiKey };
        this.search = { ...next.search };

        // Persistieren (config.json)
        this.persist();

        const changed = Object.keys(p).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]));

        // Change-Event für Services (z. B. FileService → Watcher neu starten).
        this.emit('change', { changed, settings: this.getSettings() });

        return {
            applied: changed.filter((k) => Config.runtimeKeys.includes(k)),
            restartRequired: changed.filter((k) => Config.restartKeys.includes(k))
        };
    }

    /** Schreibt die aktuellen Settings nach config.json. */
    persist() {
        writeFileSync(
            this.configPath,
            JSON.stringify(
                {
                    serverPort: this.serverPort,
                    verbose: this.verbose,
                    searchTopK: this.searchTopK,
                    dataDir: this.dataDir,
                    qdrant: this.qdrant,
                    embeddings: this.embeddings,
                    chat: this.chat,
                    vision: this.vision,
                    mcp: this.mcp,
                    storage: this.storage,
                    // Passwort-Hygiene: das echte Passwort (aus der Env) wird nie persistiert.
                    db: { ...this.db, password: '' },
                    // Secret-Hygiene: der echte API-Key (aus der Env) wird nie persistiert.
                    docling: { ...this.docling, apiKey: '' },
                    search: this.search
                },
                null,
                4
            ),
            'utf8'
        );
    }
}

export { Config, QDRANT_PARAMS, EMBEDDINGS_PARAMS, CHAT_PARAMS, VISION_PARAMS, MCP_PARAMS, STORAGE_PARAMS, DB_PARAMS, DOCLING_PARAMS, SEARCH_PARAMS };
