# Plan File Database (MariaDB)

Ziel: Den JSON-Store (`data/files.json`, `FileStore.js`) **vollständig ersetzen** durch eine echte relationale Datenbank — konkret **MariaDB** als separater Compose-Service.

Status: **Konzept, noch nicht umgesetzt.**

**Entscheidung (final):** MariaDB ist der **einzige** Store-Backend und **Pflicht**. Es gibt **keinen** JSON-Fallback und **keinen** Driver-Switch. Der JSON-Store (`FileStore.js`) wird entfernt.

---

## 1. Einordnung: Warum MariaDB (Pflicht)?

### Warum der JSON-Store nicht mehr reicht

| Trigger | Warum JSON dann scheitert |
|---|---|
| **Mehrere Server-Instanzen** (Skalierung, HA) | JSON-Datei ist nicht sicher teilbar; zwei Writer → Race/Verlust |
| **Große Eintragszahlen** (> 50k Files) | Jeder `upsert` schreibt die **gesamte** Datei neu (O(n) pro Write); `load()` liest alles (O(n) pro Start) |
| **Relationale Verknüpfungen** | Echte Verarbeitung (Chunking → Embeddings → Qdrant) braucht `files` als Eltern-Tabelle für `chunks` (FK `file_id`), Re-Indexing pro File (`DELETE FROM chunks WHERE file_id = ?`), Status-Abfragen (`WHERE status = 'error'`) |
| **ACID / Durability** | Transaktionen, Crash-Sicherheit über reine Datei-Renames hinaus |
| **Abfragen & Reporting** | `ORDER BY mtime`, `GROUP BY status`, Pagination — in JSON nur via Full-Scan im JS |

### Entscheidung

MariaDB ist der **einzige** Backend. Der stärkste Grund ist die **zukünftige echte Verarbeitung**: `files` wird die Eltern-Tabelle für Chunks/Embeddings-Metadaten → relationale DB ist der natürliche, dauerhafte Zustand.

Konsequenzen:
- **Kein Driver-Switch** (`storage.driver` / `STORAGE_DRIVER` entfällt komplett).
- **JSON-Store wird entfernt** (`FileStore.js` + `fileStore.test.js` gelöscht, `data/files.json` nicht mehr erzeugt).
- **DB ist Pflicht**: Ohne erreichbare MariaDB startet der File-Service nicht (Reconnect-Loop, siehe 11.).
- **Rollback** = Git-Revert (kein Env-Flag).

---

## 2. Architektur-Entscheidung

### 2.1 MariaDB als einziger Store

```
FileService / FileProcessor
        │  (Store-Interface)
        ▼
MariaDbFileStore                     ← einziger Store (mysql2-Pool)
```

- `FileService` und `FileProcessor` nutzen das **Store-Interface**; die Implementierung ist `MariaDbFileStore`.
- **Keine Factory, kein Driver-Switch** — `FileService` erzeugt direkt `MariaDbFileStore`.
- `FileStore.js` (JSON) + `fileStore.test.js` werden **entfernt**.
- Rollback = Git-Revert (kein Env-Flag).

### 2.2 Store-Interface

```js
{
    upsert(relPath, meta)  → Promise<entry>
    list()                → Promise<entry[]>
    get(relPath)          → Promise<entry | null>
    close()               → Promise<void>      // Pool schließen
}
```

**Konsequenz: Das Interface ist async** (DB-Roundtrip). `FileService`/`FileProcessor`/WS/Router werden entsprechend async (siehe 2.3).

### 2.3 Async-Ripple (vollständig aufgezählt)

| Datei | Änderung |
|---|---|
| `FileProcessor.js` | `await this.store.upsert(...)` (3 Stellen), `markDeleted()` → async |
| `FileService.js` | `buildSnapshot()` → async (`await this.store.list()`); `refresh()` → async; `scheduleBroadcast()` → async-Callback; `getSnapshot()` → async; `start()/pause()/resume()/abort()/removeJob()/onConfigChange()` → `await this.refresh()`; `stop()` → `await this.store.close()`; Store = `MariaDbFileStore` (statt `FileStore`) |
| `FilesWebSocket.js` | `onConnection()` → async, `await this.fileService.getSnapshot()` |
| `FilesRouter.js` | 5 Handler → `async` (Express 5 leitet abgelehnte Promises automatisch an den Error-Handler weiter) |
| `Server.js` | Shutdown: `fileService.stop()` bleibt (schließt intern den Pool) |
| Tests | `fileStore.test.js` **entfernt**; `fileProcessor.test.js` → `await` + Fake-Store |

