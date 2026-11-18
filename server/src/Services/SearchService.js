import { QdrantService } from './QdrantService.js';
import { EmbeddingsService } from './EmbeddingsService.js';
import { ChatService } from './ChatService.js';
import { Config } from '../Config.js';
import { noopLogger } from '../Utils/logger.js';

/**
 * Performs semantic search on vectors stored in Qdrant and generates LLM-based answers (RAG).
 */
class SearchService {
    /**
     * @param {object} params - Configuration parameters
     * @param {QdrantService} [params.qdrant] - Qdrant client instance
     * @param {EmbeddingsService} [params.embeddings] - Embeddings service instance
     * @param {ChatService} [params.chat] - Chat service instance
     * @param {string} [params.qdrantUrl] - Qdrant server URL
     * @param {number} [params.qdrantPort] - Qdrant port
     * @param {string} [params.qdrantCollection] - Qdrant collection name
     * @param {string} [params.embeddingsApi] - Embedding API (ollama/openai)
     * @param {string} [params.embeddingsUrl] - Embedding server URL
     * @param {string} [params.embeddingsModel] - Embedding model name
     * @param {string} [params.chatApi] - Chat API (ollama/openai)
     * @param {string} [params.chatUrl] - Chat server URL
     * @param {string} [params.chatModel] - Chat model name
     * @param {string} [params.systemPrompt] - System prompt for the LLM
     * @param {number} [params.topK=20] - Number of returned results
     * @param {Logger} [params.logger] - Logger instance
     */
    constructor({
        qdrant,
        embeddings,
        chat,
        qdrantUrl,
        qdrantPort,
        qdrantCollection,
        embeddingsApi,
        embeddingsUrl,
        embeddingsModel,
        embeddingsHost,
        chatApi,
        chatUrl,
        chatModel,
        systemPrompt,
        topK = 10,
        logger
    } = {}) {
        this.qdrantCollection = qdrantCollection;
        this.topK = topK;
        this.systemPrompt = systemPrompt || new Config().chat.systemPrompt;
        this.label = '[SearchService]';
        this.logger = logger || noopLogger();
        this.qdrant = qdrant || new QdrantService({ url: qdrantUrl, port: qdrantPort, collection: qdrantCollection, logger: this.logger });
        this.embeddings = embeddings || new EmbeddingsService({
            api: embeddingsApi, url: embeddingsUrl, model: embeddingsModel, host: embeddingsHost,
            logger: this.logger
        });
        this.chat = chat || new ChatService({
            api: chatApi, url: chatUrl, model: chatModel,
            logger: this.logger
        });
    }

    /**
     * Aktualisiert die Runtime-Konfiguration (z. B. nach einer Settings-Änderung).
     * @param {object} cfg - { topK, systemPrompt }
     */
    updateConfig(cfg = {}) {
        if (cfg.topK !== undefined) this.topK = cfg.topK;
        if (cfg.systemPrompt !== undefined) this.systemPrompt = cfg.systemPrompt;
    }

    /**
     * Generates an embedding vector for the question, searches in Qdrant, and has the LLM generate an answer.
     * @param {string} question - The search query
     * @returns {Promise<string|undefined>} The generated answer or undefined
     */
    async searchAndAnswer(question) {
        try {
            this.logger.log(this.label,`Generating embedding for: "${question}"...`);
            const queryVector = await this.embeddings.embed(question);

            this.logger.log(this.label, 'query vector:', queryVector, this.topK);

            this.logger.log(this.label, 'Searching in Qdrant...');
            const results = await this.qdrant.search(queryVector, this.topK);

            if (!results || results.length === 0) {
                this.logger.log(this.label, 'No matching documents found.');
                return;
            }

            const contextTexts = results
                .map(item => item.payload?.text)
                .filter(Boolean);

            const context = contextTexts.join('\n\n---\n\n');

            this.logger.log(this.label,`Found ${results.length} relevant documents. Generating answer...`);

            const messages = [
                {
                    role: 'system',
                    content: `${this.systemPrompt}\n\n${context}`
                },
                {
                    role: 'user',
                    content: question
                }
            ];

            const answer = await this.chat.chat(messages);

            this.logger.log(this.label, '\n--- ANSWER ---');
            this.logger.log(this.label,answer);
            this.logger.log(this.label, '---------------\n');

            return answer;
        } catch (err) {
            this.logger.error(this.label, '[Error]', err);
        }
    }

    /**
     * Streaming version of searchAndAnswer: yields status, thinking, and answer events.
     * @param {string} question - The search query
     * @param {object} [options] - Optional parameters
     * @param {AbortSignal} [options.signal] - AbortSignal to cancel the stream
     * @yields {object} Event objects with type ('status' | 'thinking' | 'answer' | 'empty' | 'done')
     */
    async *streamAndAnswer(question, { signal } = {}) {
        yield { type: 'status', phase: 'embedding', message: 'Embedding wird erzeugt…' };
        const queryVector = await this.embeddings.embed(question);

        yield { type: 'status', phase: 'search', message: 'Durchsuche Dokumente…' };
        const results = await this.qdrant.search(queryVector, this.topK);

        if (!results || results.length === 0) {
            yield { type: 'empty' };
            return;
        }

        const context = results
            .map(item => item.payload?.text)
            .filter(Boolean)
            .join('\n\n---\n\n');

        const messages = [
            {
                role: 'system',
                content: `${this.systemPrompt}\n\n${context}`
            },
            {
                role: 'user',
                content: question
            }
        ];

        yield { type: 'status', phase: 'thinking', message: 'Modell denkt…' };
        for await (const { phase, token } of this.chat.streamChat(messages, { signal })) {
            yield { type: phase, token };
        }
        yield { type: 'done' };
    }

    /**
     * Performs semantic search in Qdrant and returns raw results with metadata.
     * @param {string} question - The search query
     * @returns {Promise<Array<{text: string, score: number, metadata: object}>>} Array of results
     */
    async searchAndReturnChunks(question) {
        try {
            this.logger.log(this.label,`Generating embedding for: "${question}"...`);
            const queryVector = await this.embeddings.embed(question);

            this.logger.log(this.label, 'Searching in Qdrant...');
            const results = await this.qdrant.search(queryVector, this.topK);

            if (!results || results.length === 0) {
                this.logger.log(this.label, 'No matching documents found.');
                return [];
            }

            const chunks = results.map(item => ({
                text: item.payload?.text || '',
                score: item.score || 0,
                metadata: {
                    path: item.payload?.path || ''
                }
            }));

            this.logger.log(this.label,`Found ${chunks.length} relevant documents.`);
            return chunks;
        } catch (err) {
            this.logger.error(this.label, '[Error]', err);
            return [];
        }
    }
}

export { SearchService };
