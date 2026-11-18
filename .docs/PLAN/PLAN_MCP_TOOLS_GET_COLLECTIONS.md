# PLAN: MCP Tool `get_collections`

## Ziel

Drittes MCP-Tool: `get_collections` — holt die Liste aller Qdrant-Collections und stellt sie dar.
Keine neuen Abhängigkeiten, keine Config-Änderungen.

## Ist-Zustand

- `McpService` registriert aktuell 2 Tools: `ask` + `search` (`server/src/Services/McpService.js:49-87`).
- Beide Tools nutzen `this.search` (SearchService).
- `SearchService` hält `this.qdrant` (QdrantService) (`server/src/Services/SearchService.js:52`).
- `QdrantService` kapselt `QdrantClient` aus `@qdrant/js-client-rest` (`server/src/Services/QdrantService.js`).
- `QdrantClient` hat `getCollections()` → `{ collections: [{ name }] }` (Client entpackt `result`).
- `QdrantClient` hat `getCollection(name)` → direkt `CollectionInfo` (`points_count`, `config.params.vectors`).
- `McpRouter` ist generisch (kein Tool-Register) → keine Änderung nötig.
- `Server.js` baut `McpService` mit `{ search, logger }` → keine Änderung nötig.

## Änderungen

### 1. `QdrantService` — neue Methode `listCollections()`

Datei: `server/src/Services/QdrantService.js`

```js
/**
 * Lists all collections in Qdrant with their info (name, points_count, …).
 * Collections whose info cannot be loaded are skipped.
 * @returns {Promise<Array<object>>} CollectionInfo objects
 */
async listCollections() {
    const { collections } = await this.client.getCollections();
    const names = (collections || []).map((c) => c.name);
    const infos = await Promise.all(
        names.map((name) => this.client.getCollection(name).catch(() => null))
    );
    return infos.filter(Boolean);
}
```

- `getCollections()` liefert nur Namen → `getCollection(name)` pro Collection für `points_count`/Distanz (parallel, Fehler pro Collection werden übersprungen).
- Gesamtfehler (z. B. Qdrant nicht erreichbar) werden **nicht** geschluckt → an die MCP-Schicht weiterreichen.
- JSDoc im bestehenden Stil.

### 2. `McpService` — Tool `get_collections` registrieren

Datei: `server/src/Services/McpService.js`

Neues `registerTool`-Block nach `search` (Zeile 87), gleicher Stil wie `ask`/`search`:

```js
this.mcpServer.registerTool(
    'get_collections',
    {
        description: 'Listet alle Qdrant-Collections mit Name, Punktanzahl und Vektor-Konfiguration.',
        inputSchema: z.object({})
    },
    async () => {
        try {
            const collections = await this.search.qdrant.listCollections();
            if (collections.length === 0) {
                return {
                    content: [{ type: 'text', text: 'Keine Collections gefunden. Qdrant ist leer.' }],
                    isError: false
                };
            }
            const rows = collections.map((c) => {
                const v = c.config?.params?.vectors;
                let distance;
                if (v && typeof v === 'object') {
                    distance = v.distance !== undefined
                        ? v.distance
                        : Object.values(v)[0]?.distance;
                }
                return {
                    name: c.name,
                    points: c.points_count,
                    distance
                };
            });
            return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Collections konnten nicht geladen werden: ${err?.message || err}` }],
                isError: true
            };
        }
    }
);
```

Entscheidungen:
- **Tool-Name:** `get_collections` (snake_case, passt zu `ask`/`search`).
- **Kein Input** → `z.object({})`.
- **Zugriff auf Qdrant** über `this.search.qdrant` → kein neuer Dependency-Injection-Pfad, `Server.js` bleibt unverändert.
- **Darstellung:** kompakte JSON-Zeilen (Name, Punkte, Vektoren, Distanz) statt rohem `CollectionInfo`-Dump.
- **Fehlerfall:** `isError: true` + Meldung (Qdrant down, Timeout).

### 3. Tests

Datei: `server/test/qdrant.test.js`

- `clientMock` um `getCollections: vi.fn()` + `getCollection: vi.fn()` erweitern (hoisted Mock, Zeile 4-11).
- `beforeEach`: `clientMock.getCollections.mockReset().mockResolvedValue({ collections: [] })`, `clientMock.getCollection.mockReset().mockResolvedValue({})`.
- Test: `listCollections returns enriched collection infos` → `getCollections` → `{ collections: [{ name: 'research' }] }`, `getCollection` → `{ name, points_count: 42 }` → `expect(...).toEqual([{ name: 'research', points_count: 42 }])`.
- Test: `listCollections returns an empty array when no collections exist` → `mockResolvedValue({})` → `expect(...).toEqual([])`.
- Test: `listCollections skips collections whose info fails` → ein `getCollection`-Aufruf rejectet → wird übersprungen.

Optional (empfohlen): neue Datei `server/test/mcpService.test.js`

- `McpService` mit Mock-Search (`{ qdrant: { listCollections: vi.fn() } }`) instanziieren.
- `createServer()` aufrufen, Tool-Handler für `get_collections` aufrufen:
  - Happy Path → JSON-Text enthält `research`.
  - Leere Liste → Text `Keine Collections gefunden…`.
  - Fehler → `isError: true`.

## Nicht ändern

- `server/src/Server.js` (DI bleibt `{ search, logger }`)
- `server/src/Router/McpRouter.js` (generisch)
- `server/src/Config.js`
- Frontend

## Verifikation

1. `npm test` in `server/` (Vitest) — alle Tests grün, keine bestehenden Tests angefasst.
2. Manuell (optional): MCP-Client gegen `/mcp` → `tools/list` zeigt `get_collections` → Aufruf liefert die Collections der laufenden Qdrant-Instanz.

## Aufwand

- 2 Dateien geändert (`QdrantService.js`, `McpService.js`), 1-2 Testdateien.
- Keine Migration, keine neue Abhängigkeit, kein Breaking Change.
