<p align='center'>
  <h1 align='center' style='margin-bottom:0px'>rag-qdrant-mcp</h1>
  <p align='center'>RAG + MCP + Web UI</p>
</p>

<p align="center">
  <img src=".docs/badges/stack.png" alt="stack | node.js 20+" height="20">
  <img src=".docs/badges/ui.png" alt="ui | vite + react 19" height="20">
  <img src=".docs/badges/rag.png" alt="rag | qdrant + llm" height="20">
  <img src=".docs/badges/mcp.png" alt="mcp | streamable http" height="20">
  <img src=".docs/badges/embeddings.png" alt="embeddings | ollama / openai" height="20">
  <img src=".docs/badges/chat.png" alt="chat | ollama / openai" height="20">
  <img src=".docs/badges/docker.png" alt="docker | compose" height="20">
  <img src=".docs/badges/lang.png" alt="lang | en · de · it" height="20">
  <img src=".docs/badges/bugs.png" alt="bugs | 0 (probably)" height="20">
  <img src=".docs/badges/tests.png" alt="tests | vibes" height="20">
  <img src=".docs/badges/cloud.png" alt="cloud | nein danke" height="20">
  <img src=".docs/badges/uptime.png" alt="uptime | since last restart" height="20">
  <img src=".docs/badges/coffee.png" alt="coffee | unendlich" height="20">
  <img src=".docs/badges/docs.png" alt="docs | this README" height="20">
  <img src=".docs/badges/vectors.png" alt="vectors | qdrant" height="20">
  <img src=".docs/badges/api-keys.png" alt="api keys | 0" height="20">
  <img src=".docs/badges/works.png" alt="works on my machine | yes" height="20">
  <img src=".docs/badges/sync-hope.png" alt="sync | on push, not on hope" height="20">
  <img src=".docs/badges/status.png" alt="status | it works™" height="20">
</p>

