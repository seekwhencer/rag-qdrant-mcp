# Plan Docling Processing (Chunking → Embeddings → Qdrant)

Ziel: Die echte Verarbeitungskette einhängen. `FileProcessor` ist die **Base-Klasse**; neu kommt ein `DoclingProcessor`, der:

1. neue/geänderte Files aus dem Storage-Root an docling-serve schickt (`POST /v1/chunk/hybrid/file`),
2. die resultierenden Chunks über den bestehenden `EmbeddingsService` zu Vektoren macht,
3. die Vektoren in Qdrant speichert (Collection aus `config.qdrant.collection`).

Status: **Konzept, noch nicht umgesetzt.** API-Verträge gegen die Codebase verifiziert (`QdrantService`, `EmbeddingsService`, `FileStore`, `FileQueue`, `Config`, `SearchService`) — die in Abschnitt 4/6/7 zitierten Signaturen existieren exakt so.

**Entscheidung (final):** `DoclingProcessor` ist der **Default-Processor** (`storage.processor = 'docling'`). `DummyProcessor` bleibt als Fallback (Test / docling nicht konfiguriert). Die Base-Klasse `FileProcessor` bleibt **unverändert** — sie ist bereits das abstrakte Strategie-Interface.

> **Inspirationsquelle:** Die Qdrant-/Embedding-Verträge in diesem Plan sind 1:1 das bewährte Muster aus `gitea-qdrant-sync/server/qdrant.js` + `llm.js` (Point-ID-Hash, `path`/`source`-Alias, `deleteBySource`-Filter, Embedding-Cache). In diesem Repo sind beide bereits als `QdrantService` + `EmbeddingsService` implementiert — der Plan hängt nur die *Aufruf-Seite* (`DoclingProcessor`) daran. Details in Abschnitt 14.

---

## 1. Einordnung: Ist-Zustand

| Baustein | Status |
|---|---|
| `FileProcessor` (Base, abstrakt `process(job, signal)`) | vorhanden — `server/src/Services/File/FileProcessor.js` |
| `DummyProcessor` (Warten + Store-Update) | vorhanden — Platzhalter, soll ersetzt werden |
| `FileQueue` (Dispatcher, Retry, Abort, Dedup) | vorhanden — **unverändert** |
| `FileWatcher` (chokidar) | vorhanden — **unverändert** |
| `FileStore` (MariaDB, `files`-Tabelle) | vorhanden — **unverändert** |
| `QdrantService` (`upsert`, `search`, `deleteBySource`, `ensureCollection`) | vorhanden — **Point-ID-Hash ändern** (Namespace `source`, siehe 4.1) |
| `EmbeddingsService` (`embed(text) → vector`, Cache) | vorhanden — **unverändert** |
| `DoclingService` (nur Status-Polling) | vorhanden — **unverändert** (keine Convert-Aufrufe) |
| `FileService` (Orchestrator, Processor injizierbar) | vorhanden — **Processor-Wiring ändern** |
| Echte Verarbeitung (Chunking → Embeddings → Qdrant) | **fehlt** — das ist dieser Plan |

Der `FileProcessor`-Kommentar sagt es bereits: *„Später: hier echte Verarbeitung einhängen (Chunking → Embeddings → Qdrant), Interface bleibt gleich.“* — Genau das tut dieser Plan.

---

## 2. Architektur

### 2.1 Klassenstruktur

```
FileProcessor (Base-Klasse, UNVERÄNDERT)
    ├── DummyProcessor   (bestehend, Fallback/Test)
    └── DoclingProcessor (NEU)
```

- `FileProcessor` bleibt das abstrakte Strategie-Interface: `async process(job, signal) → result`, `resolvePath(job)`, `markDeleted(job)`.
- `DoclingProcessor extends FileProcessor` — erbt `resolvePath()` + `markDeleted()`, implementiert `process()`.
- `DummyProcessor` bleibt unverändert (Fallback + Referenz-Implementierung).

### 2.2 Datenfluss

```
storage/ (Volume)
   │ chokidar
   ▼
FileWatcher ──► FileQueue ──► DoclingProcessor
                              │
    create/modify:             │  1. stat (async, ENOENT-Race → wie delete)
                              │  2. Size-Limit → skipped
                              │  3. POST /v1/chunk/hybrid/file (multipart, X-Api-Key)
                              │  4. qdrant.deleteBySource(path)      ← alte Chunks löschen
                              │  5. pro Chunk: embeddings.embed(text) → qdrant.upsert(vector, meta)
                              │  6. store.upsert(path, { status: 'done', chunkCount, … })
                              │
   delete:                    │  1. qdrant.deleteBySource(path)      ← Chunks entfernen
                              │  2. markDeleted(job)                 ← Tombstone (geerbt)
                              ▼
              Qdrant (Collection aus config)  +  MariaDB (files-Tabelle)
```

Frontend, WebSocket-Protokoll, REST-API, Queue, Watcher, Store: **keine Änderungen** (Snapshot-Shape bleibt identisch).

### 2.3 Processor-Auswahl

Neue Config `storage.processor`: `'docling'` (Default) | `'dummy'`.

