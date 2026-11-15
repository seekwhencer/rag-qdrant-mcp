import express from 'express';

/**
 * Settings router that exposes the /api/settings endpoint (GET + PUT).
 */
class SettingsRouter {
    /**
     * @param {Config} config - Configuration object
     * @param {Logger} [logger] - Logger instance
     */
    constructor(config, logger) {
        this.config = config;
        this.label = '[SettingsRouter]';
        this.logger = logger || { log: () => {}, error: () => {} };

        this.router = express.Router();

        this.define();
    }

    /**
     * Defines the /api/settings routes.
     * @returns {void}
     */
    define() {
        this.router.get('/api/settings', (req, res) => {
            res.status(200).json(this.config.getSettings());
        });

        this.router.put('/api/settings', (req, res) => {
            try {
                const result = this.config.updateSettings(req.body || {});
                this.logger.log(this.label, 'Settings updated', result);
                res.status(200).json(result);
            } catch (err) {
                const status = err.status || 500;
                this.logger.error(this.label, 'Settings update failed:', err.message);
                res.status(status).json({ error: err.message, code: err.code || 'settings_error' });
            }
        });
    }
}

export { SettingsRouter };
