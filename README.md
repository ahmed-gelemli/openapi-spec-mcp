# openapi-spec-mcp

An MCP (Model Context Protocol) server that gives Claude instant access to your OpenAPI specs. Point it at an API gateway, and Claude can discover services, explore endpoints, inspect schemas, and make live API calls — all from a conversation.

## What it does

The server downloads OpenAPI JSON files from your gateway, caches them locally, and exposes them through 10 MCP tools. Claude can use these to understand your API surface without you pasting schemas into chat.

**Tools provided:**

| Tool | Description |
|---|---|
| `list_services` | List all services that have local spec files |
| `get_service_info` | Title, version, servers, tags, endpoint/schema counts |
| `list_endpoints` | All endpoints for a service; filter by method or tag |
| `search_endpoints` | Keyword search across path, summary, description, operationId, tags |
| `get_endpoint` | Full endpoint detail: parameters, request body, response schemas (refs resolved) |
| `list_schemas` | All schema/model names from `components.schemas` |
| `get_schema` | Full schema definition with `$ref`s inlined up to 2 levels |
| `search_schemas` | Keyword search over schema names and descriptions |
| `call_endpoint` | Execute a live HTTP request against the gateway and return the response |
| `refresh_specs` | Re-download all specs and clear the in-memory cache |

## Architecture

Single TypeScript source file (`src/index.ts`) compiled to `build/index.js`. Two transport modes selected at startup:

- **stdio** (`PORT` unset) — connects via `StdioServerTransport`, used when added to Claude Desktop or Claude Code as a local MCP server
- **HTTP** (`PORT` set) — runs a Node.js HTTP server on `PORT`, exposes `/mcp` (Streamable HTTP with session management) and `/health` (unauthenticated, for health probes); sessions tracked in-memory; CORS applied to every response

Spec files live in `api/` as `{service}-openapi.json`. `update_specs.py` (stdlib-only Python 3) handles downloads: parallel fetches, ETag/Last-Modified conditional GETs, retries with exponential backoff, and atomic file writes. The server auto-runs it on startup if `api/` is empty, and schedules a refresh every 45 minutes in HTTP mode.

## Setup

### Prerequisites

- Node.js 20+
- Python 3 (for spec downloads)

### Install & build

```bash
npm install
npm run build
```

### Environment variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `PORT` | HTTP mode only | Enables HTTP transport; omit for stdio mode |
| `MCP_AUTH_TOKEN` | No | Bearer token for `/mcp`; if unset, auth is disabled. Ignored when `CLIENT_TOKEN_MODE=authorization` |
| `CLIENT_TOKEN_MODE` | No | `off` (default) or `authorization` — see [Per-user tokens](#per-user-tokens) |
| `IDENTITY_PATH` | No | Upstream path resolving a token to an account (default `/api/v1/users/self`) |
| `ADMIN_TOKEN` | No | Bearer token for `GET /usage`; if unset the endpoint is disabled |
| `LOG_TOKENS` | No | `true` records callers' raw API tokens in the usage log — see [Per-user tokens](#per-user-tokens) |
| `API_BEARER_TOKEN` | No | Token sent on `call_endpoint` when the caller supplies none |
| `GATEWAY_URL` | Yes (for downloads) | Base URL of your API gateway |
| `OPENAPI_SERVICES` | Yes (for downloads) | Comma-separated service names to fetch |
| `OPENAPI_URL_<SERVICE>` | No | Override fetch URL for a specific service |
| `OPENAPI_CONCURRENCY` | No | Max parallel downloads (default: `min(8, services)`) |
| `OPENAPI_TIMEOUT` | No | HTTP timeout in seconds (default: `20`) |
| `OPENAPI_RETRIES` | No | Retry attempts on transient errors (default: `3`) |

Services are fetched from `{GATEWAY_URL}/{service-name}/openapi.json` by default. Override individual URLs with `OPENAPI_URL_<SERVICE_NAME_UPPER>` (hyphens become underscores).

## Usage

### Local (stdio) — Claude Desktop / Claude Code

```bash
npm run build && node build/index.js
```

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openapi-spec-serve": {
      "command": "/absolute/path/to/openapi-spec-serve/build/index.js"
    }
  }
}
```

Set `GATEWAY_URL` and `OPENAPI_SERVICES` in a `.env` file in the project root, or export them in your shell before launching.

### Remote (HTTP) — Docker / Coolify

```bash
PORT=3000 MCP_AUTH_TOKEN=yourtoken GATEWAY_URL=... OPENAPI_SERVICES=... node build/index.js
```

Or with Docker:

```bash
docker build -t openapi-spec-serve .
docker run -p 3000:3000 \
  -e MCP_AUTH_TOKEN=yourtoken \
  -e GATEWAY_URL=https://your-gateway.example.com \
  -e OPENAPI_SERVICES=service-one,service-two \
  openapi-spec-serve
