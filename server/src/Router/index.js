import express from 'express';
import { FrontendRouter } from './FrontendRouter.js';
import { McpRouter } from './McpRouter.js';
import { SearchRouter } from './SearchRouter.js';
import { HealthRouter } from './HealthRouter.js';
import { SettingsRouter } from './SettingsRouter.js';
import { LogsWebSocket } from '../LogsWebSocket.js';
import { DashboardWebSocket } from '../DashboardWebSocket.js';
import { DashboardService } from '../Services/Dashboard.js';
import { McpSessionTracker } from '../Services/McpSessions.js';

/**
 * Main router class that aggregates all server routes.
 * Integrates frontend, search, health, and MCP routes.
 */
class Router {
    /**
     * @param {Config} config - Configuration object
     * @param {Search} search - Search service
     * @param {import('node:http').Server} httpServer - HTTP server instance
     * @param {McpService} mcpService - MCP service
     * @param {LogService} logService - Log buffer / broadcast service
     * @param {Logger} [logger] - Logger instance
     */
    constructor(config, search, httpServer, mcpService, logService, logger) {
        this.search = search;
        this.config = config;
        this.mcpService = mcpService;
        this.httpServer = httpServer;
        this.logService = logService;
        this.label = '[Router]';
        this.logger = logger || { log: () => {}, error: () => {} };

        this.router = express.Router();
        this.router.use(express.json());

        // Dashboard + MCP-Session-Tracking (werden in define() initialisiert).
        this.mcpSessions = null;
        this.dashboardService = null;
        this.dashboardWs = null;
    }

    /**
     * Defines all routes: frontend, health, search, and MCP.
     * @returns {Promise<void>}
     */
    async define() {

        // MCP-Session-Tracker (verbundene Systeme am MCP-Endpunkt).
        this.mcpSessions = new McpSessionTracker({ logger: this.logger });

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
        // Dashboard: Status-Aggregation + WebSocket (/dashboard).
        this.dashboardService = new DashboardService({
            config: this.config,
            qdrant: this.search?.qdrant,
            mcpSessions: this.mcpSessions,
            logService: this.logService,
            logger: this.logger
        });
        this.dashboardWs = new DashboardWebSocket(this.dashboardService, this.logger);

        // Zentrales Upgrade-Routing (/logs + /dashboard).
        this.setupUpgradeRouting();

        //
        const frontendRouter = new FrontendRouter(this.config, this.httpServer, this.logger);
        await frontendRouter.init();
        this.router.use('/', frontendRouter.router);

        // Start: Session-Sweep + Dashboard-Refresh.
        this.mcpSessions.start();
        this.dashboardService.start();
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
