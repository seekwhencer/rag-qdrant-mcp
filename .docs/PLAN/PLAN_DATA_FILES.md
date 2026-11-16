# plan data files

Neues Feature: Datei-Verwaltung

- Es sollen Files und Ordner aus einem bestimmten Ordner verarbeitet werden.
- Der "bestimmte Ordner" ist der Root-Ordner für storage als docker shared volume (im compose file) und in der config vorhanden
- Dieser Ordner soll auf File-Änderungen überwacht werden (chokidar, websearch)
- Es gibt Trigger: "Datei erzeugt", "Datei geändert" und "Datei gelöscht"
- Die Ordner-Struktur der Files wird gespiegelt in einer Datenbank mit Meta-Informationen der Files
- Die Verarbeitung muss sequenziell - aber - die Gleichzeitigkeit muss über die Settings einstellbar sein
- Die Verarbeitungs-Queue läuft im Hintergrund
- Die Queue ist im Frontend einsehbar
- Die Queue aktualisiert sich im Frontend per Websockets (wie Dashboard, Logs)
- Man kann die Verarbeitung der Queue pausieren und abbrechen
- Man kann die Queue bearbeiten. Files entfernen aus der Queue.
- Erstelle einen Dummy-Verarbeitsungsschritt, der n Sekunden wartet, pro File und Event (create, modify, delete)

## Implementierungs-Konzept

### Prinzip

Watcher → Queue → Worker → Store. Alles im Server-Prozess, im Hintergrund. Frontend bekommt Live-Updates per WebSocket (gleiche Muster wie Dashboard/Logs).

```
storage/ (Docker-Volume)
   │  chokidar (add / change / unlink)
   ▼
FileWatcher ──► FileQueue (in-Memory, dedup pro Pfad)
                   │  Dispatcher: active < concurrency && !paused
                   ▼
            FileProcessor (Dummy: warte n Sekunden)
                   │
                   ▼
            FileStore (JSON-Datei: Struktur + Metadaten)
                   │
                   ▼
      FileService ──► FilesWebSocket (/files) ──► Frontend
```

### 1. Config (neue Gruppe `storage`)

`server/src/Config.js` — neue Parameter-Gruppe, wie `qdrant`/`mcp`:

| Key | Env | Typ | Default | Bedeutung |
|---|---|---|---|---|
| `enabled` | `STORAGE_ENABLED` | boolean | `true` | Watcher + Queue an/aus |
| `root` | `STORAGE_ROOT` | string | `./storage` | Root-Ordner (Docker-Volume) |
| `concurrency` | `STORAGE_CONCURRENCY` | integer | `1` | Gleichzeitige Jobs (1 = sequenziell) |
| `dummyDelaySec` | `STORAGE_DUMMY_DELAY_SEC` | number | `2` | Wartezeit des Dummy-Schritts pro File/Event |
| `retryDelaySec` | `STORAGE_RETRY_DELAY_SEC` | number | `5` | Wartezeit bis Retry nach Fehler |
| `maxRetries` | `STORAGE_MAX_RETRIES` | integer | `3` | Max. Retries pro Job (0 = aus) |
| `maxFileSizeMb` | `STORAGE_MAX_FILE_SIZE_MB` | number | `1024` | Files darüber werden übersprungen |
| `ignore` | `STORAGE_IGNORE` | array | `["**/.git/**", "**/node_modules/**"]` | Ignor-Patterns (Env: kommagetrennt) |

- `storage` in `runtimeKeys` (Änderung ohne Neustart; `root`-Wechsel startet Watcher neu).
- `validateSettings()`: root nicht leer, concurrency 1–16, dummyDelaySec ≥ 0, retryDelaySec ≥ 0, maxRetries 0–10, maxFileSizeMb > 0.
- `getSettings()` / `persist()` / `saveDefaults()` / `envLocked` entsprechend erweitern.

**Root-Level-Setting `dataDir`** (neben `serverPort`/`verbose`/`searchTopK`):

