import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

/**
 * MCP service that registers tools for asking questions and searching.
 */
class McpService {
    /**
     * @param {object} params - Service dependencies
     * @param {Search} params.search - Search service
     * @param {Logger} [params.logger] - Logger instance
     */
    constructor({ search, logger }) {
        this.search = search;
        this.mcpServer = null;
        this.label = '[MCP]';
        this.logger = logger || { log: () => {}, error: () => {} };
    }

    /**
     * Initializes the MCP service.
     * @returns {Promise<void>}
     */
    init() {
        this.logger.log(this.label, 'Service initialized (v2 class pattern)');
        return Promise.resolve();
    }

    /**
     * Shuts down the MCP service.
     * @returns {Promise<void>}
     */
    shutdown() {
        this.mcpServer = null;
        return Promise.resolve();
    }

    /**
     * Creates and configures an MCP server with the ask and search tools.
     * @returns {McpServer}
     */
    createServer() {
        this.mcpServer = new McpServer({
            name: 'rag-qdrant-mcp',
            version: '1.0.0'
        });

        this.mcpServer.registerTool(
            'ask',
            {
                description: 'Beantwortet eine Frage auf Basis der in Qdrant indexierten Dokumente (RAG). Nutzt Vektorsuche in Qdrant + LLM-Antwort.',
                inputSchema: z.object({
                    question: z.string().describe('Die Frage, die beantwortet werden soll')
                })
            },
            async ({ question }) => {
                const answer = await this.search.searchAndAnswer(question);
                if (answer === undefined) {
                    return {
                        content: [{ type: 'text', text: 'Keine Antwort gefunden. Vielleicht ist das Thema noch nicht indexiert.' }],
                        isError: false
                    };
                }
                return { content: [{ type: 'text', text: answer }] };
            }
        );

        this.mcpServer.registerTool(
            'search',
            {
                description: 'Durchsucht die in Qdrant indexierten Dokumente mit Vektorsuche. Gibt rohe Treffer ohne LLM zurück.',
                inputSchema: z.object({
                    question: z.string().describe('Die Suchanfrage')
                })
            },
            async ({ question }) => {
                const chunks = await this.search.searchAndReturnChunks(question);
                if (chunks.length === 0) {
                    return {
                        content: [{ type: 'text', text: 'Keine Ergebnisse gefunden. Vielleicht ist das Thema noch nicht indexiert.' }],
                        isError: false
                    };
                }
                return { content: [{ type: 'text', text: JSON.stringify(chunks, null, 2) }] };
            }
        );

        return this.mcpServer;
    }
}

export { McpService };
