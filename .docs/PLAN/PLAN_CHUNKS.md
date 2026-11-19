# PLAN: Chunk-Metadaten im Qdrant-Payload (Filter / Rerank / Zitat)

## Ziel

Docling-Chunk-Metadaten in den Qdrant-Payload speichern und nutzen, um die Suche genauer zu machen.

- **Embedding bleibt `chunk.text`** (Vektor = Content, unverändert).
- **Metadaten als Payload** → Filter (Suchraum verkleinern), Rerank (Treffer neu sortieren), Zitat (Quelle anzeigen).
- **Config-driven:** Rerank + Zitat per `search`-Config-Gruppe an/aus + Boost-Faktor.
- **Settings-UI:** neue `search`-Kategorie mit Toggles.
- **ask-Tool (RAG):** nutzt ebenfalls Rerank + Zitat.

Keine Änderung am Embedding-Input. Keine neue Abhängigkeit. Keine Migration (neue Payload-Felder optional).

## Begriffe

| Begriff | Bedeutung | Wann |
|---|---|---|
| **Filter** | Suchraum verkleinern | **vorher** (in der Qdrant-Query) |
| **Rerank** | Treffer neu sortieren | **nachher** (nach der Vektorsuche) |
| **Zitat** | Quelle anzeigen | **Anzeige** (Ergebnis → Nutzer/LLM) |

## Ist-Zustand

- `DoclingProcessor.chunk()` liefert die vollen Chunk-Objekte (`res.data?.chunks`) — `server/src/Services/File/DoclingProcessor.js:138`.
- `processUpsert()` nutzt nur `chunk.text` für `embed()` + `upsert()` — `DoclingProcessor.js:94-102`.
- `QdrantService.upsert(vector, { text, path, source })` baut den Payload mit `text`, `path`, `source` — `QdrantService.js:200-232`.
- Point-ID = `sha256Hex(text + '\0' + source)` → deterministisch, unabhängig von Metadaten.
- `QdrantService.search(vector, limit)` — kein Filter-Parameter — `QdrantService.js:240-252`.
- `SearchService.searchAndReturnChunks(question)` liefert `{ text, score, metadata: { path } }` — `SearchService.js:170-197`.
- `SearchService.searchAndAnswer(question)` (RAG) nutzt `item.payload?.text` als Kontext — `SearchService.js:77-121`.
- MCP-Tool `search` ruft `searchAndReturnChunks(question)` auf — `McpService.js:69-87`. MCP-Tool `ask` ruft `searchAndAnswer(question)` auf — `McpService.js:49-67`.
- **Config:** Gruppen `qdrant`/`embeddings`/`chat`/`vision`/`mcp`/`storage`/`db`/`docling` + Root (`serverPort`, `verbose`, `searchTopK`, `dataDir`) — `Config.js`. `searchTopK` ist Root-Level, fließt über `index.js` → `SearchService.updateConfig({ topK })`.
- **Wiring:** `index.js:73-80` baut `SearchService` mit `topK` + `systemPrompt`; `index.js:38-55` reagiert auf Config-Changes (`changed.includes('chat')` → `updateConfig`).
- **Frontend:** `SettingsPage.jsx` hat Kategorien (server/storage/database/qdrant/docling/embeddings/chat/vision/mcp/ui). `SettingsField.jsx` unterstützt `checkbox`/`number`/`text`/`textarea`/`select`/`list`. `useSettingsGroup(groupKey, ...)` liest `settings[groupKey]`. **Keine Chat-UI** (nur Files/Settings/Dashboard/Logs/About).

## Entscheidungen

1. **Embedding-Input = `chunk.text`** (unverändert). Headings gehen NICHT in den Vektor.
   - Grund: Vektor = gespeicherter Text (konsistent). Keine Token-Verdünnung. Kein Mismatch.
   - Kontext-Embedding (headings+text) = spätere Optimierung, erst bei ungenügendem Retrieval.
2. **Payload-Felder** (aus der Docling-Antwort):
   - `headings` (string[]) — Filter + Rerank + Zitat
   - `page_numbers` (number[]) — Filter + Zitat
   - `chunk_index` (number) — Reihenfolge/Rekonstruktion
   - `captions` (string[]) — Zitat (Bild-Kontext)
