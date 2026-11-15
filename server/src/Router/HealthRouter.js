import express from 'express';

/**
 * Health router that exposes the service health endpoint.
 */
class HealthRouter {
    /**
     * @param {Logger} [logger] - Logger instance
     */
    constructor(logger) {
        this.label = '[HealthRouter]';
        this.logger = logger || { log: () => {}, error: () => {} };

        this.router = express.Router();

        this.define();
    }

    /**
     * Defines the /health route.
     * @returns {void}
     */
    define() {
        this.router.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
    }
}

export { HealthRouter };
