import axios from 'axios';
import { LlmService } from './LlmService.js';
import { sha256Hex } from '../Utils/hash.js';

/**
 * Embeddings service for generating vectors via Ollama or OpenAI-compatible APIs.
 */
class EmbeddingsService extends LlmService {
    /**
     * @param {object} [params] - Configuration parameters
     * @param {string} [params.api='ollama'] - Embedding API backend (openai/ollama)
     * @param {string} [params.url=''] - Embedding server base URL
     * @param {string} [params.model=''] - Embedding model name
     * @param {string} [params.host=''] - Host header override
     * @param {Logger} [params.logger] - Logger instance
     */
    constructor({ api = 'ollama', url = '', model = '', host = '', logger } = {}) {
        super({ api, url, model, host, label: '[Embed]', logger });
        // Cache for embeddings keyed by SHA-256 of the chunk text.
        // Avoids redundant LLM calls when identical chunks are re-synced within a session/process.
        this._embeddingCache = new Map();
    }

    /**
     * Generates an embedding vector for the given text.
     * @param {string} text - The text to embed
     * @returns {Promise<number[]>} The embedding vector
     */
    async embed(text) {
        // Return cached embedding for identical chunk text, avoiding redundant LLM calls.
        const key = sha256Hex(text);
        if (this._embeddingCache.has(key)) return this._embeddingCache.get(key);

        let vector;

        try {
            const cfg = this.config;
            const base = cfg.baseUrl;
            const headers = cfg.hostHeader ? { Host: cfg.hostHeader } : undefined;

            if (cfg.api === 'openai') {
                const res = await axios.post(`${base}/embeddings`, {
                    model: cfg.modelName,
                    input: text
                }, { headers });
                const body = res.data;
                if (Array.isArray(body.data)) {
                    vector = body.data[0].embedding;
                } else {
                    throw new Error('Unrecognized OpenAI embedding response shape');
                }
            } else {
                const res = await axios.post(`${base}/api/embed`, {
                    model: cfg.modelName,
                    input: text
                }, { headers });
                const body = res.data;
                if (Array.isArray(body.embeddings)) {
                    vector = body.embeddings[0];
                } else if (Array.isArray(body.embedding)) {
                    vector = body.embedding;
                } else {
                    throw new Error('Unrecognized Ollama embedding response shape');
                }
            }

            if (vector === undefined) {
                throw new Error('Unrecognized embedding response shape');
            }

            this._embeddingCache.set(key, vector);
            return vector;
        } catch (error) {
            this.logger.error(this.label, `Failed to generate embedding for chunk:`, error);
            throw error;
        }
    }
}

export { EmbeddingsService };
