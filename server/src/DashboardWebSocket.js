import { WebSocketServer } from 'ws';

/**
 * WebSocket-Server für das Dashboard, Endpunkt /dashboard.
 *
 * Läuft im noServer-Modus (wie LogsWebSocket): das upgrade-Event wird
 * zentral im Router geroutet (Router.setupUpgradeRouting). So stört er
 * Vites HMR-WebSocket nicht.
 *
 * Protokoll (JSON):
 *   Server → Client:
 *     { type: 'snapshot', data: status } — einmalig auf Connect
 *     { type: 'update',   data: status } — bei jeder Änderung
 */
class DashboardWebSocket {
    /**
     * @param {DashboardService} dashboardService
     * @param {Logger} [logger]
     */
    constructor(dashboardService, logger) {
        this.label = '[DashboardWebSocket]';
        this.logger = logger || { log: () => {}, error: () => {} };
        this.dashboardService = dashboardService;
        this.wss = new WebSocketServer({ noServer: true });
        this.wss.on('connection', (ws) => this.onConnection(ws));
        this.wss.on('error', (err) => this.logger.error(this.label, `wss error: ${err.message}`));
    }

    onConnection(ws) {
        this.logger.log(this.label, `Client verbunden (${this.wss.clients.size} aktiv)`);

        // 1) Aktueller Snapshot.
        const snap = this.dashboardService.getSnapshot();
        ws.send(JSON.stringify({ type: 'snapshot', data: snap }));

        // 2) Auf Updates subscribe.
        const unsubscribe = this.dashboardService.addListener((payload) => {
            if (ws.readyState === ws.OPEN) ws.send(payload);
        });

        const cleanup = () => {
            unsubscribe();
            this.logger.log(this.label, `Client getrennt (${this.wss.clients.size} aktiv)`);
        };
        ws.on('close', cleanup);
        ws.on('error', cleanup);
    }

    /** Beendet alle verbundenen Clients und schließt den WebSocket-Server. */
    close() {
        for (const client of this.wss.clients) {
            client.terminate();
        }
        this.wss.close();
    }
}

export { DashboardWebSocket };