```

The `/health` endpoint returns `{"ok": true, "services": N}` and requires no auth — suitable for Coolify or any container health probe.

Configure Claude Code to connect via HTTP:

```json
{
  "mcpServers": {
    "openapi-spec-serve": {
      "type": "http",
      "url": "https://your-deployment.example.com/mcp",
      "headers": {
        "Authorization": "Bearer yourtoken"
      }
    }
  }
}
```

### Per-user tokens

By default every caller shares one upstream credential (`API_BEARER_TOKEN`) and `MCP_AUTH_TOKEN` guards the endpoint. Set `CLIENT_TOKEN_MODE=authorization` to flip that around: each person configures **their own** upstream API token on their MCP client, and the server forwards it.

```bash
CLIENT_TOKEN_MODE=authorization
ADMIN_TOKEN=$(openssl rand -hex 32)   # for GET /usage
# MCP_AUTH_TOKEN and API_BEARER_TOKEN are not needed in this mode
```

Each user then connects with their own token:

```bash
claude mcp add --transport http canvas https://your-deployment.example.com/mcp \
  --header "Authorization: Bearer <their own API token>"
```

At connect the token is checked against `{GATEWAY_URL}{IDENTITY_PATH}` — a rejected token is refused with a clear message rather than failing later on the first call. Everything a caller does is then attributed to the account that token belongs to.

Callers appear in logs and usage records as their upstream account id and name, with a truncated SHA-256 of the token as a stable fallback key. By default the token value itself is held in memory only and never written anywhere.

Setting `LOG_TOKENS=true` changes that: every usage record and identity log line then carries the caller's raw upstream credential. Those are live tokens for other people's accounts, kept as long as the log is — which is forever — so anyone with the volume, the container logs, or `ADMIN_TOKEN` holds working accounts for every caller, revoked and current alike. `/usage` still withholds them unless you pass `?tokens=1`, so a routine rollup check does not print credentials to your terminal.

### Usage stats

Every tool call appends one JSONL record to `api/usage/YYYY-MM.jsonl`, on the same persistent volume as the specs. Files are split by month and never pruned.

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://your-deployment.example.com/usage
```

```json
{
  "total_calls": 418,
  "users": {
    "12345": {
      "key": "31fb6cd49575", "name": "Ada L.",
      "calls": 300, "errors": 2, "bytes": 1840221,
      "by_tool": { "call_endpoint": 210, "search_endpoints": 90 },
      "by_status": { "200": 205, "404": 5 },
      "first_seen": "2026-08-21T09:02:11.004Z",
      "last_seen": "2026-08-21T18:44:02.117Z"
    }
  }
}
```

Filters: `?month=YYYY-MM`, `?user=<account id or key>`, and `?raw=1&limit=N` for individual records. With `LOG_TOKENS=true`, `?tokens=1` includes the stored token values and `?user=` also matches on a token.

## Development

```bash
npm run watch      # compile in watch mode
npm run inspector  # launch MCP Inspector UI for interactive debugging
```

The MCP Inspector gives you a browser UI to call tools directly against the server — useful for testing new spec sources without involving Claude.

## License

MIT