3. **Weglassen:** `filename` (redundant), `num_tokens` (Größe), `raw_text` (Duplikat), `doc_items` (intern), `metadata` (geringer Wert).
4. **Defensive Defaults:** Felder optional (`[]` / `null`), da Docling sie nicht immer liefert.
5. **Keine ID-Änderung:** Point-ID bleibt `sha256Hex(text + source)`. Neue Felder ändern die ID nicht → keine Migration.
6. **Config-driven:** neue `search`-Gruppe (`rerankEnabled`, `rerankBoost`, `citationEnabled`). Rerank + Zitat lesen daraus.
7. **Defaults (bestätigt):** `rerankEnabled=true`, `citationEnabled=true`, `rerankBoost=0.05` — Features standardmäßig an, per Settings-UI abschaltbar.
8. **ask-Tool (RAG):** nutzt Rerank + Zitat (gleiche Config-Toggles wie search). Quellen werden **an die Antwort angehängt** (nicht in den LLM-Kontext) → saubere `Quellen:`-Liste, LLM antwortet aus den Chunk-Texten.
9. **heading-Filter (bestätigt):** **exakter Treffer** — Heading muss exakt im `headings`-Array stehen (Qdrant-Array-Match). Kein Teilstring.
10. **Frontend:** neue `search`-Kategorie in der Settings-UI (Toggles + Boost-Faktor).
11. **Zwei Stufen:** Stufe 1 speichert, Stufe 2 nutzt. Stufe 2 braucht Stufe 1.

## Abhängigkeit

```
Stufe 1 (Speichern)  →  Stufe 2 (Nutzen)
   upsert + Processor      Config + Filter + Rerank + Zitat + ask + Frontend
```

Stufe 2 ohne Stufe 1 = keine Metadaten im Payload → Filter/Rerank/Zitat leer. Reihenfolge einhalten.

---

## Stufe 1 — Speichern

### 1.1 `QdrantService.upsert()` — Payload-Felder erweitern

Datei: `server/src/Services/QdrantService.js`

```js
async upsert(vector, {
    text: chunkText = '',
    path,
    source = '',
    headings = [],
    page_numbers = [],
    chunk_index = null,
    captions = []
} = {}) {
    const hex = sha256Hex(`${chunkText}\0${source}`);
    const id = hashToUuid(hex);
    const payloadPath = (path ?? source) || '';

    const payload = {
        points: [
            {
                id,
                vector: vector,
                payload: {
                    text: chunkText,
                    path: payloadPath,
                    source: String(source) || '',
                    headings: Array.isArray(headings) ? headings : [],
                    page_numbers: Array.isArray(page_numbers) ? page_numbers : [],
                    chunk_index: chunk_index ?? null,
                    captions: Array.isArray(captions) ? captions : []
                }
            }
        ]
    };
    // ... Rest (try/catch, ensureCollection) unverändert
}
```

- Backward-kompatibel: Defaults halten das alte Verhalten.
- `Array.isArray`-Guard gegen undefinierte/nicht-Array-Werte.
- JSDoc um die neuen Parameter ergänzen.

### 1.2 `DoclingProcessor.processUpsert()` — Felder an `upsert()` übergeben

Datei: `server/src/Services/File/DoclingProcessor.js`

```js
for (const chunk of chunks) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const vector = await this.embeddings.embed(chunk.text);   // Embedding = chunk.text (unverändert)
    await this.qdrant.upsert(vector, {
        text: chunk.text,
        path: job.path,
        source: job.path,
        headings: chunk.headings,
        page_numbers: chunk.page_numbers,
        chunk_index: chunk.chunk_index,
        captions: chunk.captions
    });
}
```

- `chunk()` liefert bereits die vollen Objekte → keine Änderung dort.
- Embedding-Input bleibt `chunk.text`.

### 1.3 `QdrantService.search()` — optionaler Filter-Parameter

Datei: `server/src/Services/QdrantService.js`

```js
async search(vector, limit = 3, filter = null) {
    try {
        const params = { query: vector, limit, with_payload: true };
        if (filter) params.filter = filter;
        const results = await this.client.query(this.collection, params);
        return results?.points || [];
    } catch (err) {
        if (this.isCollectionNotFoundError(err)) return [];
        throw err;
    }
}
```

- `filter` = Qdrant-Filter-Objekt (optional). Ohne Filter → Verhalten wie heute.
- Basis für Stufe 2.1 (Filter).

---

## Stufe 2 — Nutzen (config-driven)

### 2.0 Config — neue `search`-Gruppe

Datei: `server/src/Config.js`

```js
const SEARCH_PARAMS = {
    rerankEnabled: { env: 'SEARCH_RERANK_ENABLED', type: 'boolean', default: true },
    rerankBoost: { env: 'SEARCH_RERANK_BOOST', type: 'number', default: 0.05 },
    citationEnabled: { env: 'SEARCH_CITATION_ENABLED', type: 'boolean', default: true },
};
```

