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
     * @param {boolean} [params.rerankEnabled=true] - Enable heuristic reranking (config-driven)
     * @param {number} [params.rerankBoost=0.05] - Boost factor for reranking (config-driven)
     * @param {boolean} [params.citationEnabled=true] - Enable citations (config-driven)
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
        rerankEnabled = true,
        rerankBoost = 0.05,
        citationEnabled = true,
        logger
    } = {}) {
        this.qdrantCollection = qdrantCollection;
        this.topK = topK;
        this.rerankEnabled = rerankEnabled;
        this.rerankBoost = rerankBoost;
        this.citationEnabled = citationEnabled;
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
     * @param {object} cfg - { topK, systemPrompt, rerankEnabled, rerankBoost, citationEnabled }
     */
    updateConfig(cfg = {}) {
        if (cfg.topK !== undefined) this.topK = cfg.topK;
        if (cfg.systemPrompt !== undefined) this.systemPrompt = cfg.systemPrompt;
        if (cfg.rerankEnabled !== undefined) this.rerankEnabled = cfg.rerankEnabled;
        if (cfg.rerankBoost !== undefined) this.rerankBoost = cfg.rerankBoost;
        if (cfg.citationEnabled !== undefined) this.citationEnabled = cfg.citationEnabled;
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
            let results = await this.qdrant.search(queryVector, this.topK);

            if (!results || results.length === 0) {
                this.logger.log(this.label, 'No matching documents found.');
                return;
            }

            results = this.rerank(results, question);   // no-op wenn rerankEnabled=false

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

            // Quellen ANHÄNGEN (wenn citationEnabled)
            if (this.citationEnabled) {
                const citations = results.map((item) => this.buildCitation(item.payload)).filter(Boolean);
                if (citations.length) {
                    return `${answer}\n\nQuellen:\n${citations.map((c) => `- ${c}`).join('\n')}`;
                }
            }
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
     * @yields {object} Event objects with type ('status' | 'thinking' | 'answer' | 'empty' | 'citations' | 'done')
     */
    async *streamAndAnswer(question, { signal } = {}) {
        yield { type: 'status', phase: 'embedding', message: 'Embedding wird erzeugt…' };
        const queryVector = await this.embeddings.embed(question);

        yield { type: 'status', phase: 'search', message: 'Durchsuche Dokumente…' };
        let results = await this.qdrant.search(queryVector, this.topK);

        if (!results || results.length === 0) {
            yield { type: 'empty' };
            return;
        }

        results = this.rerank(results, question);   // no-op wenn rerankEnabled=false

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

        // Quellen ANHÄNGEN (wenn citationEnabled)
        if (this.citationEnabled) {
            const citations = results.map((item) => this.buildCitation(item.payload)).filter(Boolean);
            if (citations.length) {
                yield { type: 'citations', text: `Quellen:\n${citations.map((c) => `- ${c}`).join('\n')}` };
            }
        }

        yield { type: 'done' };
    }

    /**
     * Baut ein Qdrant-Filter-Objekt aus optionalen Such-Optionen.
     * @param {{source?: string, heading?: string, page?: number}} opts
     * @returns {object|null} Qdrant-Filter oder null (keine Filter)
     */
    buildFilter({ source, heading, page } = {}) {
        const must = [];
        if (source) must.push({ key: 'source', match: { value: source } });
        if (heading) must.push({ key: 'headings', match: { value: heading } });
        if (page != null) must.push({ key: 'page_numbers', match: { value: page } });
        return must.length ? { must } : null;
    }

    /**
     * Heuristischer Rerank: boostet Chunks, deren headings/captions
     * Query-Keywords enthalten. Config-gesteuert (rerankEnabled, rerankBoost).
     * @param {Array<object>} results - Qdrant-Punkte ({ score, payload })
     * @param {string} question - Suchanfrage
     * @returns {Array<object>} neu sortierte Punkte
     */
    rerank(results, question) {
        if (!this.rerankEnabled) return results;
        const keywords = this.extractKeywords(question);
        if (!keywords.length) return results;
        const scored = results.map((item) => {
            const p = item.payload || {};
            let boost = 0;
            for (const h of p.headings || []) {
                const hl = String(h).toLowerCase();
                if (keywords.some((k) => hl === k)) boost += 2;
                else if (keywords.some((k) => hl.includes(k))) boost += 1;
            }
            for (const c of p.captions || []) {
                if (keywords.some((k) => String(c).toLowerCase().includes(k))) boost += 1;
            }
            return { ...item, score: (item.score || 0) + boost * this.rerankBoost };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored;
    }

    /**
     * Extrahiert relevante Keywords aus der Frage (Stopwords raus, min. 3 Zeichen).
     * @param {string} question
     * @returns {string[]}
     */
    extractKeywords(question) {
        const stop = new Set(['der','die','das','und','oder','in','auf','für','mit','wie','was','ist','sind','steht','über','eine','einen','einem']);
        return String(question).toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .filter((w) => w.length >= 3 && !stop.has(w));
    }

    /**
     * Zitat-Zeile aus Chunk-Metadaten.
     * Beispiel: "report.pdf · S. 12 · Kapitel 3"
     * @param {object} payload
     * @returns {string}
     */
    buildCitation(payload = {}) {
        const parts = [];
        if (payload.path) parts.push(payload.path);
        if (Array.isArray(payload.page_numbers) && payload.page_numbers.length) {
            parts.push(`S. ${payload.page_numbers.join(', ')}`);
        }
        if (Array.isArray(payload.headings) && payload.headings.length) {
            parts.push(payload.headings[payload.headings.length - 1]);
        }
        return parts.join(' · ');
    }

    /**
     * Performs semantic search in Qdrant and returns raw results with metadata.
     * @param {string} question - The search query
     * @param {{source?: string, heading?: string, page?: number}} [opts] - Optional filter options
     * @returns {Promise<Array<{text: string, score: number, citation?: string, metadata: object}>>} Array of results
     */
    async searchAndReturnChunks(question, { source, heading, page } = {}) {
        try {
            this.logger.log(this.label,`Generating embedding for: "${question}"...`);
            const queryVector = await this.embeddings.embed(question);

            const filter = this.buildFilter({ source, heading, page });

            this.logger.log(this.label, 'Searching in Qdrant...');
            let results = await this.qdrant.search(queryVector, this.topK, filter);

            if (!results || results.length === 0) {
                this.logger.log(this.label, 'No matching documents found.');
                return [];
            }

            results = this.rerank(results, question);   // no-op wenn rerankEnabled=false

            const chunks = results.map(item => ({
                text: item.payload?.text || '',
                score: item.score || 0,
                ...(this.citationEnabled ? { citation: this.buildCitation(item.payload) } : {}),
                metadata: {
                    path: item.payload?.path || '',
                    headings: item.payload?.headings || [],
                    page_numbers: item.payload?.page_numbers || [],
                    chunk_index: item.payload?.chunk_index ?? null,
                    captions: item.payload?.captions || []
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
