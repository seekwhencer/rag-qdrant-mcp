# RULES FRONTEND

Abstrakte Regeln und Patterns für `frontend/`. Neue Code muss diesen Regeln folgen.
Keine neuen Libraries einführen, es sei denn, es ist explizit gewünscht.

## 1. Stack & Grundgerüst

- React 19 + Vite, ESM, **kein TypeScript**, JSX-Dateien (`.jsx`) bzw. `.js` für Logik.
- **Kein State-Management-Framework** (kein Redux/Context-Zwang): Hooks + Props-Drilling.
- **Kein CSS-Framework**: Hand-CSS mit Custom Properties + BEM.
- `axios` und `@tanstack/react-query` stehen in `package.json`, werden aber **nicht** verwendet.
  Datenfluss läuft über `fetch` (REST) + `WebSocket` (Live) in eigenen Hooks. Nicht anfassen.
- Icons: `lucide-react` (mit `size`-Prop). Dekorative Inline-SVGs nur mit `aria-hidden="true"`.
- Kommentare/JSDoc im Code: **Deutsch**.

## 2. Verzeichnisstruktur

```
src/
  pages/          Eine Datei pro Route (DashboardPage, SettingsPage, LogsPage, AboutPage)
  components/     Feature-Ordner: dashboard/, settings/, logs/, ui/ (generisch)
                  Top-Level nur für App-Shell: TopNav, ThemeToggle, LanguageSwitcher
  hooks/          Daten-Hooks (useSettings, useSettingsGroup, useLogStream, useDashboardStream)
  api/            Dünner REST-Client (nur fetch-Wrapper + Endpunkte)
  services/       Lokale, browserseitige State (appSettings: useSyncExternalStore + localStorage)
  utils/          Reine Funktionen (format.js, primaryColor.js, secondaryColor.js, radius.js)
  locales/        en.json, de.json, it.json
  style/          index.css → variables.css, typo.css, global.css, components/*.css
```

- Neue Feature-Komponente → in den passenden Feature-Ordner, nie in `components/` Wurzel.
- Generische UI-Bausteine (Slider, Buttons) → `components/ui/`.
- Reine Logik ohne React → `utils/`. React-Hook → `hooks/`.

## 3. Routing

- Alle Routen zentral in `App.jsx` (`<Routes>`), Wildcard + `/` leiten auf `/dashboard` um.
- Navigation: `NavLink` aus `react-router-dom`; aktiver Zustand über `pathname.startsWith(...)`
  oder `isActive` → BEM-Modifier `--active`.
- Settings-Kategorien: Route `/settings/:category?`, Kategorie-Liste als `CATEGORIES`-Array
  (id + i18n-Titel + Komponente) in der Page; Default-Kategorie bei fehlendem Param.
- Tab-Wechsel = `navigate()`, kein State-Toggle.

## 4. Datenfluss

### 4.1 REST (Settings)

- Dünner Client in `api/settings.js`: ein `request()`-Wrapper (JSON-Header, Fehler-Normalisierung:
  `body.error || status`, Netzwerkfehler → `Connection to server failed.`).
- **Server ist Source of Truth.** Nach `PUT` (Patch) sofort `GET` neu laden, nicht lokal patchen.
- `useSettings` kapselt: `settings, loading, saving, error, saved, load, save`.
  `saved`-Flag leuchtet ~2,5 s und schaltet sich selbst ab.
- Page lädt Settings **einmal** und reicht sie als Props an die Kategorie-Komponenten →
  Tab-Wechsel ohne Reload, kein Leer-Blitzen.

### 4.2 WebSocket (Live-Daten)

- **Kein Polling.** Server pusht; Client wartet.
- Protokoll: JSON `{ type, data }`.
  - Dashboard: `snapshot` (einmalig) + `update` (bei Änderung).
  - Logs: `history` (einmalig) + `line` (neu) + `update` (letzte Zeile ersetzen).