Wiring (wie die anderen Gruppen):
- `runtimeKeys`: `'search'` hinzufügen.
- Constructor: `this.search = this.resolveParams(SEARCH_PARAMS, loaded?.search, 'search')`.
- `envLocked`: `search: {}` hinzufügen.
- `getSettings()`: `search: { ...this.search }`.
- `validateSettings()`: `rerankEnabled` Boolean, `rerankBoost` Zahl >= 0, `citationEnabled` Boolean.
- `updateSettings()`: `p.search = this.stripEnvLocked(patch.search, 'search')` + Deep-Merge + Runtime-State.
- `persist()`: `search: this.search`.
- `saveDefaults()`: `search: Object.fromEntries(Object.entries(SEARCH_PARAMS).map(([k, s]) => [k, s.default]))`.
- Export: `SEARCH_PARAMS`.

Datei: `server/index.js`
- Constructor: `SearchService` um `rerankEnabled: config.search.rerankEnabled`, `rerankBoost: config.search.rerankBoost`, `citationEnabled: config.search.citationEnabled` erweitern.
- `_onConfigChange`: `if (changed.includes('search')) { this.search.updateConfig({ rerankEnabled, rerankBoost, citationEnabled }); }`.

Datei: `server/src/Services/SearchService.js`
- Constructor: `rerankEnabled = true`, `rerankBoost = 0.05`, `citationEnabled = true` (Parameter + `this.*`).
- `updateConfig()`: die 3 Felder setzen (wenn `!== undefined`).

### 2.1 Filter (Suchraum verkleinern, vorher)

Datei: `server/src/Services/SearchService.js`

```js
/**
 * Baut ein Qdrant-Filter-Objekt aus optionalen Such-Optionen.
 * @param {{source?: string, heading?: string, page?: number}} opts
 * @returns {object|null} Qdrant-Filter oder null (keine Filter)
 */
buildFilter({ source, heading, page } = {}) {
    const must = [];
    if (source) must.push({ key: 'source', match: { value: source } });
    if (heading) must.push({ key: 'headings', match: { value: heading } });
    if (page != null) must.push({ key: 'page_numbers', match: { value: page } });
    return must.length ? { must } : null;
}
```

`searchAndReturnChunks()` — optionaler Options-Parameter (Endzustand, inkrementell aufgebaut):

```js
async searchAndReturnChunks(question, { source, heading, page } = {}) {
    const queryVector = await this.embeddings.embed(question);
    const filter = this.buildFilter({ source, heading, page });
    let results = await this.qdrant.search(queryVector, this.topK, filter);
    if (!results || results.length === 0) return [];
    results = this.rerank(results, question);   // 2.2 (config-driven)
    return results.map((item) => ({             // 2.3 (config-driven)
        text: item.payload?.text || '',
        score: item.score || 0,
        ...(this.citationEnabled ? { citation: this.buildCitation(item.payload) } : {}),
        metadata: {
            path: item.payload?.path || '',
            headings: item.payload?.headings || [],
            page_numbers: item.payload?.page_numbers || [],
            chunk_index: item.payload?.chunk_index ?? null,
            captions: item.payload?.captions || []
        }
    }));
}
```

MCP-Tool `search` — optionale Filter-Felder:

Datei: `server/src/Services/McpService.js`

```js
inputSchema: z.object({
    question: z.string().describe('Die Suchanfrage'),
    source: z.string().optional().describe('Nur Treffer aus dieser Datei (Pfad).'),
    heading: z.string().optional().describe('Nur Treffer mit dieser Überschrift.'),
    page: z.number().int().positive().optional().describe('Nur Treffer von dieser Seite.')
}),
async ({ question, source, heading, page }) => {
    const chunks = await this.search.searchAndReturnChunks(question, { source, heading, page });
    // ... Rest (leere Liste / JSON) unverändert
}
```

- Backward-kompatibel: alle Felder optional, `question` bleibt Pflicht.
- Qdrant-Array-Match: `match: { value: X }` trifft, wenn X in dem Array-Feld vorkommt.

### 2.2 Rerank (Treffer neu sortieren, nachher) — config-driven

Datei: `server/src/Services/SearchService.js`

