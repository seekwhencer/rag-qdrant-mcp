import express from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

/**
 * MCP router that exposes Model Context Protocol endpoints.
 */
class McpRouter {
    /**
     * @param {Config} config - Configuration object
     * @param {McpService} mcpService - MCP service
     * @param {McpSessionTracker} [mcpSessions] - Session-Tracker für das Dashboard
     * @param {Logger} [logger] - Logger instance
     */
    constructor(config, mcpService, mcpSessions, logger) {
        this.config = config;
        this.mcpService = mcpService;
        this.mcpSessions = mcpSessions;
        this.label = '[McpRouter]';
        this.logger = logger || { log: () => {}, error: () => {} };

        this.router = express.Router();

        this.define();
    }

    /**
     * Defines the MCP routes and host validation middleware.
     * @returns {void}
     */
    define() {
        if (!this.mcpService || !this.config.mcp?.enabled) return;

        const mcpPath = this.config.mcp?.path || '/mcp';

        // MCP_ALLOWED_HOSTS host validation. Skip entirely when not configured or empty.
        let allowedHosts;
        try {
            const raw = Array.isArray(this.config.mcp?.allowedHosts)
                ? this.config.mcp.allowedHosts
                : [];
            const parsed =
                [...new Set(raw.map((h) => String(h).trim().toLowerCase()).filter(Boolean))];
            if (parsed.length > 0) allowedHosts = new Set(parsed);
        } catch {
            // malformed config → skip validation
        }

        const stripPort = (host) => {
            const bracketed =
                /^\[([^\]]*)\](?::(\d+))?$/.exec(host.toLowerCase());
            if (bracketed) return `[${bracketed[1]}]`;
            const idx = host.lastIndexOf(':');
            return idx >= 0 ? host.slice(0, idx).toLowerCase() : host.toLowerCase();
        };

        // Host validation middleware covering all nodeHandler-served MCP routes.
        if (allowedHosts && allowedHosts.size > 0) {
            this.router.use((req, res, next) => {
                const rawHost = req.headers['host'] || '';
                let ok;
                for (const a of allowedHosts) {
                    // full host-with-port match OR hostname without port
                    if (
                        stripPort(rawHost).toLowerCase() === a ||
                        rawHost.toLowerCase() === a
                    ) { ok = true; break; }
                }

                if (!ok) {
                    return res.status(403).json({
                        error: 'Host not allowed',
                        message:
                            `Host ${rawHost} is not in the MCP_ALLOWED_HOSTS whitelist.`,
                    });
                }

                next();
            });
        }

        const mcpFactory = () => this.mcpService.createServer();
        const handler = createMcpHandler(mcpFactory);
        const nodeHandler = toNodeHandler(handler);

        // Middleware registered above runs before the route below, so every
        // request served by nodeHandler (e.g. /mcp and /mcp/message) passes host validation.
        this.router.all(mcpPath, (req, res) => {
            this.trackClient(req);
            void nodeHandler(req, res, req.body);
        });
    }

    /**
     * Trackt verbundene MCP-Clients für das Dashboard.
     * Das SDK läuft stateless (keine Session-IDs), daher wird die Identität
     * (IP + User-Agent) verwendet. Zusätzlich wird die Client-Info (Name +
     * Version) erfasst — modern (2026-07-28+) aus dem `_meta`-Envelope,
     * legacy aus `params.clientInfo` im `initialize`-Request.
     */
    trackClient(req) {
        if (!this.mcpSessions) return;
        const ip = req.socket?.remoteAddress || '';
        const host = req.headers['host'] || '';
        const userAgent = req.headers['user-agent'] || '';
        const clientInfo = this.extractClientInfo(req.body);
        this.mcpSessions.touch({ ip, host, userAgent, clientInfo });
    }

    /**
     * clientInfo ({ name, version }) aus dem Request-Body extrahieren.
     *
     * Modern (2026-07-28+): `params._meta["io.modelcontextprotocol/clientInfo"]`
     *   — Clients senden es auf JEDEM Request im `_meta`-Envelope.
     * Legacy: `params.clientInfo` — nur im `initialize`-Request.
     *
     * Modern wird bevorzugt; legacy dient als Fallback. Batch-Bodies (Array)
     * werden durchsucht.
     */
    extractClientInfo(body) {
        if (!body) return null;
        const msgs = Array.isArray(body) ? body : [body];
        let legacy = null;
        for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            const params = m.params || {};
            // Modern: _meta-Envelope (jeder Request)
            const modern = params._meta?.['io.modelcontextprotocol/clientInfo'];
            if (modern && typeof modern === 'object' && (modern.name || modern.version)) {
                return modern;
            }
            // Legacy: params.clientInfo (initialize) — merken als Fallback
            if (m.method === 'initialize' && !legacy && params.clientInfo && typeof params.clientInfo === 'object') {
                legacy = params.clientInfo;
            }
        }
        return legacy;
    }
}

export { McpRouter };
