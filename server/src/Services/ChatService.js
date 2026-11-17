import axios from 'axios';
import { LlmService } from './LlmService.js';
import { readSSE, readNDJSON } from '../Utils/stream.js';

/**
 * Chat service for completions via Ollama or OpenAI-compatible APIs.
 */
class ChatService extends LlmService {
    /**
     * @param {object} [params] - Configuration parameters
     * @param {string} [params.api='ollama'] - Chat API backend (openai/ollama)
     * @param {string} [params.url=''] - Chat server base URL
     * @param {string} [params.model=''] - Chat model name
     * @param {Logger} [params.logger] - Logger instance
     */
    constructor({ api = 'ollama', url = '', model = '', logger } = {}) {
        super({ api, url, model, label: '[Chat]', logger });
    }

    /**
     * Sends a chat request and returns the full response text.
     * @param {Array<object>} messages - Array of chat messages
     * @param {object} [options={}] - Additional options (e.g. model, temperature)
     * @returns {Promise<string>} The assistant's response text
     */
    async chat(messages, options = {}) {
        const cfg = this.config;
        const base = cfg.baseUrl;

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
        const cfg = this.config;
        const base = cfg.baseUrl;
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
            if (this.config.api === 'openai') {
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

export { ChatService };
