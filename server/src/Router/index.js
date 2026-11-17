import express from 'express';
import { FrontendRouter } from './FrontendRouter.js';
import { McpRouter } from './McpRouter.js';
import { SearchRouter } from './SearchRouter.js';
import { HealthRouter } from './HealthRouter.js';
import { SettingsRouter } from './SettingsRouter.js';
import { FilesRouter } from './FilesRouter.js';
import { LogsWebSocket } from '../WebSocket/LogsWebSocket.js';
import { DashboardWebSocket } from '../WebSocket/DashboardWebSocket.js';
import { FilesWebSocket } from '../WebSocket/FilesWebSocket.js';
import { DashboardService } from '../Services/DashboardService.js';
import { FileService } from '../Services/FileService.js';
import { McpSessionsService } from '../Services/McpSessionsService.js';

/**
 * Main router class that aggregates all server routes.
 * Integrates frontend, search, health, and MCP routes.
 */
class Router {
    /**
     * @param {Config} config - Configuration object
     * @param {SearchService} search - Search service
     * @param {import('node:http').Server} httpServer - HTTP server instance
     * @param {McpService} mcpService - MCP service
     * @param {LogService} logService - Log buffer / broadcast service
     * @param {Database} database - zentrale Database-Instanz (Pool-Eigentümer)
     * @param {DocklingService} [dockling] - Dockling service (docling-serve Status-Polling)
     * @param {Logger} [logger] - Logger instance
     */
    constructor(config, search, httpServer, mcpService, logService, database, dockling, logger) {
        this.search = search;
        this.config = config;
        this.mcpService = mcpService;
        this.httpServer = httpServer;
        this.logService = logService;
        this.database = database;
        this.dockling = dockling;
        this.label = '[Router]';
        this.logger = logger || { log: () => {}, error: () => {} };

        this.router = express.Router();
        this.router.use(express.json());

        // Dashboard + MCP-Session-Tracking (werden in define() initialisiert).
        this.mcpSessions = null;
        this.dashboardService = null;
        this.dashboardWs = null;
        this.fileService = null;
        this.filesWs = null;
    }

    /**
     * Defines all routes: frontend, health, search, and MCP.
     * @returns {Promise<void>}
     */
    async define() {

        // MCP-Session-Tracker (verbundene Systeme am MCP-Endpunkt).
        this.mcpSessions = new McpSessionsService({ logger: this.logger });

        //
        const healthRouter = new HealthRouter(this.logger);
        this.router.use('/', healthRouter.router);

        //
        const searchRouter = new SearchRouter(this.search, this.logger);
        this.router.use('/', searchRouter.router);

        //
        const mcpRouter = new McpRouter(this.config, this.mcpService, this.mcpSessions, this.logger);
        this.router.use('/', mcpRouter.router);

        //
        const settingsRouter = new SettingsRouter(this.config, this.logger);
        this.router.use('/', settingsRouter.router);

        //
        // Log-Monitor: WebSocket (/logs).
        // Kein Express-Route — das upgrade-Event wird zentral geroutet.
        this.logsWs = new LogsWebSocket(this.httpServer, this.logService, this.logger);

        //
        // Files: Datei-Verwaltung (Watcher + Queue) + WebSocket (/files).
        // Vor dem Dashboard erzeugt: das Dashboard aggregiert die File-Statistik.
        this.fileService = new FileService({ config: this.config, database: this.database, logger: this.logger });
        this.filesWs = new FilesWebSocket(this.fileService, this.logger);

        //
        // Dashboard: Status-Aggregation + WebSocket (/dashboard).
        this.dashboardService = new DashboardService({
            config: this.config,
            qdrant: this.search?.qdrant,
            mcpSessions: this.mcpSessions,
            dockling: this.dockling,
            logService: this.logService,
            database: this.database,
            fileService: this.fileService,
            logger: this.logger
        });
        this.dashboardWs = new DashboardWebSocket(this.dashboardService, this.logger);

        const filesRouter = new FilesRouter(this.fileService, this.logger);
        this.router.use('/', filesRouter.router);

        // Zentrales Upgrade-Routing (/logs + /dashboard + /files).
        this.setupUpgradeRouting();

        //
        const frontendRouter = new FrontendRouter(this.config, this.httpServer, this.logger);
        await frontendRouter.init();
        this.router.use('/', frontendRouter.router);

        // Start: Session-Sweep + Docling-Poll + Dashboard-Refresh + Files (Watcher + Initial-Scan).
        this.mcpSessions.start();
        this.dockling?.start();
        this.dashboardService.start();
        this.fileService.start();
    }

    /**
     * Zentrales Upgrade-Routing auf dem gemeinsamen httpServer.
     *
     * Verteilt WebSocket-Upgrade-Anfragen gezielt:
     *   - /logs  → Log-WebSocket (noServer-Modus, manuelles handleUpgrade)
     *   - sonst  → Vite HMR (Vites eigener selektiver Listener, gebunden via
     *              ws: { server: httpServer } in der Vite-Konfiguration)
     *
     * Wichtig: Der Log-WebSocket läuft im noServer-Modus und registriert KEINEN
     * eigenen upgrade-Listener. Ein an den Server gebundener ws-Server würde
     * fremde Upgrades (z. B. Vite HMR) mit 400 Bad Request abbrechen.
     */
    setupUpgradeRouting() {
        // Alle upgraded Sockets (WebSocket) tracken: httpServer.close() und
        // closeAllConnections() beenden sie NICHT (nach dem Upgrade gehören
        // sie nicht mehr zum Server) — ohne explizites Destroyen hängt der
        // Shutdown (z. B. node --watch-Restart) auf offenen HMR-/Log-WS.
        this.upgradedSockets = new Set();
        this.httpServer.on('upgrade', (request, socket, head) => {
            this.upgradedSockets.add(socket);
            socket.on('close', () => this.upgradedSockets.delete(socket));

            let pathname;
            try {
                pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
            } catch {
                socket.destroy();
                return;
            }

            if (pathname === '/logs') {
                this.logsWs.wss.handleUpgrade(request, socket, head, (ws) => {
                    this.logsWs.wss.emit('connection', ws, request);
                });
            } else if (pathname === '/dashboard') {
                this.dashboardWs.wss.handleUpgrade(request, socket, head, (ws) => {
                    this.dashboardWs.wss.emit('connection', ws, request);
                });
            } else if (pathname === '/files') {
                this.filesWs.wss.handleUpgrade(request, socket, head, (ws) => {
                    this.filesWs.wss.emit('connection', ws, request);
                });
            }
            // Alle anderen Upgrades (Vite HMR mit ?token=…) übernimmt Vites
            // eigener selektiver Listener — hier bewusst nichts weiter tun.
        });
    }

    /** Beendet alle offenen WebSocket-Verbindungen (Shutdown). */
    closeUpgradedSockets() {
        for (const socket of this.upgradedSockets) {
            socket.destroy();
        }
        this.upgradedSockets.clear();
    }
}

export { Router };