**Alternative (abgelehnt):** In-Memory-Cache im `MariaDbFileStore` (sync-Reads aus dem Cache, async-Writes in die DB). Vermeidet den Ripple, erzeugt aber Dual-State (Cache ≠ DB bei Write-Fehlern) und mehr Code. Für dieses Projekt ist der saubere async-Pfad der bessere Trade-off.

### 2.4 Datenfluss

```
storage/ (Volume)
   │ chokidar
   ▼
FileWatcher ──► FileQueue ──► FileProcessor ──► MariaDbFileStore (MariaDB)
                                             │
                                             ▼
                               FileService ──► WS /files ──► Frontend
```

Frontend, WebSocket-Protokoll, REST-API, Queue, Watcher: **keine Änderungen** (Snapshot-Shape bleibt identisch).

---

## 3. Datenbank-Schema

### 3.1 DDL (`001_init.sql`)

```sql
CREATE TABLE IF NOT EXISTS files (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    path         VARCHAR(768)    NOT NULL,
    size         BIGINT UNSIGNED NULL,
    mtime        DATETIME(3)     NULL,
    ctime        DATETIME(3)     NULL,
    status       VARCHAR(16)     NOT NULL DEFAULT 'done',
    last_event   VARCHAR(16)     NULL,
    processed_at DATETIME(3)     NULL,
    deleted_at   DATETIME(3)     NULL,
    meta         JSON            NULL,
    created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_files_path (path),
    KEY idx_files_status (status),
    KEY idx_files_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 3.2 Design-Entscheidungen

| Thema | Entscheidung | Begründung |
|---|---|---|
| `path` Länge | `VARCHAR(768)` | InnoDB-Index-Limit 3072 Bytes (DYNAMIC Row Format, Default seit 5.7.9); utf8mb4 = 4 Bytes/Char → 768 Zeichen max. für einen Unique-Index. Längere Pfade: Alternative `path_hash CHAR(64)` (SHA-256) als Unique-Key + `path` ohne Index (siehe 15.) |
| `status` | `VARCHAR(16)` statt `ENUM` | Erweiterbar (`skipped`, `error`, `done`, `deleted` …) ohne Migration. Optional: `CONSTRAINT chk_status CHECK (status IN ('done','error','deleted','skipped'))` (MariaDB 10.2+) |
| `last_event` | `VARCHAR(16)` | Gleiche Begründung (`create`, `modify`, `delete`) |
| `meta` | `JSON NULL` | Fangnetz für beliebige Zusatzfelder (heute: `upsert()` akzeptiert arbitrary meta). Bekannte Felder bleiben eigene Spalten (indexierbar, typisiert) |
| Zeitstempel | `DATETIME(3)` | Millisekunden-Precision, deckt die ISO-Strings des JSON-Schemas ab. **Immer UTC** speichern (Pool-Config `timezone: 'Z'`) |
| `created_at` | neu | JSON-Store hat nur `updatedAt`; DB kann zusätzlich die Erst-Erfassung tracken (nützlich für Reporting) |
| Tombstones | `status='deleted'` + `deleted_at` | Semantik 1:1 aus dem JSON-Store: **Zeilen werden nie gelöscht** |
| Engine | InnoDB | Transaktionen + FK-Fähigkeit (für spätere `chunks`-Tabelle) |
| Charset | utf8mb4 | Volle Unicode-Abdeckung (Dateinamen!) |

### 3.3 Spätere Erweiterung (nicht jetzt)

```sql
-- Wenn echte Verarbeitung kommt:
CREATE TABLE chunks (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    file_id    BIGINT UNSIGNED NOT NULL,
    seq        INT UNSIGNED    NOT NULL,
    text       MEDIUMTEXT      NOT NULL,
    embedding_id VARCHAR(64)   NULL,   -- Referenz in Qdrant
    created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_chunks_file (file_id),
    CONSTRAINT fk_chunks_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
);
```

Das ist der strategische Hauptgrund für MariaDB: `files.id` wird FK-Anker.

---

## 4. DB-Driver & Connection-Pool

### 4.1 DB-Driver: `mysql2`

- **Pure JS, kein natives Build** → Docker-Build bleibt einfach (konsistent mit der bestehenden Entscheidung "kein better-sqlite3").
- `mysql2/promise` → native Promise-API, Connection-Pool eingebaut.
- Alternative: offizielles `mariadb`-Paket (ebenfalls pure JS). `mysql2` wird empfohlen (größte Verbreitung, beste Doku).

### 4.2 Pool-Config

```js
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
    host, port, user, password, database,
    waitForConnections: true,
    connectionLimit: poolSize,        // Default 5
    queueLimit: 0,                     // unbegrenzt (Queue dämpft ohnehin)
    connectTimeout: connectTimeoutMs,  // Default 5000
    timezone: 'Z',                     // UTC durchgängig
    namedPlaceholders: false,
    charset: 'utf8mb4'
});
```

- Pool wird im `MariaDbFileStore`-Konstruktor erzeugt, in `close()` via `pool.end()` geschlossen.
- `FileService.stop()` → `await store.close()` → sauberer Shutdown (Server.js-Shutdown-Hook bleibt unverändert).

---

## 5. Config (neue Gruppe `db`)

### 5.1 `DB_PARAMS` (neue Gruppe in `Config.js`)

| Key | Env | Typ | Default | Bedeutung |
|---|---|---|---|---|
| `host` | `DB_HOST` | string | `127.0.0.1` | DB-Host (Compose: `mariadb`) |
| `port` | `DB_PORT` | integer | `3306` | DB-Port |
| `user` | `DB_USER` | string | `rag` | App-User (kein root) |
| `password` | `DB_PASSWORD` | string | `''` | Passwort (nur Env, nie in config.json persistieren — siehe 5.2) |
| `database` | `DB_NAME` | string | `ragqdrant` | Datenbank-Name |
| `poolSize` | `DB_POOL_SIZE` | integer | `5` | Connection-Limit |
| `connectTimeoutMs` | `DB_CONNECT_TIMEOUT_MS` | integer | `5000` | Connect-Timeout |
| `retryDelaySec` | `DB_RETRY_DELAY_SEC` | number | `10` | Wartezeit zwischen Reconnect-Versuchen |
| `maxRetries` | `DB_MAX_RETRIES` | integer | `0` | Max. Reconnect-Versuche (0 = unbegrenzt, wie Qdrant-Pattern) |

- `validateSettings()`: `db.host` nicht leer; `db.port` 1–65535; `db.poolSize` 1–50; `db.connectTimeoutMs` > 0.
- `db` in `runtimeKeys` **nicht** aufnehmen (Pool-Wechsel zur Laufzeit = Neustart; bewusst in `restartKeys`-Semantik).
- `envLocked.db` wie bei den anderen Gruppen.
- `getSettings()` / `saveDefaults()` entsprechend erweitern.
- **Kein `storage.driver`**: Der Driver-Switch entfällt komplett (MariaDB ist Pflicht). `STORAGE_PARAMS` bleibt unverändert.
- **UI:** Die `db`-Verbindung wird im neuen **Database-Tab** angezeigt (Abschnitt 10).

### 5.2 Passwort-Hygiene

- `DB_PASSWORD` **nie** in `config.json` schreiben (Secret). `saveDefaults()` schreibt für `db.password` einen leeren Platzhalter; der echte Wert kommt ausschließlich aus der Env.
- UI: Feld `password` als `password`-Typ, bei `getSettings()` maskiert (`'••••••'`), leer gelassen = unverändert.

---

## 6. `MariaDbFileStore` (Implementierung)

`server/src/Services/MariaDbFileStore.js`

### 6.1 API

```js
class MariaDbFileStore {
    constructor({ db, logger })          // db = config.db
    async connect()                      // SELECT 1 + Migrations ausführen
    async upsert(relPath, meta)          // Merge-Semantik (unberührte Felder bleiben)
    async list()                         // alle Zeilen (inkl. Tombstones), ORDER BY path
    async get(relPath)                   // eine Zeile oder null
    async close()                        // pool.end()
}
```

### 6.2 `upsert()` — Merge-Semantik

Semantik: **Merge** (unberührte Felder bleiben, latest-wins). In SQL: Read-Modify-Write in einer Transaktion:

```sql
START TRANSACTION;
SELECT * FROM files WHERE path = ? FOR UPDATE;
-- Merge in JS: { ...existing, ...meta, path, updatedAt: now }
INSERT INTO files (path, size, mtime, ctime, status, last_event, processed_at, deleted_at, meta)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
AS new
ON DUPLICATE KEY UPDATE
    size = new.size, mtime = new.mtime, ctime = new.ctime,
    status = new.status, last_event = new.last_event,
    processed_at = new.processed_at, deleted_at = new.deleted_at,
    meta = new.meta;
