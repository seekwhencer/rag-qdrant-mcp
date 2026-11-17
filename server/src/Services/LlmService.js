import { normalizeUrl } from '../Utils/url.js';
import { noopLogger } from '../Utils/logger.js';

/**
 * Base class for LLM-backed services (embeddings, chat).
 * Normalizes the shared endpoint config (api, url, model, host) and provides logging.
 */
class LlmService {
    /**
     * @param {object} [params] - Configuration parameters
     * @param {string} [params.api='ollama'] - API backend (ollama/openai)
     * @param {string} [params.url=''] - Server base URL
     * @param {string} [params.model=''] - Model name
     * @param {string} [params.host=''] - Host header override
     * @param {string} [params.label='[Llm]'] - Log label
     * @param {Logger} [params.logger] - Logger instance
     */
    constructor({ api = 'ollama', url = '', model = '', host = '', label = '[Llm]', logger } = {}) {
        this.config = {
            api: (api === 'openai') ? 'openai' : 'ollama',
            baseUrl: normalizeUrl(url),
            modelName: model,
            hostHeader: host
        };
        this.label = label;
        this.logger = logger || noopLogger();
    }
}

export { LlmService };