- URL: `ws(s)://location.host/<pfad>`, Proto aus `location.protocol` ableiten.
- Reconnect-Pattern (beide Hooks identisch):
  - `closed`-Flag verhindert Reconnect nach Unmount.
  - `onclose` → `setTimeout(connect, RECONNECT_MS)` (2 s), Timer in Ref.
  - Cleanup: `closed = true`, `clearTimeout`, `ws.close()`.
  - Malformed JSON → still ignorieren (`catch {}`).
  - `enabled`-Option zum Deaktivieren.
- Puffer begrenzen (Logs: `MAX_LINES = 2000`, `slice` von hinten).
- `onopen` bei Logs: Buffer leeren (History folgt direkt, kein Duplikat nach Reconnect).

## 5. Settings-Formular-Pattern

Jede Server-Settings-Kategorie folgt exakt diesem Aufbau:

1. **`FIELDS`-Array** (Modul-Konstante): `{ key, type, label, hint?, min?, max?, step?, options?, placeholder? }`.
   - `label`/`hint`/`placeholder` sind **i18n-Keys**, keine Texte.
   - `type` ∈ `text | number | checkbox | textarea | select | list`.
2. **`FIELD_KEYS = FIELDS.map(f => f.key)`** — stabile Referenz für den Hook.
3. **`useSettingsGroup(groupKey, FIELD_KEYS, settings, save)`**:
   - Draft-State (lokal), Lazy-Init, Re-Init bei `settings`-Änderung.
   - `setField(key, value)`, `isLocked(key)` (aus `settings.envLocked[groupKey][key]`),
     `handleSave` (baut Patch: `root` → flach, sonst `{ [groupKey]: draft }`), `handleReset`.
4. **`SettingsField`** rendert generisch nach `field.type`; bei Lock: Input `disabled` + `EnvLockBadge`.
5. **`SaveFooter`** rendert `error` / `saved` / `saving` + Reset- und Save-Button.
6. Layout: `settings__body` → `settings__panel` → `settings__panel-header` (h3) → `settings__grid`.
   Loading-Zustand: `settings__loading` statt Panel.

Neue Kategorie = neue Datei in `components/settings/` nach diesem Muster + Eintrag in `CATEGORIES`
in `SettingsPage.jsx` + i18n-Keys in allen drei `locales/*.json`.

## 6. Lokale UI-Settings (nur Browser)

- `services/appSettings.js`: Modul-Cache + `Set` von Listeners + `useSyncExternalStore`.
  Persistenz: `localStorage` (Key `rag-qdrant-mcp.appSettings`), **immer** in `try/catch`
  (Private Mode) → Fallback In-Memory.
- Defaults **lazy** berechnen (erster Zugriff, nicht Modul-Init), damit CSS-Basiswerte schon geladen sind.
- Anwendung: `App.jsx` setzt per `useEffect` die `:root`-CSS-Variablen
  (`--color-primary`, `--color-secondary`, `--radius-factor`).
- Farben: **nur Hue** einstellbar (0–360); Sättigung + Helligkeit fix, zur Laufzeit aus der
  CSS-Basisfarbe (`getComputedStyle` → HSL, gecacht; Fallback-Hex muss mit `variables.css` synchron bleiben).
- Roundness: `--radius-factor` skaliert alle `--radius-*` (in `variables.css` per `calc()`).
- UI-Settings haben **keinen Save-Button** (sofort wirksam, lokal) — nur Reset.

## 7. Theming

- Alle Farben/Abstände/Radien/Fonts als **Custom Properties** in `style/variables.css`.
  Komponente-CSS darf **keine** harten Werte (hex, px für Abstände) — nur `var(...)`.
- Light = Default. Dark via:
  - `@media (prefers-color-scheme: dark)` + `:root:not([data-theme="light"])` (System-Präferenz),
  - `:root[data-theme="dark"]` (manueller Override).
- Abgeleitete Farben (hover/active/subtle) per `color-mix(in srgb, ...)` — nie neu hardcoden.
- `ThemeToggle`: Priorität DOM-Attribut → `localStorage('ui.theme')` → System-Präferenz.
  Setzt `document.documentElement.dataset.theme` + persistiert.
- `focus-visible`-Outline global (primary), `prefers-reduced-motion` wird global respektiert.