COMMIT;
```

- `AS new … ON DUPLICATE KEY UPDATE` = MariaDB-10.3.3+-Syntax (keine deprecated `VALUES()`).
- `FOR UPDATE` verhindert Race bei parallelen Upserts auf denselben Pfad (Concurrency > 1).
- Row → Entry-Mapping: `DATETIME` → ISO-String (UTC), `meta`-JSON wird in den Entry gespreizt, `id`/`created_at` werden nicht in den Entry übernommen (Snapshot-Shape bleibt stabil).

### 6.3 `list()` / `get()`

```sql
SELECT * FROM files ORDER BY path;
SELECT * FROM files WHERE path = ?;
```

- `list()` liefert **alle** Zeilen (API-Kompatibilität). Pagination ist eine spätere Optimierung (siehe 15.).
- Fehler (DB down) → `logger.error` + `throw` → `FileProcessor`-Retry-Mechanismus greift (bestehend: `retryDelaySec`, `maxRetries`).

### 6.4 `connect()` — Start-Readiness

```
connect():
  1. pool.query('SELECT 1')            → DB erreichbar?
  2. migrate(pool)                     → Schema sicherstellen (idempotent)
  3. OK → resolved
```

- Bei Fehlschlag: **kein Crash**. `FileService.start()` loggt den Fehler, startet einen Reconnect-Loop (Backoff `db.retryDelaySec`, max. `db.maxRetries`), Snapshot meldet `store: { connected: false }`.
- Bei erfolgreichem Reconnect: `refresh()` (Frontend holt den aktuellen Stand).
- Pattern orientiert sich am bestehenden Qdrant-Reconnect (`retryDelaySec`/`maxRetries`).

### 6.5 Wiring in `FileService`

- `FileService`-Konstruktor: `this.store = store || new MariaDbFileStore({ db: config.db, logger: this.logger })` (injizierbar für Tests).
- **Keine Factory, kein Driver-Switch** — `MariaDbFileStore` ist der einzige Store.
- `dataDir`-Config-Change: `FileService.onConfigChange()` prüft bereits `typeof this.store.setPath === 'function'` → `MariaDbFileStore` hat keine `setPath` → Code-Pfad wird automatisch übersprungen. **Keine Änderung nötig.**

---

## 7. Migrations

Kein externes Tool (kein knex/sequelize) — konsistent mit dem schlanken Projekt-Stil.

### 7.1 Struktur

```
server/src/db/
├── migrate.js              # Runner
├── import.js               # Einmal-Import JSON → DB (CLI)
└── migrations/
    └── 001_init.sql        # DDL aus Abschnitt 3.1