| Key | Env | Typ | Default | Bedeutung |
|---|---|---|---|---|
| `dataDir` | `DATA_DIR` | string | `<repo>/data` | Data-Ordner für `files.json` (eine Ebene über `server/`, gleiche Ebene wie `frontend/`/`server/`) |

- `dataDir` in `runtimeKeys` → Wechsel wirkt zur Laufzeit (Store wird neu ausgerichtet).
- `validateSettings()`: `dataDir` nicht leer.

### 2. FileStore — Struktur-Spiegel ("Datenbank")

`server/src/Services/FileStore.js`

- JSON-Datei `files.json` im Data-Ordner (Default: `<repo>/data`, eine Ebene über `server/`, **außerhalb** des storage-Roots — sonst Watcher-Loop).
- Data-Ordner per Settings änderbar (`dataDir`) → `setPath(newPath)` richtet Store neu aus + lädt.
- Atomares Schreiben: tmp-Datei + `rename()`.
- Kein natives Modul (kein better-sqlite3) → Docker-Build bleibt einfach. Später austauschbar.
- **Einträge werden nie gelöscht**: `delete`-Event setzt `status: "deleted"` + `deletedAt` (Tombstone).

Schema:

```json
{
  "version": 1,
  "files": {
    "docs/report.pdf": {
      "path": "docs/report.pdf",
      "size": 102400,
      "mtime": "2026-11-15T22:00:00.000Z",
      "ctime": "2026-11-15T21:59:00.000Z",
      "status": "done",
      "lastEvent": "modify",
      "processedAt": "2026-11-15T22:00:05.000Z",
      "updatedAt": "2026-11-15T22:00:05.000Z"
    }
  }
}
```

- `status`: `done` | `error` | `deleted`
- `delete`-Event → `upsert(path, { status: 'deleted', deletedAt })`, kein `remove()`

API: `upsert(relPath, meta)`, `list()`, `get(relPath)`, `load()`, `save()`, `setPath(newPath)`.

### 3. FileWatcher

`server/src/Services/FileWatcher.js`

- `chokidar.watch(root, { ignoreInitial: false, followSymlinks: false, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }, ignored: config.storage.ignore })`
- Event-Mapping:
  - `add` → `create`
  - `change` → `modify`
  - `unlink` → `delete`
  - `addDir` / `unlinkDir` → ignorieren (Ordner sind implizit über ihre Files)
- Initial-Scan (`ignoreInitial: false`): alle vorhandenen Files als `create` in die Queue → Selbstheilung nach Neustart.
- Pfade relativ zum Root normalisieren (POSIX-Slashes).
- **Path-Guard**: `..` und absolute Pfade verwerfen + loggen.
- **Root fehlt**: beim Start anlegen (`mkdirSync recursive`), sonst klare Fehlermeldung.
- `stop()` → `watcher.close()`.

### 4. FileQueue

`server/src/Services/FileQueue.js`

- In-Memory, Job-Objekt:

```js
{
  id: crypto.randomUUID(),
  path: 'docs/report.pdf',
  event: 'create' | 'modify' | 'delete',
  status: 'pending' | 'processing' | 'done' | 'error' | 'cancelled',
  enqueuedAt, startedAt, finishedAt,
  retries: 0, retryAt: null,
  error: null
}
```

- **Dedup**: max. 1 Job pro Pfad. Neues Event ersetzt den pending-Job desselben Pfads (latest-wins). `delete` ersetzt immer.
- **Dispatcher** (einziger Picker):

```
while (!paused && active < concurrency && queue.length) → nächster Job an Worker
```

  - `concurrency` wird pro Tick aus Config gelesen → Änderung in Settings wirkt sofort.
  - `pause()`: Dispatcher stoppt, aktive Jobs laufen zu Ende (graceful).
  - `resume()`: Dispatcher läuft weiter.
  - `abort()`: alle pending → `cancelled`, Dispatcher stoppt, aktive Jobs bekommen `AbortSignal` (brechen sofort ab).
  - `remove(id)`: nur `pending`-Jobs löschbar.