## 8. i18n

- **Jeder** sichtbare Text über `t('key')`. Keine hartkodierten Strings in JSX.
- Keys namespaced: `nav.*`, `dashboard.*`, `settings.*`, `pages.logs.*`, `about.*`, `theme.*`, `language.*`.
- Dynamische Werte per Interpolation: `t('settings.envLocked', { env: envName })`.
- Strukturierte Inhalte (Listen/Objekte) über `t('key', { returnObjects: true })` (About-Page).
- Sprachen: `en` (Fallback), `de`, `it`. Neue Sprache = neue Datei in `locales/` + Eintrag in `i18n.js` + `LanguageSwitcher`.
- Persistenz: `localStorage('ui.lang')`; Detection: gespeichert → `navigator.language`-Präfix → `en`.
- `escapeValue: false` (React escapet), `useSuspense: false` (Bundle synchron).
- Neue i18n-Keys müssen in **allen drei** Sprachdateien landen.

## 9. Styling

- **BEM**: `block__element--modifier` (z. B. `dash-card__value--mono`, `settings__tab--active`).
- Design-Tokens: `--space-*` (4px-Basis), `--fs-*`, `--radius-*`, `--shadow-*`, `--transition`, `--font-sans/mono`.
- Ein CSS-File pro Komponente in `style/components/`, importiert über `components/index.css`.
- Page-Wrapper-Pattern: `<div class="xxx-page"><div class="xxx">…</div></div>`
  (`dash-page/dash`, `logs-page/logs`, `settings-page/settings`, `about-page/about`).
- Status-Klassen: `is-on` / `is-off` (Live/Offline, Enabled/Disabled), `is-active` (Filter/Tab),
  `--ok` / `--err` / `--warn` (Werte), `--locked` (Felder).
- Datenwerte (URLs, Zahlen, Versionen) in **Mono-Font** (`--font-mono` bzw. `--mono`-Modifier).
- Fehlende Werte: `—` (Gedankenstrich) als Platzhalter, nie `null`/`undefined` rendern.
- Fonts self-hosted (woff2, `@font-face`, `font-display: swap`) in `style/fonts/`.

## 10. Komponenten-Konventionen

- Function Components, **default export**, Props dekonstruiert.
- JSDoc-Block bei nicht-trivialen Komponenten (Props dokumentieren).
- Konstanten (Listen, Limits, Level-Arrays) als Modul-Konstante oben im File.
- Zustände explizit rendern: Loading, Empty, Error (z. B. `dash__loading`, `logviewer__state`, `settings__loading`).
- Defensive Datenzugriffe: `data?.server`, `mcp?.sessions || []`.
- A11y: `aria-label` auf Icon-Buttons, `role="tablist"/"tab"` + `aria-selected` auf Tabs,
  `role="group"` auf Filter-Gruppen, `tabIndex={0}` + `role="tooltip"` auf Badges.
- `useMemo` für abgeleitete Listen (z. B. gefilterte Logs).
- Lazy State-Init: `useState(buildDraft)` statt `useState(null)` + Effect.

## 11. Code-Stil

- ES-Module, Importe mit **expliziter Endung** (`./x.jsx`, `./x.js`).
- `localStorage`-Zugriffe **immer** in `try/catch`.
- Reine Utils ohne Side Effects; Side-Effect-Funktionen (`apply*`) klar benannt und getrennt.
- Fehler normalisieren: API-Fehler → `Error` mit menschenlesbarer Message; UI zeigt `error`-Banner.
- Keine `console.log` in Produktionscode (Ausnahme: `vite.config.js` Debug-Log).

## 12. Build & Dev

- Vite läuft in `middlewareMode` (wird vom Node-Server serviert), `appType: 'custom'`.
- CSP-Header werden in `vite.config.js` gesetzt — bei neuen Script-/Style-Quellen anpassen.
- WS-Proxy: `server.ws` (Host/Port via `VITE_WS_HOST` / `VITE_WS_PORT`).
- Build: `npm run build` → `dist/` (wird vom Server ausgeliefert).
