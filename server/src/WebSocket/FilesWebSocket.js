import { WebSocketServer } from 'ws';

/**
 * WebSocket-Server für die Datei-Verwaltung, Endpunkt /files.
 *
 * Läuft im noServer-Modus (wie LogsWebSocket): das upgrade-Event wird
 * zentral im Router geroutet (Router.setupUpgradeRouting). So stört er
 * Vites HMR-WebSocket nicht.
 *
 * Protokoll (JSON):
 *   Server → Client:
 *     { type: 'snapshot', data: snapshot } — einmalig auf Connect
 *     { type: 'update',   data: snapshot } — bei jeder Änderung
 */
class FilesWebSocket {
    /**
     * @param {FileService} fileService
     * @param {Logger} [logger]
     */
    constructor(fileService, logger) {
        this.label = '[FilesWebSocket]';
        this.logger = logger || { log: () => {}, error: () => {} };
        this.fileService = fileService;
        this.wss = new WebSocketServer({ noServer: true });
        this.wss.on('connection', (ws) => this.onConnection(ws));
        this.wss.on('error', (err) => this.logger.error(this.label, `wss error: ${err.message}`));
    }

    async onConnection(ws) {
        this.logger.log(this.label, `Client verbunden (${this.wss.clients.size} aktiv)`);

        // 1) Aktueller Snapshot (async: DB-Roundtrip).
        let snap;
        try {
            snap = await this.fileService.getSnapshot();
        } catch (err) {
            this.logger.error(this.label, `snapshot failed: ${err.message}`);
            ws.terminate();
            return;
        }
        ws.send(JSON.stringify({ type: 'snapshot', data: snap }));

        // 2) Auf Updates subscribe.
        const unsubscribe = this.fileService.addListener((payload) => {
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

export { FilesWebSocket };