| `storage.processor` | `docling.url` | `embeddings`/`qdrant` | Ergebnis |
|---|---|---|---|
| `docling` | gesetzt | vorhanden | `DoclingProcessor` |
| `docling` | **leer** | egal | `DummyProcessor` + **prominenter Error-Log** (Graceful-Degradation, konsistent mit `DoclingService`-Muster „not configured") |
| `docling` | gesetzt | **fehlen** | `DummyProcessor` + **prominenter Error-Log** (Crash-Schutz: `DoclingProcessor`-Konstruktor würde sonst werfen → `FileService`-Konstruktor → Server-Start bricht) |
| `dummy` | egal | egal | `DummyProcessor` (Test / Legacy) |

**Begründung Fallback statt Hard-Fail:** Ohne `docling.url` ODER ohne `embeddings`/`qdrant` soll das System nicht crashen und die Queue nicht endlos fehlschlagen. Der Fallback ist laut geloggt, damit die Konfig-Lücke sofort sichtbar ist. (Alternative abgelehnt: `DoclingProcessor` wirft pro Job → alle Jobs enden in `error` + Retry-Loop = Rauschen ohne Mehrwert.)

---

## 3. Docling-API-Integration

### 3.1 Endpunkt

`POST {docling.url}/v1/chunk/hybrid/file` (Quelle: `data/docling/openapi/chunk.md` + `openapi.json`)

- **Auth:** Header `X-Api-Key: {docling.apiKey}` — laut OpenAPI `securitySchemes.APIKeyAuth` (`type: apiKey`, `in: header`, `name: X-Api-Key`).
  - Hinweis: `DoclingService` nutzt `Authorization: Bearer` für die **Status**-Endpunkte (`/health`, `/ready` — nicht unter `/v1/`). Für die `/v1/*`-Endpunkte gilt die OpenAPI-Spec: **`X-Api-Key`**.
- **Body:** `multipart/form-data`
- **Response:** `ChunkDocumentResponse` (JSON)

### 3.2 Multipart-Felder (aus `openapi.json`, `Body_Chunk_files_with_HybridChunker_…`)

Nur die Felder, die wir setzen (Rest = docling-Defaults):

| Feld | Typ | Wert |
|---|---|---|
| `files` *(required)* | binary[] | Datei-Stream (Name = Basename) |
| `chunking_max_tokens` | integer | `docling.maxTokens` (falls > 0) |
| `chunking_use_markdown_tables` | boolean | `docling.useMarkdownTables` |
| `chunking_use_markdown_images` | boolean | `docling.useMarkdownImages` |
| `chunking_merge_peers` | boolean | `true` (docling-Default, explizit) |
| `convert_do_ocr` | boolean | `docling.ocr` |

### 3.3 Response-Shape (`ChunkDocumentResponse`)

```json
{
  "chunks": [
    {
      "filename": "a.pdf",
      "chunk_index": 0,
      "text": "Chunk-Text mit Struktur-Kontext (Headings, Formatierung)",
      "raw_text": null,
      "num_tokens": 123,
      "headings": ["Titel", "Abschnitt"],
      "captions": [],
      "page_numbers": [1, 2],
      "metadata": { }
    }
  ],
  "documents": [ { "content": { }, "status": "success" } ],
  "processing_time": 1.23
}
```

**Genutzt:** `chunks[].text` — der *contextualized* Text (mit Headings-Kontext) ist die beste Eingabe für Embeddings. `chunks[].chunk_index` für deterministische Reihenfolge.

### 3.4 Request (axios, native `FormData`)

`axios ^1.20` unterstützt native `FormData` (Node 18+); axios setzt selbst den korrekten `Content-Type` mit Boundary.

```js
import axios from 'axios';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';

async chunk(job, signal) {
    const { url, apiKey, timeoutSec, maxTokens, useMarkdownTables, useMarkdownImages, ocr } = this.doclingConfig;
    const base = normalizeUrl(url);
    const abs = this.resolvePath(job);

    const form = new FormData();
    form.append('files', createReadStream(abs), basename(abs));
    if (maxTokens > 0) form.append('chunking_max_tokens', String(maxTokens));
    form.append('chunking_use_markdown_tables', String(useMarkdownTables));
    form.append('chunking_use_markdown_images', String(useMarkdownImages));
    form.append('chunking_merge_peers', 'true');
    form.append('convert_do_ocr', String(ocr));

    const res = await axios.post(`${base}/v1/chunk/hybrid/file`, form, {
        headers: apiKey ? { 'X-Api-Key': apiKey } : {},
        timeout: timeoutSec * 1000,
        signal
    });
    return res.data?.chunks || [];
}
```

- `signal` (AbortSignal aus `FileQueue`) → axios bricht den Request ab (`AbortError`).
- `timeout` aus Config (`docling.timeoutSec`, Default 300 s — große PDFs brauchen Zeit).
- Fehler (HTTP ≠ 2xx, Timeout, Netzwerk) → axios wirft → `process()` wirft → `FileQueue`-Retry greift (bestehend).
- `normalizeUrl` = **bestehender** Helper `server/src/Utils/url.js` (trailing-Slash-Strip) — kein neuer Code, identisch zum `DoclingService`-Muster.
- `this.doclingConfig` = `this.config.docling` (Getter wie in `DoclingService.doclingConfig`) → Config wird **pro Job** gelesen, wirkt ohne Neustart.

---

## 4. Qdrant-Integration

### 4.1 Upsert (API + Point-ID-Hash)

```js
await this.qdrant.upsert(vector, {
    text: chunk.text,
    path: job.path,      // relativer Pfad (Anzeige in Search-Ergebnissen)
    source: job.path     // relativer Pfad (Filter für deleteBySource!)
});
```

- **Point-ID:** `hashToUuid(sha256Hex(text + '\0' + source))` — **geändert** in `QdrantService.upsert` (`server/src/Services/QdrantService.js:207`; Helpers `sha256Hex`/`hashToUuid` aus `server/src/Utils/hash.js`). Namespace = `source` (relativer Pfad) → **eindeutig pro File** → idempotenter Upsert (gleicher Text + gleicher Pfad = gleiche ID = Update statt Duplikat).
- **`repository`/`ref` entfernen (Pflicht):** `QdrantService.upsert()` nimmt heute `repository` + `ref` als Parameter und legt sie in den Payload (`QdrantService.js:204-205, 223-224`). Beides ist Git-Sync-Rückstand, wird hier nicht gebraucht → **beide Parameter + beide Payload-Felder entfernen** (JSDoc `@param` kürzen). `SearchService.searchAndReturnChunks()` liest `repository`/`ref` aus dem Payload (`SearchService.js:178, 180`) → **beide Zeilen entfernen** (nur `path` bleibt).
- **Test-Update (Pflicht):** `server/test/qdrant.test.js` — (a) Hash: Zeile 38 `createHash('sha256').update('hello\0repo')` → `createHash('sha256').update('hello\0a.md')` (Hash nutzt jetzt `source`, Test übergibt `source: 'a.md'`); (b) `repository`/`ref` aus den `upsert()`-Aufrufen (Zeile 31: `repository: 'repo', ref: 'main'`; Zeile 58: `repository: 'r'`) + aus dem erwarteten Payload (Zeile 46-47: `repository: 'repo', ref: 'main'`) entfernen.
- **Warum `source` im Hash?** `source` (relativer Pfad) als Namespace → **eindeutig pro File**. Ohne Namespace (nur `sha256(text)`) kollidieren zwei Files mit identischem Chunk-Text (Boilerplate, License-Header) + `deleteBySource` bricht. Mit `source` im Hash: pro-File eindeutig.
- **Collection:** `config.qdrant.collection` (bestehend). Auto-Creation via `ensureCollection()` (Cosine, Size aus Vektorlänge) — bereits implementiert (`QdrantService.js:293`).
- **`source` = relativer Pfad:** entscheidend für `deleteBySource()` (siehe 4.2). `deleteBySource` filtert auf das Payload-Feld `source` (`QdrantService.js:267`) → **`source` muss gesetzt sein**, nicht nur `path`.
- **`path`/`source`-Alias:** In `QdrantService.upsert` gilt `payloadPath = (path ?? source) || ''` (`QdrantService.js:212`) — `path` ist nur das Anzeigefeld für `searchAndReturnChunks`, `source` ist der Filter. Beide auf `job.path` setzen = konsistent.

### 4.2 Orphan-Problem (kritisch)

Bei **modify** ändert sich der Chunk-Text → andere Point-IDs → **alte Points bleiben in Qdrant als Orphans** (verschmutzen die Suche).

**Lösung:** Vor dem Upsert der neuen Chunks: `qdrant.deleteBySource(job.path)` (löscht alle Points mit `source = relPath`).

**Reihenfolge pro create/modify-Job:**

1. docling-Chunking (API-Call)
2. `deleteBySource(path)` (alte Chunks löschen)
3. neue Chunks upserten
4. `store.upsert(path, { status: 'done', … })`

→ Chunking-Fehler: alte Chunks bleiben erhalten (kein Datenverlust). Upsert-Fehler: Retry wiederholt ab Schritt 2 (idempotent). Keine dauerhaften Duplikate.

### 4.3 Delete-Event

1. `qdrant.deleteBySource(job.path)` (Chunks aus Qdrant entfernen)
2. `markDeleted(job)` (Tombstone, **geerbt** von `FileProcessor`)

Beide Schritte idempotent → Retry-sicher.

---

## 5. Config

### 5.1 `storage.processor` (neu, `STORAGE_PARAMS`)

| Key | Env | Typ | Default | Bedeutung |
|---|---|---|---|---|
| `processor` | `STORAGE_PROCESSOR` | string | `docling` | `'docling'` \| `'dummy'` |

- `validateSettings()`: `storage.processor` muss `'docling'` oder `'dummy'` sein.
- `envLocked.storage.processor` wie bei den anderen Gruppen.
- `getSettings()` / `saveDefaults()` / `updateSettings()` entsprechend erweitern.

### 5.2 `docling`-Gruppe (erweitern, `DOCLING_PARAMS`)

| Key | Env | Typ | Default | Bedeutung |
|---|---|---|---|---|
| `url` | `DOCLING_URL` | string | `''` | *(bestehend)* Basis-URL |
| `apiKey` | `DOCLING_API_KEY` | string | `''` | *(bestehend, Secret)* API-Key |
| `statusPollIntervalSec` | `DOCLING_STATUS_POLL_INTERVAL_SEC` | integer | `30` | *(bestehend)* Status-Polling |
| `timeoutSec` | `DOCLING_TIMEOUT_SEC` | integer | `300` | **neu** Request-Timeout für den Chunking-Call |
| `maxTokens` | `DOCLING_MAX_TOKENS` | integer | `512` | **neu** Max. Tokens pro Chunk (0 = docling-Auto) |
| `useMarkdownTables` | `DOCLING_USE_MARKDOWN_TABLES` | boolean | `true` | **neu** Tabellen als Markdown (statt Triplets) |
| `useMarkdownImages` | `DOCLING_USE_MARKDOWN_IMAGES` | boolean | `false` | **neu** Bild-Referenzen in Chunks |
| `ocr` | `DOCLING_OCR` | boolean | `true` | **neu** OCR für Bitmap-Inhalte |

- `validateSettings()`: `timeoutSec` > 0; `maxTokens` >= 0; Booleans.
- `docling` ist bereits in `runtimeKeys` → Änderungen wirken ohne Neustart (Processor liest Config pro Job).
- Secret-Hygiene bleibt: `apiKey` nur aus Env, nie in `config.json` (bestehend).
- **Automatisch mitgenommen** (iterieren über die Param-Objekte, kein extra Code): `saveDefaults()` (schreibt Defaults in `config.json`), `getSettings()` (gibt Felder zurück), `updateSettings()` (Deep-Merge), `envLocked` (Env-Vorrang + UI-Lock-Badge).
- **Defaults prüfen (Entscheidung):** `maxTokens=512` überschreibt docling-Auto (besser `0` = Auto, wenn kein spezifisches Limit nötig?). `ocr=true` default = langsam (dev: `false`?). Beides Produkt-Entscheidung, hier bewusst gesetzt.

### 5.3 Settings-UI (Frontend, neu)

Die Config-Felder müssen in der Settings-UI editierbar sein. Bestehende Komponenten + Feld-Typen (`SettingsField.jsx` unterstützt `text`/`number`/`checkbox`/`select`/`list`/`password`/`textarea`/`readonly`):

| Komponente | Neues Feld | Typ | Options / Bounds |
|---|---|---|---|
| `StorageSettings.jsx` | `processor` | `select` | `['docling', 'dummy']` |
| `DoclingSettings.jsx` | `timeoutSec` | `number` | `min: 1, step: 1` |
| `DoclingSettings.jsx` | `maxTokens` | `number` | `min: 0, step: 1` (0 = docling-Auto) |
| `DoclingSettings.jsx` | `useMarkdownTables` | `checkbox` | — |
| `DoclingSettings.jsx` | `useMarkdownImages` | `checkbox` | — |
| `DoclingSettings.jsx` | `ocr` | `checkbox` | — |

- **i18n** (`frontend/src/locales/{de,en,it}.json`): je Label + Hint pro neuem Feld → `settings.storage.processor(Hint)`, `settings.docling.{timeoutSec,maxTokens,useMarkdownTables,useMarkdownImages,ocr}(Hint)`.
- **Env-Lock:** `useSettingsGroup` + `SettingsField` zeigen automatisch das `EnvLockBadge`, wenn ein Feld per Env gesetzt ist (`envLocked`) — kein extra Code.
- **Keine neuen Secrets:** `apiKey` bleibt das einzige Secret (Maskierung + Env-Vorrang bereits vorhanden). Die 6 neuen Felder sind nicht sensibel.
- **UX-Hinweis (optional):** `processor = 'docling'` + `docling.url` leer → Fallback auf Dummy (Abschnitt 2.3). In `StorageSettings`/`DoclingSettings` ein Hinweis-Text, dass ohne `docling.url` der Dummy-Processor greift.

---

## 6. `DoclingProcessor` (Implementierung)

`server/src/Services/File/DoclingProcessor.js` (neu)

### 6.1 API

```js
class DoclingProcessor extends FileProcessor {
    constructor({ config, store, embeddings, qdrant, logger })
    //   super({ config, store, logger })
    //   validiert: embeddings.embed ist Funktion, qdrant.upsert + qdrant.deleteBySource sind Funktionen

    get doclingConfig()              // this.config.docling (Getter wie DoclingService) — pro Job gelesen, wirkt ohne Neustart
    async process(job, signal)
    //   delete  → processDelete(job, signal)
    //   create/modify → processUpsert(job, signal)

    async processDelete(job, signal)
    async processUpsert(job, signal)
    async chunk(job, signal)          // axios multipart POST (siehe 3.4)
}
```

### 6.2 `processUpsert()` — Ablauf

```js
async processUpsert(job, signal) {
    // 1. stat (async, wie DummyProcessor): ENOENT-Race → wie delete behandeln
    let stats;
    try {
        stats = await stat(this.resolvePath(job));
    } catch (err) {
        if (err.code === 'ENOENT') return this.processDelete(job, signal);
        throw err;
    }

    // 2. Size-Limit (wie DummyProcessor): zu groß → skipped
    const maxBytes = (this.config.storage.maxFileSizeMb ?? Infinity) * 1024 * 1024;
    if (stats.size > maxBytes) {
        const entry = await this.store.upsert(job.path, { size: stats.size, mtime: …, ctime: …, status: 'skipped', lastEvent: job.event });
        return { status: 'skipped', path: job.path, event: job.event, size: stats.size, entry };
    }

    // 3. Chunking (docling)
    const chunks = await this.chunk(job, signal);

    // 4. Alte Chunks löschen (Orphan-Schutz, siehe 4.2)
    await this.qdrant.deleteBySource(job.path);

    // 5. Embeddings + Upsert (pro Chunk, sequenziell)
    for (const [i, chunk] of chunks.entries()) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const vector = await this.embeddings.embed(chunk.text);
        await this.qdrant.upsert(vector, { text: chunk.text, path: job.path, source: job.path });
    }

    // 6. Store-Update
    const entry = await this.store.upsert(job.path, {
        size: stats.size,
        mtime: stats.mtime.toISOString(),
        ctime: stats.ctime.toISOString(),
        status: 'done',
        lastEvent: job.event,
        processedAt: new Date().toISOString(),
        chunkCount: chunks.length
    });
    this.logger.log(this.label, 'File verarbeitet (Docling)', { path: job.path, event: job.event, size: stats.size, chunks: chunks.length });
    return { status: 'done', path: job.path, event: job.event, size: stats.size, entry };
}
```

- **`chunkCount`** landet im `meta`-JSON der `files`-Tabelle (Fangnetz, keine Migration nötig) → sichtbar im Dashboard/Snapshot.
- **Sequenziell** pro Chunk: `FileQueue.concurrency` (Default 1) begrenzt die parallele docling-Last ohnehin; Embedding-Cache (`EmbeddingsService`) spart Duplikate.
- **Abort-Check** zwischen Chunks (nach dem docling-Call, der selbst via `signal` abbrechbar ist).

### 6.3 `processDelete()` — Ablauf

```js
async processDelete(job, signal) {
    await this.qdrant.deleteBySource(job.path);   // Chunks entfernen (idempotent)
    const entry = await this.markDeleted(job);     // Tombstone (geerbt)
    this.logger.log(this.label, 'File gelöscht (Docling)', { path: job.path });
    return { status: 'deleted', path: job.path, event: job.event, size: null, entry };
}
```

---

## 7. Wiring

### 7.1 `FileService` (ändern)

**Ist-Zustand** (`server/src/Services/FileService.js`):
- Konstruktor (Zeile 40) nimmt `{ config, logger, database, store, processor, queue, watcher, watcherFactory, broadcastDebounceMs }` — **keine** `qdrant`/`embeddings`.
- Zeile 57: `this.processor = processor || new DummyProcessor({ config, store: this.store, logger: this.logger })` — harter `DummyProcessor`-Default.
- `onConfigChange()` (Zeile 366) behandelt heute nur `dataDir` / `enabled` / `root`.

**Änderung:**
- Konstruktor: neue optionale Parameter `qdrant`, `embeddings` (beide injizierbar für Tests). **Nicht** von `FileService` selbst erzeugt — sie kommen von `Router` via `search` (Abschnitt 7.2), sonst gäbe es einen zweiten Qdrant-/Embedding-Client. `createProcessor()` nutzt sie nur, wenn `kind === 'docling'` + `docling.url` gesetzt; `dummy`-Pfad braucht sie nicht.
- Processor-Auswahl (statt hartem `DummyProcessor`-Default):

```js
this.processor = processor || this.createProcessor();

createProcessor() {
    const kind = this.config.storage.processor || 'docling';
    if (kind === 'dummy') {
        return new DummyProcessor({ config: this.config, store: this.store, logger: this.logger });
    }
    // Crash-Schutz: docling.url ODER embeddings/qdrant fehlen → Dummy (sonst wirft der
    // DoclingProcessor-Konstruktor → FileService-Konstruktor → Server-Start bricht).
    if (!this.config.docling?.url || !this.embeddings || !this.qdrant) {
        this.logger.error(this.label, 'storage.processor=docling, aber docling.url/embeddings/qdrant fehlen → Fallback auf DummyProcessor');
        return new DummyProcessor({ config: this.config, store: this.store, logger: this.logger });
    }
    return new DoclingProcessor({
        config: this.config,
        store: this.store,
        embeddings: this.embeddings,
        qdrant: this.qdrant,
        logger: this.logger
    });
}
```

- `onConfigChange()` (Zeile 366): bei `changed` inkl. `storage` oder `docling` → Processor neu erzeugen + Queue-Referenz aktualisieren. **WICHTIG: am ANFANG von `onConfigChange` platzieren — VOR den Early-Returns** (`!this._started` Zeile 374, `!enabled` Zeile 383), sonst wirkt die Re-Creation NICHT bei disabled/pre-start:

```js
async onConfigChange(payload) {
    // NEU: Processor-Re-Creation zuerst (wirkt in ALLEN Zuständen, auch disabled/pre-start).
    if (payload?.changed && (payload.changed.includes('storage') || payload.changed.includes('docling'))) {
        this.processor = this.createProcessor();
        this.queue.processor = this.processor;   // FileQueue liest this.processor erst zur Job-Start-Zeit (FileQueue.js:139)
    }

    // ... bestehender Code (dataDir / !this._started / enabled / root) unverändert ...
}
```

`FileQueue` liest `this.processor` erst zur Job-Start-Zeit (`FileQueue.js:139`) → Reassignment wirkt ab dem **nächsten** Job, laufende Jobs bleiben beim alten Processor. So wirkt ein `docling.url`-Setzen zur Laufzeit ohne Neustart.

### 7.2 `Router/index.js` (ändern)

**Ist-Zustand** (`server/src/Router/index.js:85`): `this.fileService = new FileService({ config: this.config, database: this.database, logger: this.logger });`

`SearchService` trägt bereits die **gleichen** `qdrant`/`embeddings`-Instanzen aus `index.js` (öffentliche Properties `this.qdrant` / `this.embeddings`, `SearchService.js:52-56`; `DashboardService` nutzt `this.search?.qdrant` bereits, Zeile 92) → einfach durchreichen:

```js
this.fileService = new FileService({
    config: this.config,
    database: this.database,
    qdrant: this.search?.qdrant,
    embeddings: this.search?.embeddings,
    logger: this.logger
});
```

→ **Einzige Instanzen** (kein zweiter Qdrant-/Embedding-Client), Cache bleibt geteilt.

### 7.3 `index.js` / `Server.js`

- **Keine Änderung** — `qdrant`/`embeddings` entstehen bereits in `App` und fließen über `search` in den `Router`.

---

## 8. Fehlerbehandlung & Resilienz

| Szenario | Verhalten |
|---|---|
| docling down / Timeout | axios wirft → Job `error` → bestehender Retry (`storage.retryDelaySec`, `storage.maxRetries`) → danach endgültig `error` (sichtbar in Queue-UI) |
| docling 4xx (z. B. 422 ungültiges Format) | Job `error`. **Option:** `noRetry`-Flag (siehe 12.) |
| Qdrant down | `upsert`/`deleteBySource` wirft → Job `error` → Retry (Qdrant-Service reconnectet selbst im Hintergrund) |
| Embeddings down | `embed()` wirft → Job `error` → Retry |
| Abort (Queue-Abort) | `AbortError` → Job `cancelled` (bestehend). **Caveat:** bereits upsertete Chunks bleiben; werden beim nächsten create/modify via `deleteBySource` bereinigt |
| docling nicht konfiguriert | `DummyProcessor`-Fallback + Error-Log (siehe 2.3) |
| Datei während Processing gelöscht | ENOENT → wie delete (geerbt aus Dummy-Muster) |
| Datei > `maxFileSizeMb` | `skipped` (kein Fehler, wie Dummy) |
| 0 Chunks (leeres Dokument) | `done` mit `chunkCount: 0` (kein Fehler) |

---

## 9. Tests

### 9.1 `server/test/doclingProcessor.test.js` (neu, vitest)

Fake-`embeddings` (`embed: vi.fn().mockResolvedValue([0.1, 0.2])`), Fake-`qdrant` (`upsert`/`deleteBySource` als `vi.fn()`), Fake-`store` (wie in `fileProcessor.test.js`), `axios` via `vi.mock`.

| Test | Inhalt |
|---|---|
| create: Happy Path | axios `POST` auf `{url}/v1/chunk/hybrid/file` mit `X-Api-Key` + Multipart-Feldern; `chunks` → `embed` pro Chunk → `upsert` pro Chunk (Parameter: `text`, `path`, `source`); Store `status: 'done'` + `chunkCount` |
| modify: Orphan-Schutz | `deleteBySource(path)` wird **vor** den `upsert`s aufgerufen (Aufruf-Reihenfolge prüfen) |
| delete: Chunks + Tombstone | `deleteBySource(path)` + Store `status: 'deleted'` + `deletedAt` |
| ENOENT-Race | Datei weg → `status: 'deleted'` (wie Dummy) |
| Size-Limit | > `maxFileSizeMb` → `skipped` |
| docling 500 | `process()` rejectet (→ Queue-Retry) |
| docling 422 | `process()` rejectet; `err.noRetry === true` (falls 12. umgesetzt) |
| Abort | `AbortError`; bei laufendem axios-Call: `signal` wird übergeben |
| 0 Chunks | `done`, `chunkCount: 0`, kein `upsert`-Call |
| Config-Validierung | `embeddings`/`qdrant` fehlen → Konstruktor wirft |

### 9.2 `server/test/fileService.test.js` (erweitern)

| Test | Inhalt |
|---|---|
| Processor-Auswahl: `docling` + URL | `DoclingProcessor` wird erzeugt |
| Processor-Auswahl: `docling` ohne URL | `DummyProcessor`-Fallback + Error-Log |
| Processor-Auswahl: `docling` + URL, aber `embeddings`/`qdrant` fehlen | `DummyProcessor`-Fallback + Error-Log (Crash-Schutz) |
| Processor-Auswahl: `dummy` | `DummyProcessor` |
| Config-Change `docling` | `queue.processor` wird neu erzeugt |

### 9.3 `server/test/config.test.js` (erweitern)

- `storage.processor` (Default `docling`, Env-Override, Validierung)
- `docling.timeoutSec` / `maxTokens` / `useMarkdownTables` / `useMarkdownImages` / `ocr` (Defaults, Env-Override, Validierung)

### 9.4 E2E (manuell)

1. `docker compose -f compose.yml -f compose-db.yml -f compose-docling.yml up`
2. `DOCLING_URL=http://localhost:5001` setzen (Settings-UI oder Env).
3. PDF/DOCX in `storage/` legen → Queue-UI: Job `done`, `chunkCount > 0`.
4. Qdrant prüfen: `curl -X POST http://localhost:6333/collections/{collection}/points/scroll` → Points mit `text` + `path` vorhanden.
5. Datei ändern → alte Points weg, neue Points da (Orphan-Schutz).
6. Datei löschen → Points weg, Store-Tombstone.
7. docling stoppen → Job `error` + Retry; docling starten → Retry erfolgreich.

---

## 10. Dateien

### Neu

```
server/src/Services/File/DoclingProcessor.js
server/test/doclingProcessor.test.js
```

### Geändert

```
server/src/Config.js                    # storage.processor + docling.timeoutSec/maxTokens/useMarkdownTables/useMarkdownImages/ocr + Validierung
server/src/Services/FileService.js      # createProcessor() + qdrant/embeddings-Parameter + Config-Change-Neuerzeugung
server/src/Router/index.js              # qdrant + embeddings an FileService durchreichen
server/src/Services/QdrantService.js    # Point-ID-Hash: source (Pfad) als Namespace; repository/ref-Parameter + Payload-Felder entfernen
server/src/Services/SearchService.js    # searchAndReturnChunks(): repository/ref aus Metadata-Mapping entfernen
server/test/fileService.test.js         # Processor-Auswahl
server/test/config.test.js              # neue Config-Felder
server/test/qdrant.test.js              # Point-ID-Hash Zeile 38: `sha256('hello\0repo')` → `sha256('hello\0a.md')`; repository/ref aus upsert-Aufrufen + erwartetem Payload entfernen
frontend/src/components/settings/StorageSettings.jsx   # + processor (select: docling/dummy)
frontend/src/components/settings/DoclingSettings.jsx   # + timeoutSec/maxTokens/useMarkdownTables/useMarkdownImages/ocr
frontend/src/locales/de.json            # + Labels/Hints (storage.processor, docling.*)
frontend/src/locales/en.json            # + Labels/Hints (storage.processor, docling.*)
frontend/src/locales/it.json            # + Labels/Hints (storage.processor, docling.*)
```

### Unverändert

```
server/src/Services/File/FileProcessor.js   # Base-Klasse (bleibt abstrakt)
server/src/Services/File/DummyProcessor.js  # (in FileProcessor.js) Fallback
server/src/Services/File/FileQueue.js
server/src/Services/File/FileWatcher.js
server/src/Models/FileStore.js
server/src/Services/EmbeddingsService.js
server/src/Services/DoclingService.js      # Status-Polling bleibt getrennt
```

---

## 11. Umsetzungsschritte

1. **Qdrant-Cleanup**: `repository`/`ref` aus `QdrantService` + `SearchService` entfernen, Point-ID-Hash → `source`, `qdrant.test.js` anpassen (Abschnitt 4.1)
2. **Config**: `storage.processor` + `docling`-Erweiterung + Validierung + `config.test.js`
3. **`DoclingProcessor.js`** + `doclingProcessor.test.js` (alle Fälle aus 9.1)
4. **Wiring**: `FileService.createProcessor()` + `Router/index.js` + `fileService.test.js`
5. **E2E-Check** (Abschnitt 9.4)

> **Abarbeitung:** sequenziell mit Sub-Agenten — Workflow in Abschnitt 15.

---

## 12. Edge-Cases & offene Entscheidungen

| Thema | Entscheidung / Option |
|---|---|
| Orphan-Chunks bei modify | `deleteBySource(path)` vor Upsert (siehe 4.2) — **Pflicht** |
| Abort mitten im Upsert-Loop | Bereits upsertete Chunks bleiben; werden beim nächsten create/modify bereinigt. Akzeptabel (Abort = Nutzer-Intent) |
| 4xx-Retries sind sinnlos | **Option (Empfehlung: umsetzen):** `DoclingProcessor.chunk()` setzt bei HTTP 4xx `err.noRetry = true` — **außer 408 (Timeout) + 429 (Rate-Limit)**, die retrybar bleiben. `FileQueue.handleJobError()` (`FileQueue.js:177`) prüft `err.noRetry` → direkt `error` statt Retry. Konkrete Änderung (vor dem Retry-Block, nach dem Abort-Check): `if (err?.noRetry) { this.finishJob(job, 'error', err.message); return; }` — 1 Zeile. 5xx/Timeout/Netzwerk bleiben retrybar |
| Batch-Embeddings | Nicht jetzt: pro-Chunk `embed()` + Cache reicht (Concurrency 1). Später: `EmbeddingsService.embedBatch(texts[])` (Ollama/OpenAI unterstützen Array-Input) → weniger Roundtrips |
| Async-Endpunkt (`/async` + Poll) | Nicht jetzt: Sync-Call + `timeoutSec` reicht für Concurrency 1. Für sehr große Files später: `/v1/chunk/hybrid/file/async` + `GET /v1/status/poll/{task_id}` |
| Dateityp-Filter | Keiner im Processor: docling entscheidet (ungültiges Format → 4xx → Job `error`). `storage.whitelist` filtert bereits auf Pfad-Ebene |
| Auth-Header | `X-Api-Key` (OpenAPI-Spec). `DoclingService`-Bearer bleibt für Status-Endpunkte |
| Point-ID-Hash | **`source` (Pfad) als Namespace** (geändert, siehe 4.1) → pro-File eindeutig, keine Cross-File-Kollision |
| Migration bestehender Qdrant-Points | Point-ID-Hash ändert sich (`repository` → `source`). Bestehende Points haben die alte ID + evtl. kein `source`-Feld → `deleteBySource` findet sie nicht. **Einmaliger Cleanup vor First-Run:** `POST /collections/{name}/points/delete` mit Filter `must_not: [{ key: 'source', match: { value: true } }]` (löscht alle Points ohne `source`), ODER Collection komplett leeren + neu indexieren. In `QdrantService` als `cleanupLegacyPoints()`-Methode oder manuell via curl. **Pflicht vor Produktivbetrieb** |
| Collection-Wechsel zur Laufzeit | `qdrant.collection` wird pro `upsert`-Call aus dem Service gelesen → wirkt sofort (bestehend) |
| Data-Loss-Fenster (delete→upsert) | Crash zwischen `deleteBySource` (Schritt 2) + Upsert (Schritt 3) → File hat kurz keine Chunks. Heilt per Retry (Chunking wiederholt). RAG-Suche liefert in dem Fenster nichts. Akzeptabel (Alternative upsert-first + Orphan-Bereinigung = komplexer) |
| First-Run (Initial-Scan) | Watcher scannt beim Start ALLE Files → jedes File chunkt + embeddet. Großer Korpus = viele Embedding-Calls, Concurrency 1 → lang. Cache hilft nur bei Duplikaten. Einmalige Kosten, danach inkrementell |
| Embedding-Dimension-Wechsel | `ensureCollection` erstellt nur, wenn nicht vorhanden. Modellwechsel (andere Vektor-Dimension) → Upsert-Fehler (Size-Mismatch). Manuell: Collection löschen + neu indexieren. Nicht automatisch |

---

## 13. Aufwand

| Block | Schätzung |
|---|---|
| Config + Validierung + Tests | 0,25 Tag |
| `DoclingProcessor` + Unit-Tests | 0,5–1 Tag |
| Wiring (`FileService` + `Router`) + Tests | 0,25 Tag |
| Settings-UI (Storage/Docling + i18n de/en/it) | 0,25 Tag |
| E2E + Doku | 0,25 Tag |
| **Gesamt** | **~1,75–2,25 Tage** |

---

## 14. Referenzen & Inspirationsquellen

Die Qdrant-/Embedding-Verträge in diesem Plan sind **bewährtes Muster** aus dem Schwester-Projekt `gitea-qdrant-sync`. Dort sind sie als eigenständige Services implementiert; in diesem Repo existieren sie bereits als `QdrantService` + `EmbeddingsService` (gleiche Logik, plus Reconnect-/Status-Lifecycle). Der Plan hängt nur die *Aufruf-Seite* (`DoclingProcessor`) an.

| Quelle | Was übernommen / verifiziert |
|---|---|
| `gitea-qdrant-sync/server/qdrant.js` | `upsert(vector, {text, path, source, ...})`-Signatur; Point-ID = `sha256(text + '\0' + <namespace>)` → UUID; `path`/`source`-Alias; `deleteBySource(source)`-Filter; `ensureCollection(vector)` (Cosine, Size aus Vektorlänge); `isCollectionNotFoundError` (404/„not found"). → **in `QdrantService.js`** (Zeilen 200–313), **außer** Point-ID-Hash: hier `source` (Pfad) als Namespace (siehe 4.1). |
| `gitea-qdrant-sync/server/llm.js` | `embed(text)` mit SHA-256-Cache (identischer Chunk-Text → kein zweiter LLM-Call); Ollama/OpenAI-Dual-API; `normalizeUrl`-Helper; `host`-Header-Override. → **1:1 in `EmbeddingsService.js` + `LlmService.js`** (Cache Zeile 21/31, `normalizeUrl` aus `Utils/url.js`). |

**Konsequenz für den Plan:**
- `DoclingProcessor` muss **keine** Qdrant-/Embedding-Logik selbst implementieren — es ruft `this.qdrant.upsert(...)` / `this.qdrant.deleteBySource(...)` / `this.embeddings.embed(...)` auf (Abschnitt 4 + 6).
- Deterministische Point-IDs + `deleteBySource` machen die Orphan-Bereinigung (Abschnitt 4.2) und den idempotenten Upsert (Abschnitt 4.1) **kostenlos** — beides kommt aus dem bestehenden Service.
- Embedding-Cache spart Duplikate bei Concurrency 1 (Abschnitt 6.2) — bereits vorhanden, kein neuer Code.

---

## 15. Sub-Agenten-Workflow (sequenzielle Abarbeitung)

Ziel: Den Plan **sequenziell** mit Sub-Agenten abarbeiten — ein Sub-Agent pro Schritt, **foreground** (jeder wartet auf Abschluss + Verifikation des Vorgängers, bevor der nächste startet). Kein Parallelismus: jeder Schritt baut auf dem verifizierten Zustand des vorherigen auf.

**Regeln:**
- **Sequenziell:** Schritt N+1 startet erst, wenn Schritt N erfolgreich verifiziert ist (Tests grün).
- **Foreground:** Jeder Sub-Agent läuft synchron; Ergebnis wird geprüft, bevor der nächste startet.
- **Kein Duplizieren:** Der Sub-Agent macht die Änderung; der Koordinator (Main) prüft nur das Ergebnis.
- **Verifikation pro Schritt:** `npm test` (server) bzw. `npm run build` (frontend) muss grün sein, bevor der nächste Schritt startet.
- **Rollback:** Fehlschlag → Schritt wiederholen (neuer Sub-Agent mit Fehler-Kontext), nicht überspringen.

### 15.1 Schritte

| # | Sub-Agent | Scope | Verifikation |
|---|---|---|---|
| 1 | **Qdrant-Cleanup** | `repository`/`ref` aus `QdrantService.upsert()` (Parameter + Payload) + `SearchService.searchAndReturnChunks()` entfernen; Point-ID-Hash → `source`; `qdrant.test.js` anpassen (Abschnitt 4.1) | `npm test` (server) grün |
| 2 | **Config** | `storage.processor` + `docling.{timeoutSec,maxTokens,useMarkdownTables,useMarkdownImages,ocr}` + Validierung; `config.test.js` (Abschnitt 5) | `npm test` (server) grün |
| 3 | **DoclingProcessor** | `DoclingProcessor.js` (neu) + `doclingProcessor.test.js` (alle Fälle aus 9.1) (Abschnitt 6) | `npm test` (server) grün |
| 4 | **Wiring** | `FileService.createProcessor()` + `Router/index.js` (qdrant/embeddings durchreichen) + `fileService.test.js` (Abschnitt 7) | `npm test` (server) grün |
| 5 | **Settings-UI** | `StorageSettings.jsx` (+processor) + `DoclingSettings.jsx` (+5 Felder) + i18n de/en/it (Abschnitt 5.3) | `npm run build` (frontend) grün |
| 6 | **E2E** | Manueller E2E-Check (Abschnitt 9.4) | Alle 7 Punkte bestanden |

### 15.2 Prompt-Vorlage (pro Schritt)

Jeder Sub-Agent-Prompt enthält:
1. **Ziel** (1 Satz) — was der Schritt erreicht.
2. **Scope** — exakte Dateien + exakte Änderungen (Zeilen/Inhalt), wie in den Abschnitten 4-7.
3. **Constraints** — keine Kommentare, bestehender Style, keine fremden Dateien (z. B. React-`ref` in `LogViewer.jsx` bleibt).
4. **Verifikation** — exakter Test-Befehl + erwartetes Ergebnis.
5. **Report** — vor/nach je geänderter Zeile + Bestätigung der Verifikation.

**Beispiel Schritt 1 (Qdrant-Cleanup):**
> **Ziel:** `repository`/`ref` aus dem Qdrant-Payload entfernen, Point-ID-Hash auf `source` umstellen.
> **Scope:** `QdrantService.js` (upsert-Parameter + Payload + Hash + JSDoc), `SearchService.js` (Metadata-Mapping), `qdrant.test.js` (Aufrufe + erwarteter Payload + Hash).
> **Constraints:** keine Kommentare, 4-Space-Indent, Single-Quotes; `LogViewer.jsx` (React-`ref`) nicht anfassen.
> **Verifikation:** `npm test` im `server/`-Verzeichnis → alle Tests grün.
> **Report:** vor/nach je Zeile + Test-Ergebnis.

### 15.3 Koordinations-Loop (Main)

```
for step in [1..6]:
    result = launch_subagent(step, foreground)
    if result.verifikation != "grün":
        launch_subagent(step, foreground, context=result.fehler)   # Retry mit Fehler-Kontext
    # sonst: nächster Schritt
```

**Wichtig:** Dieser Abschnitt beschreibt den Workflow — er wird **nicht** automatisch ausgeführt. Ausführung erst auf explizite Anweisung.
