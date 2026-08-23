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

**Bootstrap**: On startup, if `api/` contains no spec files, the server auto-runs the spec updater (`SPEC_UPDATE_SCRIPT`, default `update_specs.py`) via `execFile`. In HTTP mode, it also schedules an auto-refresh every `REFRESH_INTERVAL_MIN` minutes (default 45, `0` disables).

**Two spec sources.** Which script runs is set by `SPEC_UPDATE_SCRIPT`; both write `api/{service}-openapi.json`, so everything downstream is identical.

**`update_specs.py`**: A stdlib-only Python 3 script that downloads OpenAPI specs from `{GATEWAY_URL}/{service}/openapi.json` for each service in `OPENAPI_SERVICES`. Uses parallel downloads, ETags for conditional GETs, retries with backoff, and atomic file writes. Requires `GATEWAY_URL` and `OPENAPI_SERVICES` env vars.

**`update_specs_canvas.py`**: Serves the Canvas LMS API. Canvas publishes no OpenAPI 3 document — its `rake doc:openapi` task requires a booted Canvas app with a database — but it does serve Swagger 1.2 at `{CANVAS_URL}/doc/api/`, one file per resource. This script downloads all 144 resources and converts them to OpenAPI 3.0.3, one spec per resource. Notes:
- Canvas hardcodes `basePath` to `canvas.instructure.com` in every file, so `servers[]` is rebuilt from `CANVAS_URL`.
- Swagger 1.2 scopes models per resource, but operations reference models owned by other resources; foreign models are copied in transitively so each emitted spec resolves its own `$ref`s. 12 model names are defined by more than one resource — the local definition always wins.
- Canvas puts bare types ("Array", "Hash") and prose where a model name belongs, and embeds `{"$ref": ...}` inside `example` values; both are normalized. ~38 types Canvas references but never defines degrade to `object`/`string` with the original name kept in `description`.
- No conditional GET: the global model index needs every document on each run. Unchanged output is not rewritten.

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
| `SPEC_UPDATE_SCRIPT` | No | Updater to run (default `update_specs.py`; `update_specs_canvas.py` for Canvas) |
| `SPEC_UPDATE_TIMEOUT_MS` | No | Timeout for one update run (default 120000) |
| `REFRESH_INTERVAL_MIN` | No | Minutes between auto-refreshes in HTTP mode (default 45; `0` disables) |
| `CANVAS_URL` | For Canvas | Canvas base URL; specs from `/doc/api/`, live calls to `/api` |
| `CANVAS_RESOURCES` | No | Comma-separated subset of Canvas resources (default: all 144) |
| `GATEWAY_MODE` | No | `service` (default) → `GATEWAY_URL/{service}{path}`; `flat` → `GATEWAY_URL{path}` |
| `API_BEARER_TOKEN` | No | Sent as `Authorization: Bearer` on `call_endpoint` unless the caller passes its own |
| `CLIENT_TOKEN_MODE` | No | `off` (default) → all callers share `API_BEARER_TOKEN`; `authorization` → each client sends its own upstream token |
| `IDENTITY_PATH` | No | Upstream path that resolves a token to an account (default `/api/v1/users/self`) |
| `ADMIN_TOKEN` | No | Bearer token for `GET /usage`; if unset the endpoint is disabled |
| `LOG_TOKENS` | No | `true` records each caller's raw API token in the usage log and identity log lines |
| `PUBLIC_URL` | No | Public origin used in the OAuth metadata documents (default: `X-Forwarded-*` headers) |
| `SERVICE_LABEL` | No | Names the upstream in the consent page's error message (default: `Canvas` when `CANVAS_URL` is set) |

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
- `refresh_specs` — clears cache and re-runs the configured spec updater
- `call_endpoint` — executes a real HTTP request against the upstream API (URL shape set by `GATEWAY_MODE`)

## Per-caller tokens and usage accounting

With `CLIENT_TOKEN_MODE=authorization`, each MCP client configures its own upstream API token as the `Authorization` header instead of a shared `MCP_AUTH_TOKEN`.