```js
/**
 * Heuristischer Rerank: boostet Chunks, deren headings/captions
 * Query-Keywords enthalten. Config-gesteuert (rerankEnabled, rerankBoost).
 * @param {Array<object>} results - Qdrant-Punkte ({ score, payload })
 * @param {string} question - Suchanfrage
 * @returns {Array<object>} neu sortierte Punkte
 */
rerank(results, question) {
    if (!this.rerankEnabled) return results;
    const keywords = this.extractKeywords(question);
    if (!keywords.length) return results;
    const scored = results.map((item) => {
        const p = item.payload || {};
        let boost = 0;
        for (const h of p.headings || []) {
            const hl = String(h).toLowerCase();
            if (keywords.some((k) => hl === k)) boost += 2;
            else if (keywords.some((k) => hl.includes(k))) boost += 1;
        }
        for (const c of p.captions || []) {
            if (keywords.some((k) => String(c).toLowerCase().includes(k))) boost += 1;
        }
        return { ...item, score: (item.score || 0) + boost * this.rerankBoost };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored;
}

/**
 * Extrahiert relevante Keywords aus der Frage (Stopwords raus, min. 3 Zeichen).
 * @param {string} question
 * @returns {string[]}
 */
extractKeywords(question) {
    const stop = new Set(['der','die','das','und','oder','in','auf','für','mit','wie','was','ist','sind','steht','über','eine','einen','einem']);
    return String(question).toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !stop.has(w));
}
```

- `rerankEnabled=false` → no-op (Reihenfolge unverändert).
- Boost-Faktor = `this.rerankBoost` (Config).
- Exakter Heading-Treffer zählt doppelt, Teiltreffer einfach.
- Cross-Encoder-Reranker (Cohere/bge) = spätere Option, eigenes Modell, ersetzt diese Heuristik.

### 2.3 Zitat (Quelle anzeigen, Anzeige) — config-driven

Datei: `server/src/Services/SearchService.js`

```js
/**
 * Zitat-Zeile aus Chunk-Metadaten.
 * Beispiel: "report.pdf · S. 12 · Kapitel 3"
 * @param {object} payload
 * @returns {string}
 */
buildCitation(payload = {}) {
    const parts = [];
    if (payload.path) parts.push(payload.path);
    if (Array.isArray(payload.page_numbers) && payload.page_numbers.length) {
        parts.push(`S. ${payload.page_numbers.join(', ')}`);
    }
    if (Array.isArray(payload.headings) && payload.headings.length) {
        parts.push(payload.headings[payload.headings.length - 1]);
    }
    return parts.join(' · ');
}
```

- `citation` wird pro Chunk in `searchAndReturnChunks()` gesetzt, **nur wenn `citationEnabled`** (siehe 2.1).
- MCP-Tool `search` gibt die Chunks als JSON zurück → `citation` ist automatisch enthalten.

### 2.4 ask-Tool (RAG) — Rerank + Zitat (Quellen anhängen)

Entscheidung: Quellen werden **an die Antwort angehängt** (nicht in den LLM-Kontext). LLM antwortet aus den Chunk-Texten; der Nutzer sieht danach einen sauberen `Quellen:`-Block mit den exakt genutzten Chunks.

Datei: `server/src/Services/SearchService.js`

`searchAndAnswer()` — Rerank + Quellen an die Antwort anhängen (beide config-gesteuert):

```js
async searchAndAnswer(question) {
    try {
        this.logger.log(this.label, `Generating embedding for: "${question}"...`);
        const queryVector = await this.embeddings.embed(question);

        this.logger.log(this.label, 'Searching in Qdrant...');
        let results = await this.qdrant.search(queryVector, this.topK);

        if (!results || results.length === 0) {
            this.logger.log(this.label, 'No matching documents found.');
            return;
        }

        results = this.rerank(results, question);   // no-op wenn rerankEnabled=false

        const context = results
            .map((item) => item.payload?.text)
            .filter(Boolean)
            .join('\n\n---\n\n');

        const messages = [
            { role: 'system', content: `${this.systemPrompt}\n\n${context}` },
            { role: 'user', content: question }
        ];

        const answer = await this.chat.chat(messages);

        // Quellen ANHÄNGEN (wenn citationEnabled)
        if (this.citationEnabled) {
            const citations = results.map((item) => this.buildCitation(item.payload)).filter(Boolean);
            if (citations.length) {
                return `${answer}\n\nQuellen:\n${citations.map((c) => `- ${c}`).join('\n')}`;
            }
        }
        return answer;
    } catch (err) {
        this.logger.error(this.label, '[Error]', err);
    }
}
```

`streamAndAnswer()` — Rerank + `citations`-Event vor `done` (wenn `citationEnabled`):

