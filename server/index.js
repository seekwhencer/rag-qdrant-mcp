import { DoclingService } from './src/Services/DoclingService.js';
import { Config } from './src/Config.js';
import { Logger } from './src/Logger.js';
import { Server } from './src/Server.js';
import { SearchService } from './src/Services/SearchService.js';
import { QdrantService } from './src/Services/QdrantService.js';
import { EmbeddingsService } from './src/Services/EmbeddingsService.js';
import { ChatService } from './src/Services/ChatService.js';
import { VisionService } from './src/Services/VisionService.js';
import { Database } from './src/Database.js';

class App {
    constructor(config = new Config()) {
        this.config = config;
        this.label = '[App]';
        this.logger = new Logger({ verbose: config.verbose });

        // Einzige Database-Instanz (Pool-Eigentümer) — wird durchgereicht.
        this.database = new Database({ db: config.db, logger: this.logger });

        this.qdrant = new QdrantService({
            url: config.qdrant.url,
            port: config.qdrant.port,
            collection: config.qdrant.collection,
            retryDelaySec: config.qdrant.retryDelaySec,
            maxRetries: config.qdrant.maxRetries,
            logger: this.logger
        });

        this.vision = new VisionService({
            api: config.vision.api,
            url: config.vision.url,
            model: config.vision.model,
            logger: this.logger
        });

        // Qdrant-/Vision-Config geändert (z. B. URL korrigiert + gespeichert) → sofort anwenden.
        this._onConfigChange = ({ changed }) => {
            if (changed.includes('qdrant')) {
                this.logger.log(this.label, 'Qdrant-Config geändert → neuer Verbindungsversuch');
                this.qdrant.updateConfig(this.config.qdrant);
            }
            if (changed.includes('vision')) {
                this.logger.log(this.label, 'Vision-Config geändert → Service aktualisiert');
                this.vision.updateConfig(this.config.vision);
            }
            if (changed.includes('searchTopK')) {
                this.logger.log(this.label, 'searchTopK geändert → SearchService aktualisiert');
                this.search.updateConfig({ topK: this.config.searchTopK });
            }
            if (changed.includes('chat')) {
                this.logger.log(this.label, 'Chat-Config geändert → SearchService aktualisiert');
                this.search.updateConfig({ systemPrompt: this.config.chat.systemPrompt });
            }
            if (changed.includes('search')) {
                this.logger.log(this.label, 'Search-Config geändert → SearchService aktualisiert');
                this.search.updateConfig({
                    rerankEnabled: this.config.search.rerankEnabled,
                    rerankBoost: this.config.search.rerankBoost,
                    citationEnabled: this.config.search.citationEnabled
                });
            }
        };
        this.config.on('change', this._onConfigChange);

        this.embeddings = new EmbeddingsService({
            api: config.embeddings.api,
            url: config.embeddings.url,
            model: config.embeddings.model,
            host: config.embeddings.host,
            logger: this.logger
        });

        this.chat = new ChatService({
            api: config.chat.api,
            url: config.chat.url,
            model: config.chat.model,
            logger: this.logger
        });

        this.search = new SearchService({
            qdrant: this.qdrant,
            embeddings: this.embeddings,
            chat: this.chat,
            systemPrompt: config.chat.systemPrompt,
            topK: config.searchTopK,
            rerankEnabled: config.search.rerankEnabled,
            rerankBoost: config.search.rerankBoost,
            citationEnabled: config.search.citationEnabled,
            logger: this.logger
        });

        this.docling = new DoclingService({ config: this.config, logger: this.logger });

        this.server = new Server(this.config, this.search, this.database, this.logger, this.docling);
    }

    async run() {
        return this.server.start();
    }
}

if (process.argv.includes('--init-config')) {
    new Config().saveDefaults();
    const logger = new Logger({ verbose: process.env.VERBOSE === 'true' });
    logger.log('[App]', 'Defaults written to config.json.');
    process.exit(0);
}

new App().run();

export { App };
