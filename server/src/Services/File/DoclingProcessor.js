import axios from 'axios';
import { stat, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { FileProcessor } from './FileProcessor.js';
import { normalizeUrl } from '../../Utils/url.js';

/**
 * Echte Verarbeitung: docling-Chunking → Embeddings → Qdrant.
 *
 * - create/modify → chunk() (docling) → deleteBySource (Orphan-Schutz) →
 *   pro Chunk embed() + upsert() → Store-Update (status done, chunkCount)
 * - delete → deleteBySource (Chunks entfernen) → markDeleted (Tombstone, geerbt)
 * - Race: File während Processing gelöscht (ENOENT) → wie delete behandeln
 * - Size-Limit: File > maxFileSizeMb → skipped (kein Fehler)
 * - Abort: AbortSignal wird an axios übergeben + zwischen Chunks geprüft
 * - 4xx (außer 408/429) → err.noRetry = true (FileQueue: direkt error, kein Retry)
 */
class DoclingProcessor extends FileProcessor {
    /**
     * @param {object} params
     * @param {object} params.config - Config-Objekt mit `.storage` + `.docling`-Gruppe
     * @param {object} params.store - FileStore (upsert)
     * @param {object} params.embeddings - EmbeddingsService (embed)
     * @param {object} params.qdrant - QdrantService (upsert, deleteBySource)
     * @param {Logger} [params.logger]
     */
    constructor({ config, store, embeddings, qdrant, logger } = {}) {
        super({ config, store, logger });
        if (!embeddings || typeof embeddings.embed !== 'function') {
            throw new Error('DoclingProcessor requires an embeddings service with an embed method');
        }
        if (!qdrant || typeof qdrant.upsert !== 'function' || typeof qdrant.deleteBySource !== 'function') {
            throw new Error('DoclingProcessor requires a qdrant service with upsert and deleteBySource methods');
        }
        this.label = '[DoclingProcessor]';
        this.embeddings = embeddings;
        this.qdrant = qdrant;
    }

    /** Config wird pro Job gelesen → Änderungen wirken ohne Neustart. */
    get doclingConfig() {
        return this.config.docling;
    }

    /**
     * Verarbeitet einen Job.
     * @param {object} job
     * @param {AbortSignal} [signal]
     * @param {(line: string) => void} [progress]
     * @returns {Promise<object>}
     */
    async process(job, signal, progress) {
        if (job.event === 'delete') return this.processDelete(job, signal, progress);
        return this.processUpsert(job, signal, progress);
    }

    /** delete: Chunks aus Qdrant entfernen + Tombstone (geerbt). */
    async processDelete(job, signal, progress) {
        progress?.('Chunks aus Qdrant entfernen…');
        await this.qdrant.deleteBySource(job.path);
        const entry = await this.markDeleted(job);
        progress?.('Tombstone gesetzt');
        this.logger.log(this.label, 'File gelöscht (Docling)', { path: job.path });
        return { status: 'deleted', path: job.path, event: job.event, size: null, entry };
    }

    /** create/modify: chunk → Orphan-Schutz → embed+upsert → Store-Update. */
    async processUpsert(job, signal, progress) {
        progress?.(`Starte Verarbeitung (${job.event})`);
        let stats;
        try {
            stats = await stat(this.resolvePath(job));
        } catch (err) {
            if (err.code === 'ENOENT') return this.processDelete(job, signal, progress);
            throw err;
        }

        const maxBytes = (this.config.storage.maxFileSizeMb ?? Infinity) * 1024 * 1024;
        if (stats.size > maxBytes) {
            const entry = await this.store.upsert(job.path, {
                size: stats.size,
                mtime: stats.mtime.toISOString(),
                ctime: stats.ctime.toISOString(),
                status: 'skipped',
                lastEvent: job.event
            });
            progress?.('File übersprungen (zu groß)');
            this.logger.log(this.label, 'File übersprungen (zu groß)', {
                path: job.path,
                size: stats.size,
                maxFileSizeMb: this.config.storage.maxFileSizeMb
            });
            return { status: 'skipped', path: job.path, event: job.event, size: stats.size, entry };
        }

        progress?.('Chunking (docling)…');
        const chunks = await this.chunk(job, signal);
        progress?.(`${chunks.length} Chunks gefunden`);
        await this.qdrant.deleteBySource(job.path);

        for (let i = 0; i < chunks.length; i++) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            progress?.(`Embedding Chunk ${i + 1}/${chunks.length}…`);
            const vector = await this.embeddings.embed(chunks[i].text);
            progress?.(`Upsert Chunk ${i + 1}/${chunks.length}…`);
            await this.qdrant.upsert(vector, {
                text: chunks[i].text,
                path: job.path,
                source: job.path,
                headings: chunks[i].headings,
                page_numbers: chunks[i].page_numbers,
                chunk_index: chunks[i].chunk_index,
                captions: chunks[i].captions
            });
        }

        const entry = await this.store.upsert(job.path, {
            size: stats.size,
            mtime: stats.mtime.toISOString(),
            ctime: stats.ctime.toISOString(),
            status: 'done',
            lastEvent: job.event,
            processedAt: new Date().toISOString(),
            chunkCount: chunks.length
        });
        progress?.('Fertig');
        this.logger.log(this.label, 'File verarbeitet (Docling)', { path: job.path, event: job.event, size: stats.size, chunks: chunks.length });
        return { status: 'done', path: job.path, event: job.event, size: stats.size, entry };
    }

    /** docling-Chunking via multipart POST. 4xx (außer 408/429) → noRetry. */
    async chunk(job, signal) {
        const { url, apiKey, timeoutSec, maxTokens, useMarkdownTables, useMarkdownImages, ocr } = this.doclingConfig;
        const base = normalizeUrl(url);
        const abs = this.resolvePath(job);

        const form = new FormData();
        const fileBuf = await readFile(abs);
        form.append('files', new Blob([fileBuf]), basename(abs));
        if (maxTokens > 0) form.append('chunking_max_tokens', String(maxTokens));
        form.append('chunking_use_markdown_tables', String(useMarkdownTables));
        form.append('chunking_use_markdown_images', String(useMarkdownImages));
        form.append('chunking_merge_peers', 'true');
        form.append('convert_do_ocr', String(ocr));

        try {
            const res = await axios.post(`${base}/v1/chunk/hybrid/file`, form, {
                headers: apiKey ? { 'X-Api-Key': apiKey } : {},
                timeout: timeoutSec * 1000,
                signal
            });
            return res.data?.chunks || [];
        } catch (err) {
            const status = err?.response?.status;
            if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
                err.noRetry = true;
            }
            throw err;
        }
    }
}

export { DoclingProcessor };