```js
async *streamAndAnswer(question, { signal } = {}) {
    yield { type: 'status', phase: 'embedding', message: 'Embedding wird erzeugt…' };
    const queryVector = await this.embeddings.embed(question);

    yield { type: 'status', phase: 'search', message: 'Durchsuche Dokumente…' };
    let results = await this.qdrant.search(queryVector, this.topK);

    if (!results || results.length === 0) {
        yield { type: 'empty' };
        return;
    }

    results = this.rerank(results, question);   // no-op wenn rerankEnabled=false

    const context = results
        .map((item) => item.payload?.text)
        .filter(Boolean)
        .join('\n\n---\n\n');

    const messages = [
        { role: 'system', content: `${this.systemPrompt}\n\n${context}` },
        { role: 'user', content: question }
    ];

    yield { type: 'status', phase: 'thinking', message: 'Modell denkt…' };
    for await (const { phase, token } of this.chat.streamChat(messages, { signal })) {
        yield { type: phase, token };
    }

    // Quellen ANHÄNGEN (wenn citationEnabled)
    if (this.citationEnabled) {
        const citations = results.map((item) => this.buildCitation(item.payload)).filter(Boolean);
        if (citations.length) {
            yield { type: 'citations', text: `Quellen:\n${citations.map((c) => `- ${c}`).join('\n')}` };
        }
    }

    yield { type: 'done' };
}
```

Datei: `server/src/Router/SearchRouter.js`
- `/search/stream`: neuen Event-Typ `citations` mappen (vor `done`):
  ```js
  else if (ev.type === 'citations') ok = send('citations', { text: ev.text });
  ```
  Bestehende Consumer ignorieren unbekannte Events (`else ok = true`) → backward-kompatibel.

- `ask`-Tool (MCP) nutzt `searchAndAnswer` → Quellen sind automatisch im Antwort-String enthalten.
- Gleiche Config-Toggles wie search → ein Toggle steuert beide.

---

## Frontend — Settings-UI (neue `search`-Kategorie)

### F1. Neue Kategorie in `SettingsPage.jsx`

Datei: `frontend/src/pages/SettingsPage.jsx`

```jsx
import SearchSettings from '../components/settings/SearchSettings.jsx';
// CATEGORIES:
{ id: 'search', title: 'settings.categories.search', component: SearchSettings },
```

### F2. Neue `SearchSettings.jsx`

Datei: `frontend/src/components/settings/SearchSettings.jsx` (Muster: `StorageSettings.jsx`)

```jsx
const FIELDS = [
    { key: 'rerankEnabled', type: 'checkbox', label: 'settings.search.rerankEnabled', hint: 'settings.search.rerankEnabledHint' },
    { key: 'rerankBoost', type: 'number', label: 'settings.search.rerankBoost', hint: 'settings.search.rerankBoostHint', min: 0, step: 0.01 },
    { key: 'citationEnabled', type: 'checkbox', label: 'settings.search.citationEnabled', hint: 'settings.search.citationEnabledHint' },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);
// useSettingsGroup('search', FIELD_KEYS, settings, save)
```

### F3. i18n-Keys

Datei: `frontend/src/i18n.js` (de + en)

- `settings.categories.search`
- `settings.search.title`
- `settings.search.rerankEnabled` + `settings.search.rerankEnabledHint`
- `settings.search.rerankBoost` + `settings.search.rerankBoostHint`
- `settings.search.citationEnabled` + `settings.search.citationEnabledHint`

- `SettingsField.jsx` unterstützt bereits `checkbox` + `number` → keine Änderung dort.
- `useSettingsGroup('search', ...)` liest `settings.search` → passt zum Config-Gruppen-Namen.

---

## Tests

### Stufe 1

`server/test/qdrant.test.js`
- **Wird brechen:** Test `upsert sends a deterministic id and a full payload` (Zeile 46-50) erwartet exakt `{ text, path, source }`. → Erwarteten Payload um `headings: []`, `page_numbers: []`, `chunk_index: null`, `captions: []` erweitern.
- Neu: `upsert stores chunk metadata in the payload` → `upsert([0.1], { text: 'x', source: 'x.md', headings: ['H1'], page_numbers: [3], chunk_index: 0, captions: ['c'] })` → `point.payload` enthält die Felder.
- Neu: `upsert defaults missing metadata to empty` → ohne Felder → `headings: []`, `chunk_index: null`.
- Neu: `search passes an optional filter to the client` → `search([0.1], 5, { must: [...] })` → `clientMock.query` bekommt `filter`.

`server/test/doclingProcessor.test.js`
- **Anpassen:** Happy Path (Zeile 94) — Mock-Chunks um Metadaten erweitern + Assertion prüfen, dass sie an `upsert()` durchgereicht werden:
  ```js
  axiosMock.post.mockResolvedValue({ data: { chunks: [
      { text: 'chunk1', headings: ['H1'], page_numbers: [1], chunk_index: 0, captions: [] },
      { text: 'chunk2', headings: ['H2'], page_numbers: [2], chunk_index: 1, captions: ['c'] }
  ] } });
  expect(qdrant.upsert).toHaveBeenCalledWith([0.1, 0.2], {
      text: 'chunk1', path: 'a.pdf', source: 'a.pdf',
      headings: ['H1'], page_numbers: [1], chunk_index: 0, captions: []
  });
  ```
