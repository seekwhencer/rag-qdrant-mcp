import { describe, it, expect, vi } from 'vitest';

import { SearchService } from '../src/Services/SearchService.js';

const makeService = (overrides = {}) => new SearchService({
    qdrant: { search: vi.fn().mockResolvedValue([]) },
    embeddings: { embed: vi.fn().mockResolvedValue([0.1, 0.2]) },
    chat: { chat: vi.fn(), streamChat: vi.fn() },
    systemPrompt: 'test prompt',
    logger: { log: () => {}, error: () => {} },
    ...overrides
});

describe('SearchService', () => {
    describe('buildFilter', () => {
        it('returns null when no options', () => {
            const svc = makeService();
            expect(svc.buildFilter()).toBeNull();
            expect(svc.buildFilter({})).toBeNull();
        });

        it('builds a must array', () => {
            const svc = makeService();
            expect(svc.buildFilter({ source: 'a.md', heading: 'H1', page: 3 })).toEqual({
                must: [
                    { key: 'source', match: { value: 'a.md' } },
                    { key: 'headings', match: { value: 'H1' } },
                    { key: 'page_numbers', match: { value: 3 } }
                ]
            });
        });

        it('includes only the provided options', () => {
            const svc = makeService();
            expect(svc.buildFilter({ heading: 'H1' })).toEqual({
                must: [{ key: 'headings', match: { value: 'H1' } }]
            });
        });
    });

    describe('rerank', () => {
        it('boosts chunks with matching headings', () => {
            const svc = makeService();
            const results = [
                { score: 0.9, payload: { text: 'a', headings: [] } },
                { score: 0.85, payload: { text: 'b', headings: ['Sicherheit'] } }
            ];

            const out = svc.rerank(results, 'Sicherheit');

            expect(out[0].payload.text).toBe('b');
            expect(out[0].score).toBeCloseTo(0.85 + 2 * 0.05);
            expect(out[1].payload.text).toBe('a');
            expect(out[1].score).toBeCloseTo(0.9);
        });

        it('is a no-op when disabled', () => {
            const svc = makeService({ rerankEnabled: false });
            const results = [
                { score: 0.9, payload: { text: 'a', headings: [] } },
                { score: 0.8, payload: { text: 'b', headings: ['Sicherheit'] } }
            ];

            const out = svc.rerank(results, 'Sicherheit');

            expect(out).toEqual(results);
        });

        it('returns unchanged when no keywords', () => {
            const svc = makeService();
            const results = [
                { score: 0.9, payload: { text: 'a', headings: ['Sicherheit'] } },
                { score: 0.8, payload: { text: 'b', headings: [] } }
            ];

            const out = svc.rerank(results, 'a');

            expect(out).toEqual(results);
        });
    });

    describe('extractKeywords', () => {
        it('removes stopwords and short words', () => {
            const svc = makeService();
            expect(svc.extractKeywords('Was steht in der Sicherheit?')).toEqual(['sicherheit']);
        });
    });

    describe('buildCitation', () => {
        it('formats path, page and heading', () => {
            const svc = makeService();
            expect(svc.buildCitation({ path: 'r.pdf', page_numbers: [12], headings: ['Kapitel 3'] }))
                .toBe('r.pdf · S. 12 · Kapitel 3');
        });

        it('joins multiple page numbers', () => {
            const svc = makeService();
            expect(svc.buildCitation({ path: 'r.pdf', page_numbers: [12, 13], headings: [] }))
                .toBe('r.pdf · S. 12, 13');
        });

        it('returns empty string when no metadata', () => {
            const svc = makeService();
            expect(svc.buildCitation()).toBe('');
            expect(svc.buildCitation({})).toBe('');
        });
    });

    describe('searchAndReturnChunks', () => {
        it('applies filter, rerank and citation', async () => {
            const svc = makeService();
            svc.qdrant.search.mockResolvedValue([
                {
                    score: 0.9,
                    payload: {
                        text: 'chunk text',
                        path: 'a.md',
                        headings: ['H1'],
                        page_numbers: [3],
                        chunk_index: 0,
                        captions: ['c']
                    }
                }
            ]);

            const chunks = await svc.searchAndReturnChunks('q', { source: 'a.md', heading: 'H1', page: 3 });

            expect(svc.qdrant.search).toHaveBeenCalledWith([0.1, 0.2], svc.topK, {
                must: [
                    { key: 'source', match: { value: 'a.md' } },
                    { key: 'headings', match: { value: 'H1' } },
                    { key: 'page_numbers', match: { value: 3 } }
                ]
            });
            expect(chunks).toEqual([
                {
                    text: 'chunk text',
                    score: 0.9,
                    citation: 'a.md · S. 3 · H1',
                    metadata: {
                        path: 'a.md',
                        headings: ['H1'],
                        page_numbers: [3],
                        chunk_index: 0,
                        captions: ['c']
                    }
                }
            ]);
            expect(chunks[0].citation).toBe('a.md · S. 3 · H1');
            expect(chunks[0].metadata.headings).toEqual(['H1']);
        });

        it('omits citation when disabled', async () => {
            const svc = makeService({ citationEnabled: false });
            svc.qdrant.search.mockResolvedValue([
                {
                    score: 0.9,
                    payload: {
                        text: 'chunk text',
                        path: 'a.md',
                        headings: ['H1'],
                        page_numbers: [3],
                        chunk_index: 0,
                        captions: ['c']
                    }
                }
            ]);

            const chunks = await svc.searchAndReturnChunks('q');

            expect(chunks[0]).not.toHaveProperty('citation');
            expect(chunks[0].metadata.headings).toEqual(['H1']);
        });

        it('passes a null filter when no options are given', async () => {
            const svc = makeService();
            svc.qdrant.search.mockResolvedValue([]);

            await svc.searchAndReturnChunks('q');

            expect(svc.qdrant.search).toHaveBeenCalledWith([0.1, 0.2], svc.topK, null);
        });
    });

    describe('searchAndAnswer', () => {
        const points = [
            { score: 0.9, payload: { text: 'chunk text', path: 'a.md', headings: ['H1'], page_numbers: [3] } }
        ];

        it('appends citations when enabled', async () => {
            const svc = makeService();
            svc.qdrant.search.mockResolvedValue(points);
            svc.chat.chat.mockResolvedValue('Die Antwort.');

            const answer = await svc.searchAndAnswer('q');

            expect(svc.chat.chat).toHaveBeenCalledTimes(1);
            expect(answer).toBe('Die Antwort.\n\nQuellen:\n- a.md · S. 3 · H1');
            const messages = svc.chat.chat.mock.calls[0][0];
            expect(messages[0].content).not.toContain('Quellen:');
        });

        it('skips citations when disabled', async () => {
            const svc = makeService({ citationEnabled: false });
            svc.qdrant.search.mockResolvedValue(points);
            svc.chat.chat.mockResolvedValue('Die Antwort.');

            const answer = await svc.searchAndAnswer('q');

            expect(answer).toBe('Die Antwort.');
            expect(answer).not.toContain('Quellen:');
        });
    });

    describe('streamAndAnswer', () => {
        const points = [
            { score: 0.9, payload: { text: 'chunk text', path: 'a.md', headings: ['H1'], page_numbers: [3] } }
        ];

        const makeStreamChat = () => async function* () {
            yield { phase: 'answer', token: 'Hallo ' };
            yield { phase: 'answer', token: 'Welt' };
        };

        it('yields citations event when enabled', async () => {
            const svc = makeService();
            svc.qdrant.search.mockResolvedValue(points);
            svc.chat.streamChat = makeStreamChat();

            const events = [];
            for await (const ev of svc.streamAndAnswer('q')) {
                events.push(ev);
            }

            const citationsIdx = events.findIndex((e) => e.type === 'citations');
            const doneIdx = events.findIndex((e) => e.type === 'done');
            expect(citationsIdx).toBeGreaterThan(-1);
            expect(doneIdx).toBeGreaterThan(citationsIdx);
            expect(events[citationsIdx].text).toBe('Quellen:\n- a.md · S. 3 · H1');
        });

        it('skips citations event when disabled', async () => {
            const svc = makeService({ citationEnabled: false });
            svc.qdrant.search.mockResolvedValue(points);
            svc.chat.streamChat = makeStreamChat();

            const events = [];
            for await (const ev of svc.streamAndAnswer('q')) {
                events.push(ev);
            }

            expect(events.some((e) => e.type === 'citations')).toBe(false);
            expect(events[events.length - 1].type).toBe('done');
        });
    });
});
