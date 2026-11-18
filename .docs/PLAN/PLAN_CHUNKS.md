# PLAN: Chunk-Metadaten im Qdrant-Payload (Filter / Rerank / Zitat)

## Ziel

Docling-Chunk-Metadaten in den Qdrant-Payload speichern und nutzen, um die Suche genauer zu machen.

- **Embedding bleibt `chunk.text`** (Vektor = Content, unverändert).
- **Metadaten als Payload** → Filter (Suchraum verkleinern), Rerank (Treffer neu sortieren), Zitat (Quelle anzeigen).

Keine Änderung am Embedding-Input. Keine neue Abhängigkeit. Keine Migration (neue Felder optional, alte Punkte behalten ihren Payload).

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
- MCP-Tool `search` ruft `searchAndReturnChunks(question)` auf, gibt `JSON.stringify(chunks)` zurück — `McpService.js:69-87`.
- `searchAndAnswer()` / `streamAndAnswer()` nutzen `item.payload?.text` als Kontext — `SearchService.js:92-96, 142-145`.

## Entscheidungen

1. **Embedding-Input = `chunk.text`** (unverändert). Headings gehen NICHT in den Vektor.
   - Grund: Vektor = gespeicherter Text (konsistent). Keine Token-Verdünnung. Kein Mismatch.
   - Kontext-Embedding (headings+text) = spätere Optimierung, erst bei ungenügendem Retrieval.
2. **Payload-Felder** (aus der Docling-Antwort):
   - `headings` (string[]) — Filter + Rerank + Zitat
   - `page_numbers` (number[]) — Filter + Zitat
   - `chunk_index` (number) — Reihenfolge/Rekonstruktion
   - `captions` (string[]) — Zitat (Bild-Kontext)
3. **Weglassen:**
   - `filename` — redundant mit `path`/`source`
   - `num_tokens` — Größe, keine Semantik (optional für Context-Budget)
   - `raw_text` — Duplikat von `text`
   - `doc_items` — Docling-intern
   - `metadata` — meist leer/geringer Wert
4. **Defensive Defaults:** Felder optional (`[]` / `null`), da Docling sie nicht immer liefert.
5. **Keine ID-Änderung:** Point-ID bleibt `sha256Hex(text + source)`. Neue Felder ändern die ID nicht → keine Migration.
6. **Zwei Stufen:** Stufe 1 speichert, Stufe 2 nutzt. Stufe 2 braucht Stufe 1 (Metadaten müssen da sein).

## Abhängigkeit