- **Prüfen:** `embeddings.embed` wird weiterhin mit `chunk.text` aufgerufen (nicht mit headings) → sichert die "Embedding = chunk.text"-Entscheidung ab.

### Stufe 2

`server/test/config.test.js` (bestehend)
- Neu: `search`-Gruppe in Defaults (`rerankEnabled=true`, `rerankBoost=0.05`, `citationEnabled=true`).
- Neu: `validateSettings` akzeptiert gültige `search`-Werte, lehnt ungültige ab (z. B. `rerankBoost=-1`).
- Neu: `updateSettings` mit `search`-Patch → Runtime-State + `change`-Event (`changed` enthält `search`).

Neue Datei `server/test/searchService.test.js` (aktuell keine vorhanden):
- `buildFilter returns null when no options` → `buildFilter()` → `null`.
- `buildFilter builds a must array` → `{ source, heading, page }` → `{ must: [source, headings, page_numbers] }`.
- `extractKeywords removes stopwords and short words` → `"Was steht in der Sicherheit?"` → `['sicherheit']` (Stopwords `was`/`steht`/`in`/`der` + kurze Wörter raus).
- `rerank boosts chunks with matching headings` → 2 Punkte, einer mit `headings: ['Sicherheit']`, Query "Sicherheit" → boosteter Punkt oben.
- `rerank is a no-op when disabled` → `rerankEnabled=false` → Reihenfolge + Scores unverändert.
- `rerank returns unchanged when no keywords` → Query "a" (zu kurz) → Reihenfolge gleich.
- `buildCitation formats path, page and heading` → `{ path: 'r.pdf', page_numbers: [12], headings: ['Kapitel 3'] }` → `"r.pdf · S. 12 · Kapitel 3"`.
- `searchAndReturnChunks applies filter, rerank and citation` → Mock-Qdrant liefert Punkte mit Metadaten → Ergebnis enthält `citation` + `metadata.headings`.
- `searchAndReturnChunks omits citation when disabled` → `citationEnabled=false` → kein `citation`-Feld.
- `searchAndAnswer appends citations when enabled` → Mock-Qdrant + Mock-Chat → Antwort-String endet mit `Quellen:`-Block (nicht im System-Prompt).
- `searchAndAnswer skips citations when disabled` → `citationEnabled=false` → Antwort ohne `Quellen:`-Block.
- `streamAndAnswer yields citations event when enabled` → Generator liefert `{ type: 'citations', text: 'Quellen:…' }` vor `done`.
- `streamAndAnswer skips citations event when disabled` → `citationEnabled=false` → kein `citations`-Event.

`server/test/mcpService.test.js` (bestehend)
- `search`-Tool: optionale `source`/`heading`/`page` werden an `searchAndReturnChunks` durchgereicht.
- `search`-Tool: ohne optionale Felder → `searchAndReturnChunks(question, {})`.

Frontend (optional, wenn Test-Setup vorhanden)
- `SearchSettings` rendert 3 Felder (2 Toggles + 1 Number) aus `settings.search`.

## Nicht ändern

- `server/src/Services/File/FileProcessor.js` (Basis-Klasse, Dummy)
- `server/src/Services/DoclingService.js` (Status-Polling)
- Point-ID-Logik (`sha256Hex(text + source)`)
- `frontend/src/components/settings/SettingsField.jsx` (unterstützt bereits `checkbox`/`number`)
- `frontend/src/hooks/useSettingsGroup.js` (generisch, passt zum `search`-Gruppen-Namen)

## Verifikation

1. `npm test` in `server/` (Vitest) — alle Tests grün, bestehende Tests nur um die neuen Payload-Felder erweitert.
2. `npm run build` in `frontend/` — kein Build-Fehler (neue `SearchSettings.jsx` + i18n-Keys).
3. Manuell (optional):
   - Datei in storage-Root legen → Docling-Chunking → Qdrant-Punkt enthält `headings`/`page_numbers`/`chunk_index`/`captions`.
   - Settings-UI → `search`-Kategorie → Toggles an/aus → `config.json` enthält `search`-Gruppe.
   - MCP `search` mit `heading`-Filter → nur passende Chunks; ohne Filter → Chunks mit `citation`-Zeile.
   - MCP `ask` → Antwort enthält `Quellen:`-Abschnitt (wenn `citationEnabled`).

## Aufwand