- **Retry**: Job `error` → falls `retries < maxRetries`: `retries++`, `retryAt = now + retryDelaySec`, zurück in `pending`. Dispatcher überspringt Jobs mit `retryAt` in der Zukunft. Danach: endgültig `error`.
- **Queue-Cap**: max. 10.000 Jobs. Overflow → älteste `pending`-Jobs verwerfen + loggen (Initial-Scan großer Bäume).
- **Persistenz**: bewusst in-Memory. Nach Neustart macht der Initial-Scan die Queue wieder voll (Selbstheilung).
- Emittet Changes → FileService broadcastet.

### 5. FileProcessor (Dummy)

`server/src/Services/FileProcessor.js`

- Strategie-Interface: `async process(job) → result`.
- `DummyProcessor`: wartet `dummyDelaySec` (aus Config, pro Job gelesen), dann fertig.
- Danach:
  - `create` / `modify` → `FileStore.upsert(path, meta)` (size, mtime, ctime via `statSync`)
  - `delete` → `FileStore.upsert(path, { status: 'deleted', deletedAt })` (Tombstone)
- **Race**: File während Processing gelöscht → `statSync` ENOENT → wie `delete` behandeln.
- **Size-Limit**: File > `maxFileSizeMb` → `skipped` (kein Fehler), loggen.
- **Abort**: Dummy-Wartezeit hört auf `AbortSignal`.
- Später: hier echte Verarbeitung einhängen (Chunking → Embeddings → Qdrant), Interface bleibt gleich.

### 6. FileService (Orchestrator)

`server/src/Services/FileService.js`

- Verdrahtet: Config + FileStore + FileWatcher + FileQueue + FileProcessor.
- Gleiche Muster wie `DashboardService`: `start()`, `stop()`, `getSnapshot()`, `refresh()`, `addListener(fn)`.
- Snapshot:

```js
{
  ts,
  root, enabled, concurrency, dummyDelaySec,
  paused: false,
  stats: { pending, processing, done, error, cancelled, files },
  queue: [ ...jobs (neueste zuerst, cap 200) ],
  files: [ ...FileStore.list() ]
}
```

- Broadcast-Debounce ~100 ms (chokidar feuert bei Copy/Extract viele Events).
- Processing-Events (start/done/error/retry) in bestehendes Log-System → sichtbar im Logs-Dashboard.
- `pause()`, `resume()`, `abort()`, `removeJob(id)` → delegiert an Queue, danach `refresh()`.
- Config-Change auf `storage.root` → Watcher neu starten.

### 7. WebSocket + REST

`server/src/FilesWebSocket.js` — Kopie des `DashboardWebSocket`-Musters, Endpunkt `/files`:

- `{ type: 'snapshot', data }` auf Connect
- `{ type: 'update', data }` bei Änderungen

`server/src/Router/FilesRouter.js`:

| Methode | Pfad | Wirkung |
|---|---|---|
| GET | `/api/files` | Snapshot (Files + Queue + Stats) |
| POST | `/api/files/queue/pause` | Pause |
| POST | `/api/files/queue/resume` | Weiter |
| POST | `/api/files/queue/abort` | Abbrechen (pending → cancelled) |
| DELETE | `/api/files/queue/:jobId` | Pending-Job entfernen |

Wiring:

- `Router.define()`: FileService + FilesWebSocket erzeugen, `setupUpgradeRouting()` um `/files` erweitern.
- `Server.js` Shutdown: `fileService.stop()` + `filesWs.close()` (wie dashboardService/dashboardWs).

### 8. Frontend

- Route `/files` in `App.jsx` + Eintrag in `TopNav`.
- `frontend/src/hooks/useFilesStream.js` — Muster von `useDashboardStream` (Reconnect, snapshot/update).
- `frontend/src/pages/FilesPage.jsx`:
  - Stats-Karten: pending / processing / done / error (wie Dashboard-Cards)
  - Queue-Table: Pfad, Event (create/modify/delete), Status, Zeit, Aktionen (Remove bei pending)
  - Controls: Pause / Resume, Abbrechen
  - Files-Table (Struktur-Spiegel): Pfad, Größe, mtime, Status, letztes Event
  - Große Listen: Pagination oder Virtualisierung (beide Tables)