```
Stufe 1 (Speichern)  →  Stufe 2 (Nutzen)
   upsert + Processor      Filter + Rerank + Zitat
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

## Stufe 2 — Nutzen

### 2.1 Filter (Suchraum verkleinern, vorher)

Datei: `server/src/Services/SearchService.js`

Neue Methode `buildFilter()`:

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

`searchAndReturnChunks()` — optionaler Options-Parameter:

```js
async searchAndReturnChunks(question, { source, heading, page } = {}) {
    const queryVector = await this.embeddings.embed(question);
    const filter = this.buildFilter({ source, heading, page });
    let results = await this.qdrant.search(queryVector, this.topK, filter);
    if (!results || results.length === 0) return [];
    results = this.rerank(results, question);   // 2.2
    return results.map((item) => ({             // 2.3
        text: item.payload?.text || '',
        score: item.score || 0,
        citation: this.buildCitation(item.payload),
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

### 2.2 Rerank (Treffer neu sortieren, nachher)

Datei: `server/src/Services/SearchService.js`

```js
/**
 * Heuristischer Rerank: boostet Chunks, deren headings/captions
 * Query-Keywords enthalten. Gibt neu sortiertes Array zurück.
 * @param {Array<object>} results - Qdrant-Punkte ({ score, payload })
 * @param {string} question - Suchanfrage
 * @returns {Array<object>} neu sortierte Punkte
 */
rerank(results, question) {
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
        return { ...item, score: (item.score || 0) + boost * 0.05 };
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

- Boost-Faktor `0.05` = tunbar (Konstante auslagern, wenn nötig).
- Exakter Heading-Treffer zählt doppelt, Teiltreffer einfach.
- Cross-Encoder-Reranker (Cohere/bge) = spätere Option, eigenes Modell, ersetzt diese Heuristik.

### 2.3 Zitat (Quelle anzeigen, Anzeige)

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

- `citation` wird pro Chunk in `searchAndReturnChunks()` gesetzt (siehe 2.1).
- MCP-Tool `search` gibt die Chunks als JSON zurück → `citation` ist automatisch enthalten.
- Frontend-Anzeige (nice-to-have): `citation` als Quellenzeile unter dem Chunk rendern.

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

Neue Datei `server/test/searchService.test.js` (aktuell keine vorhanden):
- `buildFilter returns null when no options` → `buildFilter()` → `null`.
- `buildFilter builds a must array` → `{ source, heading, page }` → `{ must: [source, headings, page_numbers] }`.
- `extractKeywords removes stopwords and short words` → `"Was steht in der Sicherheit?"` → `['steht','sicherheit']` (Stopwords/`was`/`in`/`der` raus).
- `rerank boosts chunks with matching headings` → 2 Punkte, einer mit `headings: ['Sicherheit']`, Query "Sicherheit" → boosteter Punkt oben.
- `rerank returns unchanged when no keywords` → Query "a" (zu kurz) → Reihenfolge gleich.
- `buildCitation formats path, page and heading` → `{ path: 'r.pdf', page_numbers: [12], headings: ['Kapitel 3'] }` → `"r.pdf · S. 12 · Kapitel 3"`.
- `searchAndReturnChunks applies filter, rerank and citation` → Mock-Qdrant liefert Punkte mit Metadaten → Ergebnis enthält `citation` + `metadata.headings`.

`server/test/mcpService.test.js` (bestehend)
- `search`-Tool: optionale `source`/`heading`/`page` werden an `searchAndReturnChunks` durchgereicht.
- `search`-Tool: ohne optionale Felder → `searchAndReturnChunks(question, {})`.

## Nicht ändern

- `server/src/Services/File/FileProcessor.js` (Basis-Klasse, Dummy)
- `server/src/Services/DoclingService.js` (Status-Polling)
- `server/src/Config.js` (keine neuen Config-Felder nötig)
- Point-ID-Logik (`sha256Hex(text + source)`)
- `searchAndAnswer()` / `streamAndAnswer()` (RAG-Antwort bleibt `payload.text`-basiert; Zitat/Rerank optional nachrüstbar)

## Verifikation

1. `npm test` in `server/` (Vitest) — alle Tests grün, bestehende Tests nur um die neuen Payload-Felder erweitert.
2. Manuell (optional):
   - Datei in storage-Root legen → Docling-Chunking → Qdrant-Punkt enthält `headings`/`page_numbers`/`chunk_index`/`captions`.
   - MCP `search` mit `heading`-Filter → nur passende Chunks.
   - MCP `search` ohne Filter → Chunks mit `citation`-Zeile.

## Aufwand

- **Stufe 1:** 2 Dateien (`QdrantService.js`, `DoclingProcessor.js`) + `search()`-Parameter, 2 Testdateien.
- **Stufe 2:** 2 Dateien (`SearchService.js`, `McpService.js`), 1 neue + 1 bestehende Testdatei.
- Keine Migration, keine neue Abhängigkeit, kein Breaking Change (alle neuen Felder/Parameter optional).
- Reihenfolge: Stufe 1 zuerst, dann Stufe 2.

---

## Sub-Agenten-Workflow (sequenziell)

Jede Phase = 1 Sub-Agent (`task` tool). **Sequenziell:** Phase N+1 startet erst nach grünem Abschluss von Phase N. Jede Phase hinterlässt grüne Tests + sauberen Zustand (kein halbfertiger Code).

### Prompt-Vorlage (pro Phase)

> Setze **Phase {N}** aus `.docs/PLAN/PLAN_CHUNKS.md` um.
> 1. Lies zuerst das PLAN-Dokument (Abschnitte der Phase).
> 2. Implementiere **nur** die Änderungen dieser Phase (siehe "Änderungen").
> 3. Füge die Tests aus "Tests" hinzu / passe sie an.
> 4. Führe `npm test` in `server/` aus → **alle Tests grün**.
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

### Phase 2 — Stufe 2.1: Filter

- **Ziel:** Suchraum per Payload einschränken (vorher).
- **Voraussetzung:** Phase 1 (Metadaten da).
- **Änderungen:** 2.1 `buildFilter()`, `searchAndReturnChunks(question, opts)`, MCP-`search`-Tool (optionale Felder).
- **Tests:** `searchService.test.js` (`buildFilter`), `mcpService.test.js` (Durchreichung).
- **Verifikation:** `npm test` grün.
- **Definition of Done:** MCP `search` akzeptiert `source`/`heading`/`page`; Filter wird an Qdrant übergeben.
- **Handoff:** Filter nutzbar, `searchAndReturnChunks(question, opts)` vorhanden.

### Phase 3 — Stufe 2.2: Rerank

- **Ziel:** Treffer nach Metadaten neu sortieren (nachher).
- **Voraussetzung:** Phase 2 (`searchAndReturnChunks` vorhanden).
- **Änderungen:** 2.2 `rerank()`, `extractKeywords()`.
- **Tests:** `searchService.test.js` (`rerank`, `extractKeywords`).
- **Verifikation:** `npm test` grün.
- **Definition of Done:** Chunks mit passenden `headings` steigen nach oben; ohne Keywords unverändert.
- **Handoff:** Rerank aktiv in `searchAndReturnChunks`.

### Phase 4 — Stufe 2.3: Zitat

- **Ziel:** Quelle pro Chunk anzeigen.
- **Voraussetzung:** Phase 2 (`searchAndReturnChunks` vorhanden).
- **Änderungen:** 2.3 `buildCitation()`.
- **Tests:** `searchService.test.js` (`buildCitation`, Integration).
- **Verifikation:** `npm test` grün.
- **Definition of Done:** Jedes Chunk hat `citation`-Zeile; MCP `search` gibt sie aus.
- **Handoff:** Zitat in Ergebnissen.

### Phase 5 — Integration & Verifikation

- **Ziel:** Gesamtes grün + manuelle Prüfung.
- **Voraussetzung:** Phasen 1-4.
- **Änderungen:** keine (nur Prüfung).
- **Tests:** voller `npm test`.
- **Verifikation:** manuell — Datei → Chunking → Payload; MCP `search` mit/ohne Filter; `citation`-Zeile.
- **Definition of Done:** alle Tests grün, manuelle Checks ok, kein Breaking Change.
- **Handoff:** fertig, bereit für Review/Commit.

### Ablauf

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5
(speichern) (filter) (rerank) (zitat) (integration)
```

- **Sequenziell:** jede Phase wartet auf grünen Abschluss der vorherigen.
- **Parallel möglich (optional):** Phase 3 (Rerank) und Phase 4 (Zitat) sind unabhängig voneinander → könnten parallel laufen, wenn gewünscht.
- **Zustand:** jede Phase hinterlässt grüne Tests + sauberen Zustand. Optional: `.HANDOFF_STATE.md` pro Phase aktualisieren (AGENTS.md-Protokoll).
- **Abbruch:** bei rotem Test → Phase nicht als done markieren, Fehler fixen, neu verifizieren.