- **Stufe 1:** 2 Dateien (`QdrantService.js`, `DoclingProcessor.js`) + `search()`-Parameter, 2 Testdateien.
- **Stufe 2 (Config):** `Config.js`, `index.js`, `SearchService.js`, `config.test.js`.
- **Stufe 2 (Filter/Rerank/Zitat/ask):** `SearchService.js`, `McpService.js`, `SearchRouter.js`, `searchService.test.js` (neu), `mcpService.test.js`.
- **Frontend:** `SettingsPage.jsx`, `SearchSettings.jsx` (neu), `i18n.js`.
- Keine Migration, keine neue Abhängigkeit, kein Breaking Change (alle neuen Felder/Parameter optional).
- Reihenfolge: Stufe 1 → Config → Filter → Rerank → Zitat → ask → Frontend.

---

## Sub-Agenten-Workflow (sequenziell)

Jede Phase = 1 Sub-Agent (`task` tool). **Sequenziell:** Phase N+1 startet erst nach grünem Abschluss von Phase N. Jede Phase hinterlässt grüne Tests + sauberen Zustand (kein halbfertiger Code).

### Prompt-Vorlage (pro Phase)

> Setze **Phase {N}** aus `.docs/PLAN/PLAN_CHUNKS.md` um.
> 1. Lies zuerst das PLAN-Dokument (Abschnitte der Phase).
> 2. Implementiere **nur** die Änderungen dieser Phase (siehe "Änderungen").
> 3. Füge die Tests aus "Tests" hinzu / passe sie an.
> 4. Führe `npm test` in `server/` aus → **alle Tests grün** (Frontend-Phase: `npm run build` in `frontend/`).
> 5. Keine Änderungen außerhalb dieser Phase.
> 6. Gib am Ende: geänderte Dateien, Test-Ergebnis, Definition of Done erfüllt (ja/nein).

### Phase 1 — Stufe 1: Metadaten speichern

- **Ziel:** Docling-Metadaten landen im Qdrant-Payload.
- **Voraussetzung:** keine (Start).
- **Änderungen:** 1.1 `upsert()`, 1.2 `processUpsert()`, 1.3 `search()`-Filter-Parameter.
- **Tests:** `qdrant.test.js` (upsert-Payload, search-Filter), `doclingProcessor.test.js` (Pass-through, `embed = chunk.text`).
- **Verifikation:** `npm test` grün.
- **Definition of Done:** Punkt in Qdrant hat `headings`/`page_numbers`/`chunk_index`/`captions`; Embedding = `chunk.text`; alle Tests grün.
- **Handoff:** Metadaten gespeichert, `search(vector, limit, filter)` vorhanden.

### Phase 2 — Config: `search`-Gruppe

- **Ziel:** Rerank + Zitat config-driven (an/aus + Boost-Faktor).
- **Voraussetzung:** Phase 1.
- **Änderungen:** 2.0 `SEARCH_PARAMS` in `Config.js` (Wiring: runtimeKeys, resolveParams, getSettings, validateSettings, updateSettings, persist, saveDefaults, export) + `index.js` (Wiring + `_onConfigChange`) + `SearchService` (Constructor + `updateConfig` für die 3 Felder).
- **Tests:** `config.test.js` (Defaults, validate, updateSettings + change-Event).
- **Verifikation:** `npm test` grün.
- **Definition of Done:** `config.search` existiert (`rerankEnabled`/`rerankBoost`/`citationEnabled`); `SearchService` liest die Werte; Config-Change → `updateConfig`.
- **Handoff:** Config-Gruppe + Wiring vorhanden, `SearchService` kennt `rerankEnabled`/`rerankBoost`/`citationEnabled`.

### Phase 3 — Stufe 2.1: Filter

- **Ziel:** Suchraum per Payload einschränken (vorher).
- **Voraussetzung:** Phase 1 (Metadaten da).
- **Änderungen:** 2.1 `buildFilter()`, `searchAndReturnChunks(question, opts)` (Filter + Metadata, **noch ohne** Rerank/Zitat), MCP-`search`-Tool (optionale Felder).
- **Tests:** `searchService.test.js` (`buildFilter`), `mcpService.test.js` (Durchreichung).
- **Verifikation:** `npm test` grün.
- **Definition of Done:** MCP `search` akzeptiert `source`/`heading`/`page`; Filter wird an Qdrant übergeben; `searchAndReturnChunks` liefert `metadata` (ohne `citation`).
- **Handoff:** Filter nutzbar, `searchAndReturnChunks(question, opts)` vorhanden (Filter + Metadata).

### Phase 4 — Stufe 2.2: Rerank