```

### 7.2 `migrate.js`

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    VARCHAR(64) NOT NULL PRIMARY KEY,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
```

- Liest `migrations/*.sql` (lexikografisch sortiert = Versionsreihenfolge).
- Pro Datei: `SELECT 1 FROM schema_migrations WHERE version = ?` → fehlt: in einer Transaktion anwenden + Version eintragen.
- Idempotent, sicher bei jedem Server-Start (läuft in `connect()`).
- Spätere Schema-Änderungen = neue Datei `002_….sql`. Keine bestehenden Migrations anfassen.

### 7.3 Warum nicht `/docker-entrypoint-initdb.d/`?

- Init-Scripts laufen **nur** beim ersten Start eines leeren Volumes → bei bestehenden Volumes tobt.
- Der Runner im App-Code ist versioniert, idempotent und funktioniert in Dev (ohne Docker) genauso.
- (Beides geht; der Runner ist die robustere Wahl.)

---

## 8. Daten-Migration (JSON → MariaDB)

Einmaliges CLI-Skript `server/src/db/import.js`:

```
node src/db/import.js --from <pfad-zu-files.json>
```

- Liest `files.json` (defensiv, wie `FileStore.load()`).
- Batch-Upsert: 500 Zeilen pro Transaktion (ODKU aus 6.2).
- **Idempotent** (wiederholbar, latest-wins).
- Loggt: `importiert: N, übersprungen: 0, fehler: 0`.
- Danach: Server neu starten (MariaDB ist jetzt der einzige Store).
- `files.json` bleibt als Backup erhalten (nichts wird gelöscht).

---

## 9. Docker / Compose

### 9.1 Prinzip: DB-Service in `compose-db.yml` (Pflicht)

Die MariaDB-Definition gehört **nicht** in `compose.yml` oder `compose-dev.yml`, sondern in ein eigenes File `compose-db.yml`. Da die DB **Pflicht** ist (kein JSON-Fallback), wird sie **immer** per Multi-File-Compose mitgestartet:

| Aufruf | Ergebnis |
|---|---|
| `docker compose -f compose.yml -f compose-db.yml up` | Produktion + **MariaDB** (einziger gültiger Modus) |
| `docker compose -f compose-dev.yml -f compose-db.yml up` | Dev + **MariaDB** (einziger gültiger Modus) |