- i18n: Keys in `de.json`, `en.json`, `it.json`.

**FilesPage-Keys** (de/en/it):

```
files.title
files.stats.pending / processing / done / error / cancelled
files.queue.title / path / event / status / enqueuedAt / actions
files.queue.pause / resume / abort / remove
files.files.title / path / size / mtime / status / lastEvent
files.event.create / modify / delete
files.status.pending / processing / done / error / cancelled / deleted / skipped
files.empty.queue / files.empty.files
```
- Settings: neue Kategorie `storage` (Detail: Abschnitt 8b).

### 8b. Settings-UI: Kategorie `storage`

Neue Tab-Kategorie in `SettingsPage` (zwischen `mcp` und `ui`), exakt nach `McpSettings`-Muster.

**`frontend/src/components/settings/StorageSettings.jsx`**

```jsx
const FIELDS = [
  { key: 'enabled', type: 'checkbox', label: 'settings.storage.enabled', hint: 'settings.storage.enabledHint' },
  { key: 'root', type: 'text', label: 'settings.storage.root', hint: 'settings.storage.rootHint', placeholder: 'settings.storage.rootPlaceholder' },
  { key: 'concurrency', type: 'number', label: 'settings.storage.concurrency', hint: 'settings.storage.concurrencyHint', min: 1, max: 16, step: 1 },
  { key: 'dummyDelaySec', type: 'number', label: 'settings.storage.dummyDelaySec', hint: 'settings.storage.dummyDelaySecHint', min: 0, step: 0.5 },
  { key: 'retryDelaySec', type: 'number', label: 'settings.storage.retryDelaySec', hint: 'settings.storage.retryDelaySecHint', min: 0, step: 1 },
  { key: 'maxRetries', type: 'number', label: 'settings.storage.maxRetries', hint: 'settings.storage.maxRetriesHint', min: 0, max: 10, step: 1 },
  { key: 'maxFileSizeMb', type: 'number', label: 'settings.storage.maxFileSizeMb', hint: 'settings.storage.maxFileSizeMbHint', min: 1, step: 1 },
  { key: 'ignore', type: 'list', label: 'settings.storage.ignore', hint: 'settings.storage.ignoreHint', placeholder: 'settings.storage.ignorePlaceholder' },
];
```

- `useSettingsGroup('storage', FIELD_KEYS, settings, save)` → Draft, `isLocked()`, `handleSave`, `handleReset` (Hook ist generisch, liest `settings.storage`, sendet Patch `{ storage: {...} }`).
- `SaveFooter` wie bei allen anderen Kategorien (Speichern/Zurücksetzen, Fehleranzeige).
- Env-gelockte Felder: `EnvLockBadge` automatisch (Config liefert `envLocked.storage`).
- Panel-Header: `settings.storage.title`.

**Feld-Verhalten nach Speichern**

| Feld | Wirkung |
|---|---|
| `enabled` | `false` → Watcher + Queue stoppen; `true` → starten (Initial-Scan) |
| `root` | Watcher neu starten, Initial-Scan auf neuem Root |
| `concurrency` | Dispatcher liest pro Tick → wirkt sofort |
| `dummyDelaySec` | Pro Job gelesen → wirkt ab nächstem Job |
| `retryDelaySec` | Pro Retry gelesen → wirkt ab nächstem Fehler |
| `maxRetries` | Pro Job gelesen → wirkt ab nächstem Job |
| `maxFileSizeMb` | Pro Job gelesen → wirkt ab nächstem Job |
| `ignore` | Watcher-Option, wirkt ab neuem Watcher-Start |

**i18n-Keys** (de/en/it)