A Node.js service that provides **RAG** (Retrieval-Augmented Generation) over a
[Qdrant](https://qdrant.tech) vector database, exposed both as an HTTP API and as an
[MCP](https://modelcontextprotocol.io) (Model Context Protocol) server.

- Vector search + LLM answers over the documents stored in Qdrant.
- An MCP server over [Streamable HTTP](https://modelcontextprotocol.io/docs/concepts/transports#streamable-http-transport) at `/mcp`, exposing `ask` and `search` tools for use by AI assistants such as Claude Code, Cursor, or any MCP-compatible client.
- A Vite + React web UI with a full settings panel (App, Qdrant, Embeddings, Chat, MCP, UI) served by the same Express server.

![Dashboard (dark)](.docs/screenshots/dashboard-dark.png)

The service does not host Qdrant, the embedding model, or the chat LLM — it only
orchestrates reading/writing to those external services. Provide their URLs via
environment variables (see Configuration).

## Prerequisites

- **Docker** (recommended) or Node.js 20+ for local development.
- A running **[Qdrant](https://qdrant.tech)** instance reachable at `QDRANT_URL`:`QDRANT_PORT`.
- An LLM host supporting the embedding and chat APIs you configure (`EMBEDDINGS_API`, `CHAT_API`), e.g. [Ollama](https://ollama.com) or a llama.cpp-compatible OpenAI endpoint.

## Installation and Start with Docker

Copy `.env.example` to `.env` and fill in the required variables:

```bash
cp .env.example .env
```

Start the service with Docker Compose:

```bash
docker compose up --build
```

For local development with hot reload:

```bash
docker compose -f compose-local-dev.yml up --build
```

The service is exposed on the port defined by `SERVER_PORT` (default `3000`).

## Configuration

The environment variables take precedence over `config.json`. In Docker they are
passed via `compose.yml` using a `.env` file:

| Variable           | Description                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `SERVER_PORT`      | Port the service listens on (default: `3000`)                                                                         |
| `VERBOSE`          | Enable verbose logging (`true`/`false`, default: `false`)                                                             |
| `SEARCH_TOP_K`     | Number of chunks retrieved from Qdrant for a RAG answer (default: `10`)                                               |
| `QDRANT_URL`       | Base URL of the Qdrant instance                                                                                       |
| `QDRANT_PORT`      | Port of the Qdrant instance (default: `80`)                                                                           |
| `QDRANT_COLLECTION`| Name of the Qdrant collection (default: `research`)                                                                   |
| `EMBEDDINGS_API`   | Embedding backend: `ollama` (default) posts to `{URL}/api/embed`, `openai` posts to `{URL}/embeddings`               |
| `EMBEDDINGS_URL`   | Base URL of the embedding LLM host (e.g. `http://localhost:11434` for Ollama or `http://localhost:8080/v1` for llama.cpp) |
| `EMBEDDINGS_HOST`  | Optional `Host` header sent with embedding requests (useful behind a reverse proxy)                                   |
| `EMBEDDINGS_MODEL` | Embedding model name (default: `nomic-embed-text`)                                                                    |
| `CHAT_API`         | Chat backend: `ollama` (default) posts to `{URL}/api/chat`, `openai` posts to `{URL}/chat/completions`               |
| `CHAT_URL`         | Base URL of the chat LLM host                                                                                         |
| `CHAT_MODEL`       | Chat model name                                                                                                       |
| `LLM_SYSTEM_PROMPT`| System prompt used by the chat LLM when generating RAG answers                                                        |
| `MCP_ENABLED`      | Enable the MCP server (`true` by default)                                                                             |
| `MCP_PATH`         | MCP endpoint path (default: `/mcp`)                                                                                   |
| `MCP_ALLOWED_HOSTS`| Comma-separated list of allowed hostnames for DNS rebinding protection (e.g. `localhost,127.0.0.1,[::1]`)             |
| `CONFIG_PATH`      | Path to `config.json` (default: `server/config.json`)                                                                 |

The older `LLM_URL`, `LLM_API` and `MODEL_NAME` variables are still supported as
fallbacks for `EMBEDDINGS_URL`, `EMBEDDINGS_API` and `EMBEDDINGS_MODEL`.

Default values are applied in memory when `config.json` is absent. The file is
not written automatically; call `Config.saveDefaults()` (or run
`node index.js --init-config`) to write a sample `config.json` to the `CONFIG_PATH` location.

## MCP (Model Context Protocol)

- The service exposes an MCP server at `/mcp` (configurable via `MCP_PATH`).
- Connect any MCP-compatible client (Claude Code, Cursor, etc.) to
  ```bash
  http://<host>:<port>/mcp
  ```
- The server identifies as `rag-qdrant-mcp v1.0.0` and advertises `tools` capability.

### Tools

| Tool     | Description                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------- |
| `ask`    | Answers a question using RAG (vector search in Qdrant + chat LLM). Takes a `question` string argument.   |
| `search` | Searches the indexed documents with vector search in Qdrant. Returns raw chunks with scores and metadata. Takes a `question` string argument. |

### Example usage

```bash
# Initialize MCP session (stateless HTTP)
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0"}}}'

# List available tools
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# Call the ask tool (RAG with LLM)
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ask","arguments":{"question":"How do I configure the service?"}}}'

# Call the search tool (raw Qdrant chunks)
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search","arguments":{"question":"How do I configure the service?"}}}'
```

Each request is stateless — no session management required.

### Architecture

Built with the MCP TypeScript SDK v2 using a stateless per-request factory pattern:
- `createMcpHandler()` creates a handler from a factory function
- `toNodeHandler()` adapts the handler for Express
- Each request gets a fresh `McpServer` instance via `McpService.createServer()`
- No shared transport state — scales horizontally without session management

## Development

### Local start

```bash
cd server
npm install

# run
SERVER_PORT=3000 \
QDRANT_URL=http://localhost:6333 \
QDRANT_PORT=6333 \
QDRANT_COLLECTION=research \
SEARCH_TOP_K=10 \
EMBEDDINGS_API=ollama \
EMBEDDINGS_URL=http://localhost:11434 \
EMBEDDINGS_MODEL=nomic-embed-text \
CHAT_API=ollama \
CHAT_URL=http://localhost:11434 \
CHAT_MODEL=loaded \
node index.js
```

### Frontend

- The service ships a Vite + React (19) web UI in `frontend/` with a full settings
  panel (App, Qdrant, Embeddings, Chat, MCP, UI) and an About page.
- The Express server serves the UI transparently: in development it runs the Vite
  dev server as middleware (hot reload), in production it serves the built files
  from `frontend/dist` with a SPA fallback (`server/src/Router/FrontendRouter.js`).

#### Screenshots

| Page               | Light                                                                                     | Dark                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Dashboard          | ![Dashboard (light)](.docs/screenshots/dashboard-light.png)                              | ![Dashboard (dark)](.docs/screenshots/dashboard-dark.png)                               |
| Logs               | ![Logs (light)](.docs/screenshots/logs-light.png)                                        | ![Logs (dark)](.docs/screenshots/logs-dark.png)                                         |
| Settings — Server  | ![Settings Server (light)](.docs/screenshots/settings-server-light.png)                  | ![Settings Server (dark)](.docs/screenshots/settings-server-dark.png)                   |
| Settings — Qdrant  | ![Settings Qdrant (light)](.docs/screenshots/settings-qdrant-light.png)                  | ![Settings Qdrant (dark)](.docs/screenshots/settings-qdrant-dark.png)                   |
| Settings — Embeddings | ![Settings Embeddings (light)](.docs/screenshots/settings-embeddings-light.png)        | ![Settings Embeddings (dark)](.docs/screenshots/settings-embeddings-dark.png)           |
| Settings — Chat    | ![Settings Chat (light)](.docs/screenshots/settings-chat-light.png)                      | ![Settings Chat (dark)](.docs/screenshots/settings-chat-dark.png)                       |
| Settings — MCP     | ![Settings MCP (light)](.docs/screenshots/settings-mcp-light.png)                        | ![Settings MCP (dark)](.docs/screenshots/settings-mcp-dark.png)                         |
| Settings — UI      | ![Settings UI (light)](.docs/screenshots/settings-ui-light.png)                          | ![Settings UI (dark)](.docs/screenshots/settings-ui-dark.png)                           |
| About              | ![About (light)](.docs/screenshots/about-light.png)                                      | ![About (dark)](.docs/screenshots/about-dark.png)                                       |

#### Develop

```bash
cd frontend
npm install
npm run dev
```

In development the Vite dev server is embedded in the Express app, so no separate
proxy is needed. The UI talks to the backend same-origin by default.

#### Build

```bash
cd frontend
npm run build
```

The production build is created automatically by the Dockerfile before the server
starts (see `compose.yml`).

## Endpoints

### `GET /`

The Web UI.

### `POST /search`

Accepts a JSON body with a `question` field and returns `{ "answer": "..." }` based
on the indexed documents. Returns `404` if no answer could be generated.

### `POST /search/stream`

Streams the RAG answer as Server-Sent Events. Accepts a JSON body with a `question`
field. Yields events of type `status` (embedding/search/thinking phases), `thinking`
(reasoning tokens), `answer` (content tokens), `empty` (no results), `done`
(completion), and `error`. Useful for displaying progressive answers in the frontend.

### `GET /health`

Returns the service status: `{ "status": "ok" }`.

### `GET /api/settings`

Returns the current settings object (App, Qdrant, Embeddings, Chat, MCP) plus the
`envLocked` map describing which fields are pinned by environment variables.

### `PUT /api/settings`

Applies a partial settings patch. Returns `{ applied, restartRequired }`. Env-locked
fields are ignored (the environment variable always wins).