- `docker compose -f compose.yml up` **ohne** `compose-db.yml` ist **kein** gültiger Betriebsmodus mehr (App erwartet MariaDB; File-Service bleibt im Reconnect-Loop).
- Compose merge-t Services by name: `compose-db.yml` liefert den `mariadb`-Service + `dbdata`-Volume und ergänzt `depends_on`/`environment` an `rag-qdrant-mcp` (Environment-Listen werden concateniert, keine Key-Kollisionen).
- `compose.yml` und `compose-dev.yml` bleiben inhaltlich **unverändert** (kein `STORAGE_DRIVER` mehr, da kein Driver-Switch).
- Trennung in `compose-db.yml` bleibt sinnvoll: DB-Config (Image, Volume, Credentials) liegt zentral an einem Ort, getrennt von der App.

### 9.2 `compose-db.yml` (neu, einziger DB-Ort)

```yaml
services:
  mariadb:
    image: mariadb:11
    container_name: rag-qdrant-mcp-db
    restart: unless-stopped
    environment:
      - MARIADB_ROOT_PASSWORD=${DB_ROOT_PASSWORD:?DB_ROOT_PASSWORD fehlt}
      - MARIADB_DATABASE=${DB_NAME:-ragqdrant}
      - MARIADB_USER=${DB_USER:-rag}
      - MARIADB_PASSWORD=${DB_PASSWORD:?DB_PASSWORD fehlt}
    volumes:
      - dbdata:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 5s
      timeout: 5s
      retries: 30
      start_period: 10s
    # bewusst KEINE ports: nur internes Compose-Netz

  # Merge in den App-Service (wird by-name mit compose.yml / compose-dev.yml vereinigt):
  rag-qdrant-mcp:
    depends_on:
      mariadb:
        condition: service_healthy
    environment:
      - DB_HOST=mariadb
      - DB_PORT=3306
      - DB_USER=${DB_USER:-rag}
      - DB_PASSWORD=${DB_PASSWORD}
      - DB_NAME=${DB_NAME:-ragqdrant}
      - DB_POOL_SIZE=${DB_POOL_SIZE:-5}

volumes:
  dbdata:
```

- **Kein `STORAGE_DRIVER`** mehr (kein Driver-Switch; MariaDB ist der einzige Store).
- **Caveat `container_name`:** Prod + Dev gleichzeitig laufen lassen → Name-Kollision (`rag-qdrant-mcp-db`). Entweder nacheinander starten oder in `compose-dev.yml`-Kontext einen anderen Namen setzen (z. B. via Env `DB_CONTAINER_NAME`). Für den Normalfall (eine Umgebung zur Zeit) ist das kein Problem.
- **Caveat Volume:** Prod und Dev teilen sich `dbdata`, wenn beide mit `-f compose-db.yml` laufen. Für getrennte Daten: Dev-Overlay mit eigenem Volume-Name (z. B. `dbdata-dev`) — optional, nur bei parallelem Betrieb nötig.
- Dev-Vorteil: Migrations laufen automatisch beim App-Start (kein manuelles SQL).

### 9.3 `.env.example` (erweitern)

```
##
# database (mariadb) — Pflicht
##
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=rag
DB_PASSWORD=
DB_NAME=ragqdrant
DB_POOL_SIZE=5
DB_ROOT_PASSWORD=
```

### 9.4 `Dockerfile`

- **Keine Änderung nötig**: `mysql2` ist pure JS → `npm install` bleibt unverändert, kein Build-Toolchain.

### 9.5 `.gitignore`

- `dbdata`-Volume liegt außerhalb des Repos (named volume) → nichts zu ignorieren.
- `data/files.json` bleibt ignoriert (JSON-Backup).

---

## 10. Settings-UI: neues Tab `database`

Neue Tab-Kategorie in `SettingsPage` (Position: nach `storage`), exakt nach `StorageSettings`-Muster.

**Wichtig:** Das Tab zeigt die `db`-Gruppe (Verbindung + Pool + Reconnect). Es gibt **keinen** Driver-Umschalter mehr (MariaDB ist der einzige Store, kein JSON-Fallback).

### 10.1 `DatabaseSettings.jsx` (neu)

`frontend/src/components/settings/DatabaseSettings.jsx`