```
settings.categories.storage
settings.storage.title
settings.storage.enabled / enabledHint
settings.storage.root / rootHint / rootPlaceholder
settings.storage.concurrency / concurrencyHint
settings.storage.dummyDelaySec / dummyDelaySecHint
settings.storage.retryDelaySec / retryDelaySecHint
settings.storage.maxRetries / maxRetriesHint
settings.storage.maxFileSizeMb / maxFileSizeMbHint
settings.storage.ignore / ignoreHint / ignorePlaceholder
```

Beispiel (de):

| Key | Text |
|---|---|
| `categories.storage` | "Dateien" |
| `storage.title` | "Datei-Verwaltung" |
| `storage.enabled` | "Aktiviert" |
| `storage.enabledHint` | "Überwacht den Storage-Ordner und verarbeitet Änderungen." |
| `storage.root` | "Root-Ordner" |
| `storage.rootHint` | "Pfad des Storage-Volumes (im Container). Wechsel startet den Watcher neu." |
| `storage.rootPlaceholder` | "z. B. /app/storage" |
| `storage.concurrency` | "Gleichzeitigkeit" |
| `storage.concurrencyHint` | "Anzahl parallel verarbeiteter Jobs (1 = sequenziell)." |
| `storage.dummyDelaySec` | "Dummy-Delay (Sekunden)" |
| `storage.dummyDelaySecHint` | "Wartezeit des Dummy-Schritts pro File und Event." |
| `storage.retryDelaySec` | "Retry-Wartezeit (Sekunden)" |
| `storage.retryDelaySecHint` | "Wartezeit bis ein fehlgeschlagener Job erneut gestartet wird." |
| `storage.maxRetries` | "Max. Retries" |
| `storage.maxRetriesHint` | "Wie oft ein Job nach Fehler erneut gestartet wird (0 = kein Retry)." |
| `storage.maxFileSizeMb` | "Max. Dateigröße (MB)" |
| `storage.maxFileSizeMbHint` | "Größere Dateien werden übersprungen." |
| `storage.ignore` | "Ignorieren" |
| `storage.ignoreHint` | "Komma-getrennte Glob-Patterns." |
| `storage.ignorePlaceholder` | "z. B. **/.git/**, **/node_modules/**" |

**Geänderte Dateien (Settings)**

- `SettingsPage.jsx`: Eintrag `{ id: 'storage', title: 'settings.categories.storage', component: StorageSettings }` in `CATEGORIES`
- `locales/de.json`, `en.json`, `it.json`: Keys oben
- `Config.js`: `envLocked.storage` + `getSettings()` (bereits in Abschnitt 1)
- `ServerSettings.jsx`: Feld `dataDir` (Root-Gruppe, Text-Feld) + i18n-Keys `settings.server.dataDir*`

### 9. Docker / Env

`compose.yml`:

```yaml
    environment:
      - STORAGE_ROOT=/app/storage
      - STORAGE_CONCURRENCY=${STORAGE_CONCURRENCY:-1}
      - STORAGE_DUMMY_DELAY_SEC=${STORAGE_DUMMY_DELAY_SEC:-2}
      - STORAGE_RETRY_DELAY_SEC=${STORAGE_RETRY_DELAY_SEC:-5}
      - STORAGE_MAX_RETRIES=${STORAGE_MAX_RETRIES:-3}
    volumes:
      - ./storage:/app/storage
      - ./data:/app/data
```

- `.env.example`: `STORAGE_ROOT`, `STORAGE_CONCURRENCY`, `STORAGE_DUMMY_DELAY_SEC`, `STORAGE_RETRY_DELAY_SEC`, `STORAGE_MAX_RETRIES`, `DATA_DIR`.
- `storage/` im Repo: `.gitkeep` (oder `.gitignore` mit `storage/*` + `!.gitkeep`).
- `data/files.json` in `.gitignore`.

### 10. Edge-Cases & Entscheidungen

