import { Config } from './src/Config.js';
import { Logger } from './src/Logger.js';
import { Server } from './src/Server.js';
import { SearchService } from './src/Services/SearchService.js';
import { QdrantService } from './src/Services/QdrantService.js';
import { LlmService } from './src/Services/LlmService.js';
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

        // Qdrant-Config geändert (z. B. URL korrigiert + gespeichert) → sofort neu verbinden.
        this._onConfigChange = ({ changed }) => {
            if (changed.includes('qdrant')) {
                this.logger.log(this.label, 'Qdrant-Config geändert → neuer Verbindungsversuch');
                this.qdrant.updateConfig(this.config.qdrant);
            }
        };
        this.config.on('change', this._onConfigChange);

        this.llm = new LlmService({
            embeddingsApi: config.embeddings.api,
            embeddingsUrl: config.embeddings.url,
            embeddingsModel: config.embeddings.model,
            embeddingsHost: config.embeddings.host,
            chatApi: config.chat.api,
            chatUrl: config.chat.url,
            chatModel: config.chat.model,
            logger: this.logger
        });

        this.search = new SearchService({
            qdrant: this.qdrant,
            llm: this.llm,
            systemPrompt: config.chat.systemPrompt,
            topK: config.searchTopK,
            logger: this.logger
        });

        this.server = new Server(this.config, this.search, this.database, this.logger);
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