```jsx
import { useTranslation } from 'react-i18next';
import SettingsField from './SettingsField.jsx';
import SaveFooter from './SaveFooter.jsx';
import useSettingsGroup from '../../hooks/useSettingsGroup.js';

const FIELDS = [
  { key: 'host', type: 'text', label: 'settings.db.host', hint: 'settings.db.hostHint', placeholder: 'settings.db.hostPlaceholder' },
  { key: 'port', type: 'number', label: 'settings.db.port', hint: 'settings.db.portHint', min: 1, max: 65535, step: 1 },
  { key: 'user', type: 'text', label: 'settings.db.user', hint: 'settings.db.userHint' },
  { key: 'password', type: 'password', label: 'settings.db.password', hint: 'settings.db.passwordHint' },
  { key: 'database', type: 'text', label: 'settings.db.database', hint: 'settings.db.databaseHint' },
  { key: 'poolSize', type: 'number', label: 'settings.db.poolSize', hint: 'settings.db.poolSizeHint', min: 1, max: 50, step: 1 },
  { key: 'connectTimeoutMs', type: 'number', label: 'settings.db.connectTimeoutMs', hint: 'settings.db.connectTimeoutMsHint', min: 1000, step: 500 },
  { key: 'retryDelaySec', type: 'number', label: 'settings.db.retryDelaySec', hint: 'settings.db.retryDelaySecHint', min: 0, step: 1 },
  { key: 'maxRetries', type: 'number', label: 'settings.db.maxRetries', hint: 'settings.db.maxRetriesHint', min: 0, max: 100, step: 1 },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);

export default function DatabaseSettings({ settings, loading, error, saving, saved, save }) {
  const { t } = useTranslation();
  const { draft, setField, isLocked, handleSave, handleReset } =
    useSettingsGroup('db', FIELD_KEYS, settings, save);

  return (
    <>
      <div className="settings__body">
        {loading && <p className="settings__loading">{t('settings.loading')}</p>}
        {!loading && (
          <div className="settings__panel">
            <div className="settings__panel-header">
              <h3>{t('settings.db.title')}</h3>
            </div>
            <div className="settings__grid">
              {FIELDS.map((f) => (
                <SettingsField
                  key={f.key}
                  field={f}
                  value={draft?.[f.key]}
                  onChange={(v) => setField(f.key, v)}
                  locked={isLocked(f.key)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <SaveFooter error={error} saving={saving} saved={saved} onSave={handleSave} onReset={handleReset} />
    </>
  );
}
```

- `useSettingsGroup('db', FIELD_KEYS, settings, save)` → liest `settings.db`, sendet Patch `{ db: {...} }`.
- `SaveFooter` wie bei allen anderen Kategorien (Speichern/Zurücksetzen, Fehleranzeige).
- Env-gelockte Felder: `EnvLockBadge` automatisch (`envLocked.db`).

### 10.2 `password`-Feldtyp (neu in `SettingsField.jsx`)

`SettingsField` kennt noch keinen `password`-Typ. Ergänzen (vor dem `text`-Default):

```jsx
if (field.type === 'password') {
  return (
    <label className={baseClass}>
      <span>{t(field.label)} {lockBadge}</span>
      <input
        type="password"
        value={typeof value === 'string' ? value : ''}
        placeholder={field.placeholder ? t(field.placeholder) : undefined}
        disabled={isLocked}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint}
    </label>
  );
}
```

### 10.3 Passwort-Hygiene (Backend)

- `getSettings()`: `db.password` wird **maskiert** zurückgegeben (`'••••••'`), nie der Klartext.
- `save()`: Leerer oder maskierter Passwort-Wert = „unverändert" (nicht nach `config.json` schreiben).
- `saveDefaults()`: `db.password` = `''` (Platzhalter).
- Echter Wert kommt ausschließlich aus der Env (`DB_PASSWORD`).

### 10.4 `SettingsPage.jsx` (ändern)

`CATEGORIES` erweitern (Position: nach `storage`):

```jsx
{ id: 'database', title: 'settings.categories.database', component: DatabaseSettings },
```

### 10.5 i18n-Keys (de/en/it)

```
settings.categories.database
settings.db.title
settings.db.host / hostHint / hostPlaceholder
settings.db.port / portHint
settings.db.user / userHint
settings.db.password / passwordHint
settings.db.database / databaseHint
settings.db.poolSize / poolSizeHint
settings.db.connectTimeoutMs / connectTimeoutMsHint
settings.db.retryDelaySec / retryDelaySecHint
settings.db.maxRetries / maxRetriesHint
```

Beispiel (de):

| Key | Text |
|---|---|
| `categories.database` | "Datenbank" |
| `db.title` | "Datenbank-Verbindung" |
| `db.host` | "Host" |
| `db.hostHint` | "MariaDB-Host (im Compose: `mariadb`)." |
| `db.hostPlaceholder` | "z. B. mariadb" |
| `db.port` | "Port" |
| `db.portHint` | "MariaDB-Port (Default 3306)." |
| `db.user` | "User" |
| `db.userHint` | "App-User (kein root)." |
| `db.password` | "Passwort" |
| `db.passwordHint` | "Leer lassen = unverändert. Env `DB_PASSWORD` hat Vorrang." |
| `db.database` | "Datenbank" |
| `db.databaseHint` | "Name der Datenbank (Default `ragqdrant`)." |
| `db.poolSize` | "Pool-Größe" |
| `db.poolSizeHint` | "Max. parallele Connections (1–50)." |
| `db.connectTimeoutMs` | "Connect-Timeout (ms)" |
| `db.connectTimeoutMsHint` | "Timeout für den DB-Connect." |
| `db.retryDelaySec` | "Reconnect-Intervall (Sekunden)" |
| `db.retryDelaySecHint` | "Wartezeit zwischen Reconnect-Versuchen." |
| `db.maxRetries` | "Max. Reconnects" |
| `db.maxRetriesHint` | "Max. Reconnect-Versuche (0 = unbegrenzt)." |