- **Ziel:** Treffer nach Metadaten neu sortieren (nachher), config-gesteuert.
- **Voraussetzung:** Phase 2 (Config) + Phase 3 (`searchAndReturnChunks`).
- **Änderungen:** 2.2 `rerank()`, `extractKeywords()` + `results = this.rerank(results, question);` in `searchAndReturnChunks` einfügen (vor dem `.map()`).
- **Tests:** `searchService.test.js` (`rerank`, `extractKeywords`, no-op wenn disabled).
- **Verifikation:** `npm test` grün.
- **Definition of Done:** Chunks mit passenden `headings` steigen nach oben; `rerankEnabled=false` → unverändert.
- **Handoff:** Rerank aktiv in `searchAndReturnChunks` (config-gesteuert).

### Phase 5 — Stufe 2.3: Zitat

- **Ziel:** Quelle pro Chunk anzeigen, config-gesteuert.
- **Voraussetzung:** Phase 2 (Config) + Phase 3 (`searchAndReturnChunks`).
- **Änderungen:** 2.3 `buildCitation()` + `citation:`-Zeile in `searchAndReturnChunks` einfügen (im `.map()`, nur wenn `citationEnabled`).
- **Tests:** `searchService.test.js` (`buildCitation`, Integration, omit wenn disabled).
- **Verifikation:** `npm test` grün.
- **Definition of Done:** Jedes Chunk hat `citation`-Zeile (wenn `citationEnabled`); MCP `search` gibt sie aus.
- **Handoff:** Zitat in Ergebnissen (config-gesteuert).

### Phase 6 — Stufe 2.4: ask-Tool (RAG)

- **Ziel:** RAG-Antwort nutzt Rerank + Zitat (Quellen anhängen).
- **Voraussetzung:** Phase 4 (Rerank) + Phase 5 (Zitat).
- **Änderungen:** 2.4 `searchAndAnswer()` (Rerank + `Quellen:` anhängen) + `streamAndAnswer()` (`citations`-Event) + `SearchRouter.js` (`citations`-Fall).
- **Tests:** `searchService.test.js` (`searchAndAnswer` mit/ohne Zitat, `streamAndAnswer` citations-Event, Rerank).
- **Verifikation:** `npm test` grün.
- **Definition of Done:** `ask`-Antwort endet mit `Quellen:`-Block (wenn `citationEnabled`); Stream liefert `citations`-Event; Rerank wirkt auf den Kontext.
- **Handoff:** ask-Tool nutzt Rerank + Zitat (config-gesteuert).

### Phase 7 — Frontend: Settings-UI

- **Ziel:** `search`-Kategorie in der Settings-UI (Toggles + Boost-Faktor).
- **Voraussetzung:** Phase 2 (Config-Gruppe existiert).
- **Änderungen:** F1 `SettingsPage.jsx` (Kategorie), F2 `SearchSettings.jsx` (neu), F3 `i18n.js` (Keys de + en).
- **Tests:** `npm run build` in `frontend/` (kein Build-Fehler). Optional: Render-Test.
- **Verifikation:** Build grün, `search`-Tab zeigt 3 Felder.
- **Definition of Done:** Settings-UI hat `search`-Kategorie; Toggles + Boost-Faktor änderbar; Save → `config.json` enthält `search`.
- **Handoff:** Frontend-UI fertig.

### Phase 8 — Integration & Verifikation

- **Ziel:** Gesamtes grün + manuelle Prüfung.
- **Voraussetzung:** Phasen 1-7.
- **Änderungen:** keine (nur Prüfung).
- **Tests:** voller `npm test` (server) + `npm run build` (frontend).
- **Verifikation:** manuell — Datei → Chunking → Payload; Settings-UI Toggles; MCP `search` mit/ohne Filter; MCP `ask` mit `Quellen:`.
- **Definition of Done:** alle Tests grün, Build grün, manuelle Checks ok, kein Breaking Change.
- **Handoff:** fertig, bereit für Review/Commit.

### Ablauf

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7 → Phase 8
(speichern) (config) (filter) (rerank) (zitat) (ask) (frontend) (integration)
```

- **Sequenziell:** jede Phase wartet auf grünen Abschluss der vorherigen.
- **Parallel möglich (optional):** Phase 4 (Rerank) und Phase 5 (Zitat) sind unabhängig voneinander → könnten parallel laufen, wenn gewünscht.
- **Zustand:** jede Phase hinterlässt grüne Tests + sauberen Zustand. Optional: `.HANDOFF_STATE.md` pro Phase aktualisieren (AGENTS.md-Protokoll).
- **Abbruch:** bei rotem Test → Phase nicht als done markieren, Fehler fixen, neu verifizieren.