- **Gate**: `authorizeRequest()` resolves the token against `{GATEWAY_URL}{IDENTITY_PATH}` at connect. 401/403 refuses the connection (negative result cached 60s); an unreachable upstream fails *open* with an unverified identity, since the spec tools serve public documentation and a bad token still fails on the `call_endpoint` that uses it.
- **Plumbing**: an `AsyncLocalStorage` (`callerStore`) wraps `/mcp` handling, carrying the token into the tool handlers. `toolCallEndpoint` precedence is: `headers.Authorization` passed to the tool → caller's token → `API_BEARER_TOKEN`.
- **Identity**: `sha256(token)[:12]` is the stable key; the upstream account id and name are attached when resolvable.
- **`LOG_TOKENS`**: off by default, in which case raw tokens stay in memory only. Set `true` and every usage record and `[identity]` log line carries the caller's live upstream credential, kept for as long as the log is (forever). `/usage` still withholds them unless `?tokens=1`, so a routine rollup does not print credentials; the file always has them.
- **Usage log**: one JSONL record per tool call in `api/usage/YYYY-MM.jsonl` — on the same persistent volume as the specs, split monthly, never pruned. `getServices()` only matches `*-openapi.json`, so the subdirectory is invisible to it.
- **`GET /usage`**: `ADMIN_TOKEN`-gated. Default returns a per-user rollup; `?month=YYYY-MM`, `?user=<id|key>`, `?raw=1&limit=N` for records. `DELETE /usage?confirm=1` purges the records (optionally `&month=`); the `confirm` guard is there because the files are the only copy.

`CLIENT_TOKEN_MODE` defaults to `off`, which is the pre-existing behavior — both deployments share one image, so the gateway app is unaffected.

## OAuth (`src/oauth.ts`)

claude.ai's custom-connector UI accepts a URL and an optional OAuth client id/secret — there is no custom-header field, so the header scheme above cannot be configured there. Canvas's own OAuth2 provider needs a developer key only a Canvas admin can issue, so the server is the authorization server instead and the "login" step is a page asking the user to paste a Canvas access token. Enabled automatically whenever `CLIENT_TOKEN_MODE=authorization`; in `off` mode none of these routes exist.

- **Routes**: `/.well-known/oauth-protected-resource` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414, also served at `/.well-known/openid-configuration` and with a `/mcp` suffix, since clients probe both), `POST /oauth/register` (RFC 7591 — claude.ai self-registers), `GET|POST /oauth/authorize` (consent page), `POST /oauth/token`. All sit ahead of the auth gate, and a 401 on `/mcp` carries the `WWW-Authenticate: Bearer resource_metadata="…"` challenge that starts the flow.
- **Clients are public**: no secrets issued, PKCE (`S256`) mandatory, `redirect_uri` matched exactly against what was registered, codes single-use with a 10-minute TTL. The consent form posts only an opaque `request_id`; the redirect target stays server-side so a tampered form cannot redirect the code elsewhere.
- **Grant tokens** are prefixed `mcp_`. `authorizeRequest()` accepts either one of those (looked up to the stored Canvas token) or a raw upstream token as before, so Claude Code and claude.ai work against the same endpoint. A grant whose stored token the upstream rejects is deleted, and positive identity lookups are cached only 10 minutes so an upstream revocation takes effect without a redeploy.
- **State**: `api/oauth/oauth.json` on the persistent volume — registered clients and grants. In-flight authorize requests and codes are in memory and are meant to be.
- **`GET /admin/grants`** lists connected accounts (identity only, never the credentials), `DELETE /admin/grants?id=<id>` revokes one and `?all=1` drops every grant and client; same `ADMIN_TOKEN` gate as `/usage`.
- **Consent page** is deliberately wordless — one field, one button. The only copy is the refusal message, since without it a mistyped token is a silent dead end. Whoever runs a deployment tells users where to make a token; the page does not.

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
