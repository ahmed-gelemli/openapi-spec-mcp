# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
npm run build        # compile TypeScript → build/index.js (also chmod +x)
npm run watch        # compile in watch mode
npm run inspector    # launch MCP Inspector UI for interactive debugging
```

There are no automated tests in this project.

To run the server locally (stdio mode, for Claude Desktop/Code):
```bash
npm run build && node build/index.js
```

To run in HTTP mode:
```bash
PORT=3000 MCP_AUTH_TOKEN=yourtoken node build/index.js
```

## Architecture

The entire server is a single TypeScript file: `src/index.ts` → `build/index.js`.

**Two transport modes**, selected at startup based on whether `PORT` is set:

- **stdio** (`PORT` unset): connects via `StdioServerTransport` — used when added to Claude Desktop/Code as a local MCP server.
- **HTTP** (`PORT` set): runs a plain Node.js `http.createServer` on `PORT`, exposes `/mcp` (Streamable HTTP transport with session management) and `/health` (unauthenticated, for Coolify health probes). Sessions are tracked in a `Map<sessionId, StreamableHTTPServerTransport>`. CORS headers are applied to every response.

**Spec loading**: OpenAPI JSON files live in `api/` as `{service}-openapi.json`. `getServices()` scans this directory; `loadSpec()` reads and caches specs in `specCache` (a `Map<string, OpenApiSpec>`). The cache is only cleared by `refresh_specs`.

**Bootstrap**: On startup, if `api/` contains no spec files, the server auto-runs `update_specs.py` via `execFile`. In HTTP mode, it also schedules an auto-refresh every 45 minutes.

**`update_specs.py`**: A stdlib-only Python 3 script that downloads OpenAPI specs from `{GATEWAY_URL}/{service}/openapi.json` for each service in `OPENAPI_SERVICES`. Uses parallel downloads, ETags for conditional GETs, retries with backoff, and atomic file writes. Requires `GATEWAY_URL` and `OPENAPI_SERVICES` env vars.

**`$ref` resolution**: `resolveRef()` handles inline `#/` references; `inlineSchema()` recursively inlines schemas up to depth 2. Tool functions like `get_endpoint` and `get_schema` call this to return self-contained schemas to the LLM.

## Environment Variables

Copy `.env.example` to `.env`. Key variables:

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | For HTTP mode | Enables HTTP transport; absent = stdio |
| `MCP_AUTH_TOKEN` | No | Bearer token for `/mcp` auth; if unset, auth is disabled |
| `GATEWAY_URL` | For spec download | Base URL of the API gateway |
| `OPENAPI_SERVICES` | For spec download | Comma-separated service names |
| `OPENAPI_URL_<SERVICE>` | No | Override URL for a specific service |
| `OPENAPI_CONCURRENCY` | No | Max parallel downloads (default: min(8, services)) |

## MCP Tools

All tools return JSON via `content: [{ type: "text", text }]`. Errors use `isError: true` (not thrown).

- `list_services` — lists service names from `api/` directory
- `get_service_info` — title, version, servers, tags, counts
- `list_endpoints` — all endpoints for a service; optional `method`/`tag` filters
- `search_endpoints` — keyword search across path, summary, description, operationId, tags
- `get_endpoint` — full endpoint detail: parameters, request body, responses (refs resolved)
- `list_schemas` — schema/model names from `components.schemas`
- `get_schema` — full schema definition with refs inlined
- `search_schemas` — keyword search over schema names and descriptions
- `refresh_specs` — clears cache and re-runs `update_specs.py`

## Claude Desktop / Claude Code Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "openapi-spec-serve": {
      "command": "/path/to/openapi-spec-serve/build/index.js"
    }
  }
}
```

For HTTP/remote mode (e.g. Coolify deployment), configure Claude Code to connect via the HTTP URL with a Bearer token.
