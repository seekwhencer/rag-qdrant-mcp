import express from 'express';

/**
 * Search router that exposes the RAG search endpoints.
 */
class SearchRouter {
    /**
     * @param {Search} search - Search service
     * @param {Logger} [logger] - Logger instance
     */
    constructor(search, logger) {
        this.search = search;
        this.label = '[SearchRouter]';
        this.logger = logger || { log: () => {}, error: () => {} };

        this.router = express.Router();

        this.define();
    }

    /**
     * Defines the /search and /search/stream routes.
     * @returns {void}
     */
    define() {

        this.router.post('/search', async (req, res) => {
            const question = req.body.question;
            if (!question) {
                return res.status(400).json({ error: 'Missing "question" in request body' });
            }

            try {
                const answer = await this.search.searchAndAnswer(question);
                if (answer === undefined) {
                    return res.status(404).json({ error: 'No answer found' });
                }
                res.status(200).json({ answer });
            } catch (error) {
                this.logger.error(this.label, 'Error processing search:', error);
                res.status(500).send('Internal Server Error');
            }
        });

        this.router.post('/search/stream', async (req, res) => {
            const question = req.body.question;
            if (!question) {
                return res.status(400).json({ error: 'Missing "question" in request body' });
            }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            res.write('retry: 3000\n\n');

            const send = (event, data) => {
                if (res.writableEnded) return false;
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                return true;
            };

            const controller = new AbortController();
            res.on('close', () => controller.abort());

            const stream = this.search.streamAndAnswer(question, { signal: controller.signal });
            try {
                while (true) {
                    const { value, done } = await stream.next();
                    if (res.writableEnded) break;
                    if (done) break;

                    const ev = value;
                    let ok;
                    if (ev.type === 'status') ok = send('status', { phase: ev.phase, message: ev.message });
                    else if (ev.type === 'thinking') ok = send('thinking', ev.token);
                    else if (ev.type === 'answer') ok = send('answer', ev.token);
                    else if (ev.type === 'empty') ok = send('empty', {});
                    else if (ev.type === 'done') ok = send('done', {});
                    else ok = true;
                    if (ok === false) break;
                }
            } catch (err) {
                if (err && err.name === 'AbortError') return;
                this.logger.error(this.label, '[Error] streaming search:', err);
                send('error', { message: err?.message || 'Streaming fehlgeschlagen' });
            } finally {
                if (!res.writableEnded) res.end();
            }
        });

    }
}

export { SearchRouter };
