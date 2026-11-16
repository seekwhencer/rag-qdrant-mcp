import axios from 'axios';
import { normalizeUrl } from '../Utils/url.js';
import { readSSE, readNDJSON } from '../Utils/stream.js';
import { sha256Hex } from '../Utils/hash.js';
import { noopLogger } from '../Utils/logger.js';

/**
 * LLM service for generating embeddings and chat completions via Ollama or OpenAI-compatible APIs.
 */
class LlmService {
    /**
     * @param {object} [params] - Configuration parameters
     * @param {string} [params.embeddingsApi='ollama'] - Embedding API backend
     * @param {string} [params.embeddingsUrl=''] - Embedding server base URL
     * @param {string} [params.embeddingsModel=''] - Embedding model name
     * @param {string} [params.chatApi='ollama'] - Chat API backend
     * @param {string} [params.chatUrl=''] - Chat server base URL
     * @param {string} [params.chatModel=''] - Chat model name
     * @param {Logger} [params.logger] - Logger instance
     */
    constructor({
        embeddingsApi = 'ollama',
        embeddingsUrl = '',
        embeddingsModel = '',
        embeddingsHost = '',
        chatApi = 'ollama',
        chatUrl = '',
        chatModel = '',
        logger
    } = {}) {
        this.embeddingsConfig = {
            api: (embeddingsApi === 'openai') ? 'openai' : 'ollama',
            baseUrl: normalizeUrl(embeddingsUrl),
            modelName: embeddingsModel,
            hostHeader: embeddingsHost
        };
        this.chatConfig = {
            api: (chatApi === 'openai') ? 'openai' : 'ollama',
            baseUrl: normalizeUrl(chatUrl),
            modelName: chatModel
        };

        // Cache for embeddings keyed by SHA-256 of the chunk text.
        // Avoids redundant LLM calls when identical chunks are re-synced within a session/process.
        this._embeddingCache = new Map();
        this.label = '[Embed]';
        this.logger = logger || noopLogger();
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
            const cfg = this.embeddingsConfig;
            const base = normalizeUrl(cfg.baseUrl);
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
            this.logger.error(this.label,`Failed to generate embedding for chunk:`, error);
            throw error;
        }
    }

    /**
     * Sends a chat request and returns the full response text.
     * @param {Array<object>} messages - Array of chat messages
     * @param {object} [options={}] - Additional options (e.g. model, temperature)
     * @returns {Promise<string>} The assistant's response text
     */
    async chat(messages, options = {}) {
        const cfg = this.chatConfig;
        const base = normalizeUrl(cfg.baseUrl);

        if (cfg.api === 'openai') {
            const res = await axios.post(`${base}/chat/completions`, {
                model: options.model || cfg.modelName,
                messages: messages,
                ...options
            });

            this.logger.log(this.label, 'CHOICES', res.data.choices);

            return res.data.choices[0].message.content;
        }

        const res = await axios.post(`${base}/api/chat`, {
            model: options.model || cfg.modelName,
            messages: messages,
            stream: false,
            ...options
        });
        return res.data.message.content;
    }

    /**
     * Streams chat completions and yields raw chunk objects.
     * @param {Array<object>} messages - Array of chat messages
     * @param {object} [options={}] - Additional options
     * @yields {object} Raw streaming chunks
     */
    async *streamChunks(messages, options = {}) {
        const cfg = this.chatConfig;
        const base = normalizeUrl(cfg.baseUrl);
        const { signal, ...llmOptions } = options;

        const payload = {
            model: llmOptions.model || cfg.modelName,
            messages,
            stream: true,
            ...llmOptions
        };

        const url = (cfg.api === 'openai') ? `${base}/chat/completions` : `${base}/api/chat`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal
        });

        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Chat-Streaming fehlgeschlagen: ${res.status} ${detail}`.trim());
        }
        if (!res.body) throw new Error('Chat-Streaming fehlgeschlagen: keine Response-Body');

        yield* (cfg.api === 'openai') ? readSSE(res.body) : readNDJSON(res.body);
    }

    /**
     * Streams chat completions and yields structured { phase, token } objects.
     * @param {Array<object>} messages - Array of chat messages
     * @param {object} [options={}] - Additional options
     * @yields {object} Objects with phase ('thinking' | 'answer') and token
     */
    async *streamChat(messages, options = {}) {
        for await (const chunk of this.streamChunks(messages, options)) {
            if (this.chatConfig.api === 'openai') {
                const delta = chunk.choices?.[0]?.delta || {};
                const reasoning = delta.reasoning_content ?? delta.thinking ?? '';
                if (reasoning) yield { phase: 'thinking', token: reasoning };
                if (delta.content) yield { phase: 'answer', token: delta.content };
            } else {
                const msg = chunk.message || {};
                const reasoning = chunk.thinking ?? msg.thinking ?? '';
                if (reasoning) yield { phase: 'thinking', token: reasoning };
                if (msg.content) yield { phase: 'answer', token: msg.content };
            }
        }
    }
}

export { LlmService };
