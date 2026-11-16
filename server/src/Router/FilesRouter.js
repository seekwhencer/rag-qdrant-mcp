import express from 'express';

/**
 * Files router: /api/files (Snapshot) + Queue-Steuerung (pause/resume/abort/remove).
 */
class FilesRouter {
    /**
     * @param {FileService} fileService
     * @param {Logger} [logger] - Logger instance
     */
    constructor(fileService, logger) {
        this.fileService = fileService;
        this.label = '[FilesRouter]';
        this.logger = logger || { log: () => {}, error: () => {} };

        this.router = express.Router();

        this.define();
    }

    /**
     * Defines the /api/files routes.
     * Handler sind async: Express 5 leitet abgelehnte Promises an den Error-Handler weiter.
     * @returns {void}
     */
    define() {
        // Snapshot (Files + Queue + Stats).
        this.router.get('/api/files', async (req, res) => {
            res.status(200).json(await this.fileService.getSnapshot());
        });

        // Pause: Dispatcher stoppt, aktive Jobs laufen zu Ende (graceful).
        this.router.post('/api/files/queue/pause', async (req, res) => {
            await this.fileService.pause();
            res.status(200).json(await this.fileService.getSnapshot());
        });

        // Resume: Dispatcher läuft weiter.
        this.router.post('/api/files/queue/resume', async (req, res) => {
            await this.fileService.resume();
            res.status(200).json(await this.fileService.getSnapshot());
        });

        // Abort: alle pending → cancelled, aktive Jobs via AbortSignal.
        this.router.post('/api/files/queue/abort', async (req, res) => {
            await this.fileService.abort();
            res.status(200).json(await this.fileService.getSnapshot());
        });

        // Pending-Job entfernen (nur pending löschbar).
        this.router.delete('/api/files/queue/:jobId', async (req, res) => {
            const job = await this.fileService.removeJob(req.params.jobId);
            if (!job) {
                res.status(404).json({ error: 'Job not found or not pending', code: 'job_not_found' });
                return;
            }
            res.status(200).json({ job, snapshot: await this.fileService.getSnapshot() });
        });
    }
}

export { FilesRouter };