---

## 11. Fehlerbehandlung & Resilienz

| Szenario | Verhalten |
|---|---|
| DB down bei Server-Start | Kein Crash. Reconnect-Loop (Backoff `db.retryDelaySec`, max. `db.maxRetries`). Snapshot: `store.connected = false`. Andere Services (Dashboard, Logs, MCP) laufen weiter |
| DB down zur Laufzeit | `upsert()` wirft → `FileProcessor`-Fehler → bestehender Retry (`retryDelaySec`, `maxRetries`) → danach Job `error`. Queue bleibt intakt |
| Reconnect erfolgreich | `refresh()` → Frontend holt aktuellen Stand. Pended Jobs werden bei nächstem Dispatcher-Tick erneut versucht |
| Pool erschöpft | `connectionLimit` + `connectTimeout` → Timeout-Fehler statt Hang. `queueLimit: 0` (die FileQueue dämpft die Last ohnehin) |
| Deadlock (parallele Upserts) | `FOR UPDATE` serialisiert pro Pfad; InnoDB-Deadlocks → mysql2-Fehler → Retry-Mechanismus |
| Schema defekt | Migration schlägt fehl → `connect()` bleibt im Retry-Loop + klarer Log (Version, Fehler) |
| Passwort falsch | `connect()` schlägt fehl → Retry-Loop + Log. UI: Settings-Feld `db` zeigt den Fehler-Status |

---

## 12. Tests

### 12.1 Unit (vitest, `server/test/`)

| Test | Inhalt |
|---|---|
| `fileStore.test.js` (bestehend) | **Entfernt** (JSON-Store wird gelöscht) |
| `mariadbFileStore.test.js` (neu) | `mysql2/promise` via `vi.mock` (Fake-Pool): Upsert-Parameter, Merge-Semantik (existing + meta), Row→Entry-Mapping (DATETIME→ISO, meta-Spreizung), `list()`-Sortierung, `get()` null-Fall, `close()` ruft `pool.end()` |
| `migrate.test.js` (neu) | Idempotenz (zweimal laufen = 1 Anwendung), Reihenfolge, `schema_migrations`-Eintrag |
| `config.test.js` (erweitern) | `db`-Gruppe (Defaults, Env-Override, Validierung) |
| `fileProcessor.test.js` (erweitern) | `await` auf upsert; Fake-Store mit async upsert |

### 12.2 Integration (echte MariaDB)

- **Option A (empfohlen):** `testcontainers-node` (devDependency) — Container pro Test-Run, saubere Isolation, CI-fähig.
- **Option B:** `describe.skipIf(!process.env.DB_INTEGRATION)` — Tests laufen nur, wenn `DB_INTEGRATION=1` + lokale MariaDB vorhanden.
- Abdeckung: `connect()` + Migration, Upsert-Roundtrip, Tombstone, Reconnect nach `pool.end()`.

### 12.3 E2E (manuell)

1. `docker compose -f compose.yml -f compose-db.yml up` (bzw. `-f compose-dev.yml -f compose-db.yml`).
2. File anlegen/ändern/löschen im `storage/` → Queue + Frontend live.
3. `docker exec mariadb mariadb -e "SELECT path,status FROM ragqdrant.files"` → Zeilen + Tombstone sichtbar.
4. Server neu starten → Daten bleiben (Persistenz).
5. DB stoppen (`docker compose -f compose-db.yml stop mariadb`) → File-Service bleibt im Reconnect-Loop, Snapshot `store.connected = false`; DB starten → Reconnect + `refresh()`.

---

## 13. Dateien

### Neu

```
server/src/Services/MariaDbFileStore.js
server/src/db/migrate.js
server/src/db/migrations/001_init.sql
server/src/db/import.js
server/test/mariadbFileStore.test.js
server/test/migrate.test.js
frontend/src/components/settings/DatabaseSettings.jsx   # neues Settings-Tab `database`
compose-db.yml                          # mariadb-Service + dbdata-Volume + App-Merge (einziger DB-Ort)
```

### Geändert