| Thema | Entscheidung |
|---|---|
| DB-Datei im Watch-Ordner? | Nein. `data/` liegt außerhalb des storage-Roots → kein Watcher-Loop |
| Halb geschriebene Files | `awaitWriteFinish` (300 ms Stabilität) |
| Neustart | Queue in-Memory, Initial-Scan heilt sie wieder |
| Gleicher Pfad, mehrere Events | Latest-wins (1 Job pro Pfad) |
| Pause vs. Abbruch | Pause = graceful (aktive laufen zu Ende), Abbruch = pending → cancelled + aktive Jobs via AbortSignal abbrechen |
| Concurrency ändern | Dispatcher liest Config pro Tick → wirkt sofort, kein Neustart |
| Broadcast-Flood | 100 ms Debounce |
| Ordner-Events | Ignorieren; Struktur ergibt sich aus den Files |
| Native DB-Module | Nein (JSON-Store), Docker-Build bleibt einfach |
| Symlinks | `followSymlinks: false` → kein Loop |
| Path-Traversal | relPath normalisieren, `..`/absolute Pfade verwerfen |
| Root fehlt | Beim Start anlegen (`mkdirSync recursive`) |
| File während Processing gelöscht | ENOENT → wie `delete` behandeln |
| Queue-Overflow | Cap 10k Jobs, älteste pending verwerfen + loggen |
| Fehler-Retry | Nach `retryDelaySec`, max. `maxRetries`, dann endgültig `error` |
| Delete-Event | Tombstone (`status: deleted`), Store-Einträge nie löschen |
| Root-Wechsel | Alte Store-Einträge behalten (Tombstone-Prinzip) |
| File zu groß | > `maxFileSizeMb` → `skipped` |
| dataDir-Wechsel | `Store.setPath()` → neue Store-Datei, wirkt sofort (runtime) |

### 11. Tests (vitest, `server/test/`)

- `fileQueue.test.js`: Dedup/latest-wins, pause/resume, abort, remove, Retry (Fake-Timer), Concurrency (2 Worker parallel)
- `fileStore.test.js`: upsert/list, Tombstone (delete → status deleted), atomares Save (tmp+rename)
- `config.test.js`: storage-Gruppe (Defaults, Env-Override, STORAGE_IGNORE kommagetrennt, Validierung)
- `fileProcessor.test.js`: Dummy-Delay (vi.mock Timer), Store-Update je Event-Typ, ENOENT-Race, Size-Limit
- `fileWatcher.test.js`: Event-Mapping add/change/unlink mit Temp-Ordner, Path-Guard

### 12. Neue Dateien

```
server/src/Services/FileStore.js
server/src/Services/FileWatcher.js
server/src/Services/FileQueue.js
server/src/Services/FileProcessor.js
server/src/Services/FileService.js
server/src/FilesWebSocket.js
server/src/Router/FilesRouter.js
server/test/fileQueue.test.js
server/test/fileStore.test.js
frontend/src/hooks/useFilesStream.js
frontend/src/pages/FilesPage.jsx
frontend/src/components/files/QueueTable.jsx
frontend/src/components/files/QueueControls.jsx
frontend/src/components/files/FilesTable.jsx
frontend/src/components/settings/StorageSettings.jsx
```

Geänderte Dateien: `Config.js`, `Router/index.js`, `Server.js`, `App.jsx`, `TopNav.jsx`, `SettingsPage.jsx`, `locales/*.json`, `compose.yml`, `.env.example`, `README.md`, `server/package.json` (+chokidar).

### 13. Umsetzungsschritte

1. Config: `storage`-Gruppe + Validierung + Tests
2. FileStore + Tests
3. FileQueue + Tests
4. FileProcessor (Dummy) + Tests
5. FileWatcher
6. FileService (Orchestrator)
7. FilesWebSocket + FilesRouter + Wiring (Router, Server-Shutdown)
8. Frontend: Hook + Page + Components + i18n + Settings
9. Docker: compose Volume + Env, .env.example, README-Update
10. E2E-Check: File anlegen/ändern/löschen → Queue + Frontend live