```
server/src/Services/FileService.js      # Store = MariaDbFileStore, async store-Calls, connect/Reconnect, close()
server/src/Services/FileProcessor.js    # await upsert, markDeleted async
server/src/FilesWebSocket.js            # onConnection async
server/src/Router/FilesRouter.js        # Handler async
server/src/Config.js                    # db-Gruppe, Validierung, envLocked, Passwort-Masking
server/package.json                     # + mysql2
frontend/src/pages/SettingsPage.jsx     # CATEGORIES: + `database`
frontend/src/components/settings/SettingsField.jsx  # + `password`-Feldtyp
frontend/src/locales/de.json, en.json, it.json      # settings.db.* + settings.categories.database
.env.example                            # DB_*
README.md                               # DB-Abschnitt, Import-CLI, Overlay-Aufruf, Settings-Tab
```

### Entfernt

```
server/src/Services/FileStore.js        # JSON-Store (wird durch MariaDbFileStore ersetzt)
server/test/fileStore.test.js           # Tests des JSON-Stores
data/files.json                         # nicht mehr erzeugt (bleibt als Backup, falls vorhanden)
```

### Unverändert

```
FileWatcher.js, FileQueue.js, WebSocket-Protokoll, REST-API-Shape, Frontend (außer Settings)
compose.yml, compose-dev.yml            # App-Definition; DB kommt via -f compose-db.yml (Pflicht)
```

---

## 14. Umsetzungsschritte

1. **Config**: `db`-Gruppe + Validierung + Tests
2. **`MariaDbFileStore.js`** + Unit-Tests (Fake-Pool)
3. **`migrate.js`** + `001_init.sql` + Tests
4. **`FileService`-Wiring** (Store = `MariaDbFileStore`, async-Ripple: Service, Processor, WebSocket, Router)
5. **Reconnect-Loop** in `FileService.start()` + `store.connected` im Snapshot
6. **`import.js`** (JSON → DB, idempotent)
7. **JSON-Store entfernen**: `FileStore.js` + `fileStore.test.js` löschen
8. **Docker**: `compose-db.yml` (neu, einziger DB-Ort) + `.env.example` — `compose.yml`/`compose-dev.yml` bleiben unverändert
9. **Integration-Tests** (testcontainers oder `DB_INTEGRATION`-Guard)
10. **Settings-UI**: `DatabaseSettings.jsx` + `password`-Feldtyp + `SettingsPage`-Kategorie + i18n + Passwort-Masking
11. **E2E-Check** (Abschnitt 12.3) + README-Update

---

## 15. Edge-Cases & offene Entscheidungen

| Thema | Entscheidung / Option |
|---|---|
| Pfad > 768 Zeichen | Default: `VARCHAR(768)` + Validierung (zu lange Pfade verwerfen + loggen, wie Path-Guard). Alternative: `path_hash CHAR(64)` (SHA-256) als Unique-Key, `path` ohne Index — für exotische Tiefen nötig |
| `list()` bei 100k+ Zeilen | Aktuell: alle Zeilen (API-Kompatibilität). Später: `?limit&offset` oder Cursor-Pagination in `FilesRouter` + Frontend |
| `dataDir` | Nur noch für `config.json` relevant (JSON-Store ist weg). `setPath`-Guard in `FileService` überspringt automatisch (MariaDbFileStore hat keine `setPath`) |
| Zeitzone | Durchgängig UTC (`timezone: 'Z'`, `DATETIME` ohne TZ). Frontend rendert lokal |
| ENUM vs VARCHAR | VARCHAR (erweiterbar). Optional CHECK-Constraint |
| `meta`-JSON vs feste Spalten | Bekannte Felder = Spalten (indexiert), Rest = `meta`-JSON |
| Mehrere Instanzen | MariaDB macht das möglich (JSON nicht). Queue bleibt pro Instanz in-Memory → für echte Multi-Instanz später Queue persistieren (eigener Plan) |
| Rollback | Git-Revert (kein Env-Flag; JSON-Store ist entfernt). `files.json`-Backup bleibt als Notnagel |
| Secrets | `DB_PASSWORD`/`DB_ROOT_PASSWORD` nur via Env, nie in `config.json`, keine Port-Exposition |
| Native Module | Keine (`mysql2` pure JS) → Docker-Build bleibt einfach |
| DB-Backup | `mariadb-dump` via `docker exec` (Betriebsthema, kein App-Code). Optional: Cron + Volume |
| `files.json` nach Migration | Bleibt als Backup. Optional: nach E2E-Grün löschen (manuell) |

---

## 16. Aufwand

| Block | Schätzung |
|---|---|
| Config + async-Ripple | 0,5 Tag |
| `MariaDbFileStore` + Migrations | 1 Tag |
| Docker + Import + Tests | 0,5–1 Tag |
| E2E + Doku | 0,5 Tag |
| **Gesamt** | **~2,5–3 Tage** |
