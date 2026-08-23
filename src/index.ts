#!/usr/bin/env node
import "dotenv/config";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "child_process";
import { readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync, unlinkSync } from "fs";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID, createHash } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import {
  GRANT_PREFIX,
  handleOAuth,
  initOAuthStore,
  listGrants,
  lookupGrant,
  revokeAllGrants,
  revokeGrant,
  type OAuthContext,
} from "./oauth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// build/ is one level below the project root
const PROJECT_ROOT = join(__dirname, "..");
const API_DIR = join(PROJECT_ROOT, "api");
// Which downloader runs for this deployment: the gateway one by default, or a
// source-specific script such as update_specs_canvas.py.
const UPDATE_SCRIPT = join(PROJECT_ROOT, process.env.SPEC_UPDATE_SCRIPT ?? "update_specs.py");
const UPDATE_TIMEOUT_MS = Number(process.env.SPEC_UPDATE_TIMEOUT_MS ?? 120_000);
const REFRESH_INTERVAL_MIN = Number(process.env.REFRESH_INTERVAL_MIN ?? 45);

// Upstream request shape for call_endpoint.
// "service" (default): GATEWAY_URL/{service}{path} — one base URL fronting many services.
// "flat": GATEWAY_URL{path} — a single API such as Canvas, where the spec files
// are a documentation split rather than separately addressable services.
const GATEWAY_MODE = (process.env.GATEWAY_MODE ?? "service").toLowerCase() === "flat" ? "flat" : "service";
const API_BEARER_TOKEN = process.env.API_BEARER_TOKEN ?? "";

// Where the upstream token on a call_endpoint request comes from.
// "off" (default): every caller shares the deployment's API_BEARER_TOKEN.
// "authorization": each client configures its own upstream token as the MCP
// Authorization header; it is forwarded upstream and identifies the caller.
const CLIENT_TOKEN_MODE =
  (process.env.CLIENT_TOKEN_MODE ?? "off").toLowerCase() === "authorization" ? "authorization" : "off";
// Upstream endpoint used to turn a caller's token into an account identity.
const IDENTITY_PATH = process.env.IDENTITY_PATH ?? "/api/v1/users/self";
// Gates GET /usage. Unrelated to any caller's own token.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
// Records each caller's raw API token in the usage log and identity log lines.
// These are live upstream credentials kept forever on the volume: anyone with
// the volume, the container logs, or ADMIN_TOKEN gets working accounts for
// every caller, revoked and current alike. Off unless deliberately enabled.
const LOG_TOKENS = (process.env.LOG_TOKENS ?? "").toLowerCase() === "true";

// Public origin of this deployment, used to build the absolute URLs in the
// OAuth metadata documents. Derived from the proxy's forwarding headers when
// unset, which is right in every normal deployment but wrong the moment
// something rewrites Host — so it can be pinned.
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
const CANVAS_URL = (process.env.CANVAS_URL ?? "").replace(/\/$/, "");
// Names the upstream in the one message the consent page can show.
const SERVICE_LABEL = process.env.SERVICE_LABEL ?? (CANVAS_URL ? "Canvas" : "API");

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string, ...args: unknown[]) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ${msg}`, ...args);
}

// ---------------------------------------------------------------------------
// Per-caller identity (CLIENT_TOKEN_MODE=authorization)
// ---------------------------------------------------------------------------

// Callers are identified by the account the token resolves to, with a
// truncated SHA-256 of the token as a stable fallback when it cannot.
// The raw token is recorded alongside that identity only when LOG_TOKENS=true.

type Identity = {
  key: string;      // sha256(token)[:12] — stable across sessions, not reversible
  id?: string;      // upstream account id, when resolved
  name?: string;    // upstream display name, when resolved
  verified: boolean;
};

type CallerContext = { token: string; identity: Identity };

// Used in stdio mode and whenever CLIENT_TOKEN_MODE is off: no per-caller
// token, so call_endpoint falls back to API_BEARER_TOKEN.
const ANONYMOUS: CallerContext = {
  token: "",
  identity: { key: "-", name: "server", verified: false },
};

// Carries the calling client's token from the HTTP layer down into the tool
// handlers, which the MCP SDK gives no direct way to thread through.
const callerStore = new AsyncLocalStorage<CallerContext>();

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function bearerToken(req: IncomingMessage): string {
  const match = /^Bearer\s+(.+)$/i.exec((req.headers.authorization ?? "").trim());
  return match ? match[1].trim() : "";
}

const REJECTED_MESSAGE =
  "The upstream API rejected this token. Check that it is current and has not been revoked.";
const MISCONFIGURED_MESSAGE =
  "This server could not verify tokens against the upstream API — its GATEWAY_URL/IDENTITY_PATH " +
  "configuration is wrong. Connections are refused until that is fixed; contact whoever runs it.";

// Positive results are cached so an MCP request does not cost an upstream
// round trip, but only briefly: a token revoked in the upstream's UI has to
// stop working here without waiting for a redeploy.
const identityCache = new Map<string, { identity: Identity; at: number }>();
const identityRejected = new Map<string, number>();
const REJECT_TTL_MS = 60_000;
const IDENTITY_TTL_MS = 10 * 60_000;

type IdentityResult =
  | { ok: true; identity: Identity }
  | { ok: false; reason: string; message: string };

// Fails OPEN only when the upstream could not answer at all — a network error
// or a 5xx — because the spec tools serve public documentation and need no
// credentials, and a bad token still fails on the call_endpoint that uses it.
// Any 4xx fails CLOSED: the upstream answered, and a 404 there means
// IDENTITY_PATH is wrong, which must never silently disable authentication.
async function resolveIdentity(token: string): Promise<IdentityResult> {
  const key = tokenKey(token);

  const cached = identityCache.get(key);
  if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) return { ok: true, identity: cached.identity };
  const rejectedAt = identityRejected.get(key);
  if (rejectedAt !== undefined && Date.now() - rejectedAt < REJECT_TTL_MS) {
    return { ok: false, reason: `key=${key} rejected upstream (cached)`, message: REJECTED_MESSAGE };
  }

  const gatewayUrl = process.env.GATEWAY_URL;
  if (!gatewayUrl) {
    log(`[identity] GATEWAY_URL is not set — refusing, identity cannot be verified`);
    return { ok: false, reason: "GATEWAY_URL not set", message: MISCONFIGURED_MESSAGE };
  }

  const url = `${gatewayUrl.replace(/\/$/, "")}${IDENTITY_PATH}`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 401 || response.status === 403) {
      identityRejected.set(key, Date.now());
      log(`[identity] ${IDENTITY_PATH} rejected key=${key}${tokenSuffix(token)}`);
      return { ok: false, reason: `key=${key} rejected upstream`, message: REJECTED_MESSAGE };
    }
    if (response.status >= 400 && response.status < 500) {
      // The upstream answered, so this is not an outage — most likely
      // IDENTITY_PATH does not exist under GATEWAY_URL. Refuse rather than
      // let a configuration mistake turn into an unauthenticated endpoint.
      log(
        `[identity] ${IDENTITY_PATH} returned ${response.status} — refusing. ` +
        `Check that GATEWAY_URL + IDENTITY_PATH resolves to the identity endpoint ` +
        `(currently ${url}).`
      );
      return { ok: false, reason: `identity path returned ${response.status}`, message: MISCONFIGURED_MESSAGE };
    }
    if (!response.ok) {
      // 5xx — treat as an outage and fail open
      log(`[identity] ${IDENTITY_PATH} returned ${response.status} — allowing key=${key} unverified${tokenSuffix(token)}`);
      return { ok: true, identity: { key, verified: false } };
    }

    const body = (await response.json()) as Record<string, unknown>;
    const identity: Identity = {
      key,
      id: body.id !== undefined ? String(body.id) : undefined,
      name: (body.name ?? body.short_name ?? body.display_name) as string | undefined,
      verified: true,
    };
    identityCache.set(key, { identity, at: Date.now() });
    log(`[identity] key=${key} resolved to ${identity.id ?? "?"} (${identity.name ?? "unnamed"})${tokenSuffix(token)}`);
    return { ok: true, identity };
  } catch (e) {
    // Network error or timeout — the upstream never answered, so fail open
    log(`[identity] lookup failed (${e instanceof Error ? e.message : String(e)}) — allowing key=${key} unverified${tokenSuffix(token)}`);
    return { ok: true, identity: { key, verified: false } };
  }
}

// Probes the identity endpoint at startup with a token that cannot be valid.
// A correctly configured endpoint answers 401/403; anything else means the
// URL is wrong and every connection would be refused, so say so loudly here
// rather than leaving it to be discovered one failed client at a time.
async function checkIdentityEndpoint(): Promise<void> {
  const gatewayUrl = process.env.GATEWAY_URL;
  if (!gatewayUrl) {
    log(`[identity] WARNING: CLIENT_TOKEN_MODE=authorization but GATEWAY_URL is not set — all connections will be refused`);
    return;
  }
  const url = `${gatewayUrl.replace(/\/$/, "")}${IDENTITY_PATH}`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: "Bearer probe-not-a-real-token", Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) {
      log(`[identity] ${url} → ${response.status}, identity endpoint looks correct`);
    } else {
      log(`[identity] WARNING: ${url} → ${response.status} for an invalid token; expected 401/403.`);
      log(`[identity] WARNING: IDENTITY_PATH is probably wrong for this GATEWAY_URL — all connections will be refused.`);
    }
  } catch (e) {
    log(`[identity] could not probe ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Appended to identity log lines; empty unless LOG_TOKENS is on.
function tokenSuffix(token: string): string {
  return LOG_TOKENS ? ` token=${token}` : "";
}

function describeIdentity(identity: Identity): string {
  if (identity.id) return `${identity.id}${identity.name ? ` (${identity.name})` : ""}`;
  return identity.key;
}

// ---------------------------------------------------------------------------
// Usage log — one JSONL record per tool call, split by month, never pruned
// ---------------------------------------------------------------------------

// Lives inside API_DIR so it lands on the same persistent volume as the specs
// and survives redeploys. getServices() only matches *-openapi.json, so this
// subdirectory is invisible to it.
const USAGE_DIR = join(API_DIR, "usage");

type UsageRecord = {
  ts: string;
  key: string;
  token?: string;   // raw caller credential — only when LOG_TOKENS=true
  user?: string;
  name?: string;
  tool: string;
  ok: boolean;
  ms: number;
  bytes?: number;
  method?: string;
  path?: string;
  query?: Record<string, string>;
  status?: number;
  error?: string;
};

function recordUsage(record: UsageRecord): void {
  try {
    mkdirSync(USAGE_DIR, { recursive: true });
    appendFileSync(join(USAGE_DIR, `${record.ts.slice(0, 7)}.jsonl`), `${JSON.stringify(record)}\n`);
  } catch (e) {
    // Accounting must never break the tool call it is accounting for
    log(`[usage] could not write record: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function readUsage(month?: string): UsageRecord[] {
  if (!existsSync(USAGE_DIR)) return [];
  const files = readdirSync(USAGE_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .filter((f) => !month || f === `${month}.jsonl`)
    .sort();

  const records: UsageRecord[] = [];
  for (const file of files) {
    for (const line of readFileSync(join(USAGE_DIR, file), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as UsageRecord);
      } catch {
        // A torn final line from an interrupted write — skip it
      }
    }
  }
  return records;
}

// Deletes the accounting outright. The records carry raw caller credentials
// when LOG_TOKENS is on, so being able to start clean matters more than
// keeping a history nobody asked for.
function purgeUsage(month?: string): string[] {
  if (!existsSync(USAGE_DIR)) return [];
  const removed: string[] = [];
  for (const file of readdirSync(USAGE_DIR)) {
    if (!file.endsWith(".jsonl")) continue;
    if (month && file !== `${month}.jsonl`) continue;
    unlinkSync(join(USAGE_DIR, file));
    removed.push(file);
  }
  return removed;
}

type UsageSummary = {
  key: string;
  token?: string;
  user?: string;
  name?: string;
  calls: number;
  errors: number;
  bytes: number;
  by_tool: Record<string, number>;
  by_status: Record<string, number>;
  first_seen: string;
  last_seen: string;
};

// Tokens live in the file but are withheld from /usage responses unless the
// caller explicitly asks, so a routine rollup check does not paste live
// credentials into a terminal or a shell history.
function stripTokens<T extends { token?: string }>(rows: T[]): T[] {
  return rows.map(({ token: _token, ...rest }) => rest as T);
}

function summarizeUsage(records: UsageRecord[], includeTokens: boolean): unknown {
  const users = new Map<string, UsageSummary>();

  for (const r of records) {
    const id = r.user ?? r.key;
    let u = users.get(id);
    if (!u) {
      u = {
        key: r.key, token: r.token, user: r.user, name: r.name,
        calls: 0, errors: 0, bytes: 0,
        by_tool: {}, by_status: {},
        first_seen: r.ts, last_seen: r.ts,
      };
      users.set(id, u);
    }
    if (r.name) u.name = r.name;
    if (r.token) u.token = r.token;
    u.calls++;
    if (!r.ok) u.errors++;
    u.bytes += r.bytes ?? 0;
    u.by_tool[r.tool] = (u.by_tool[r.tool] ?? 0) + 1;
    if (r.status !== undefined) u.by_status[String(r.status)] = (u.by_status[String(r.status)] ?? 0) + 1;
    if (r.ts < u.first_seen) u.first_seen = r.ts;
    if (r.ts > u.last_seen) u.last_seen = r.ts;
  }

  const ranked = [...users.entries()].sort((a, b) => b[1].calls - a[1].calls);
  return {
    total_calls: records.length,
    users: Object.fromEntries(
      includeTokens ? ranked : ranked.map(([id, u]) => [id, stripTokens([u])[0]])
    ),
  };
}

// ---------------------------------------------------------------------------
// Spec loading + in-memory cache
// ---------------------------------------------------------------------------

type OpenApiSpec = Record<string, unknown>;
const specCache = new Map<string, OpenApiSpec>();

function getServices(): string[] {
  if (!existsSync(API_DIR)) return [];
  return readdirSync(API_DIR)
    .filter((f) => f.endsWith("-openapi.json"))
    .map((f) => f.replace("-openapi.json", ""))
    .sort();
}

function loadSpec(service: string): OpenApiSpec | null {
  if (specCache.has(service)) return specCache.get(service)!;
  const filePath = join(API_DIR, `${service}-openapi.json`);
  if (!existsSync(filePath)) return null;
  try {
    const spec = JSON.parse(readFileSync(filePath, "utf-8")) as OpenApiSpec;
    specCache.set(service, spec);
    return spec;
  } catch {
    return null;
  }
}

function loadAllSpecs(): void {
  const services = getServices();
  for (const svc of services) loadSpec(svc);
  log(`Loaded ${services.length} spec(s): [${services.join(", ")}]`);
}

// ---------------------------------------------------------------------------
// OpenAPI helpers
// ---------------------------------------------------------------------------

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

function resolveRef(spec: OpenApiSpec, ref: string): Record<string, unknown> {
  if (!ref.startsWith("#/")) return { $ref: ref };
  const parts = ref.slice(2).split("/");
  let obj: unknown = spec;
  for (const p of parts) {
    if (obj && typeof obj === "object") obj = (obj as Record<string, unknown>)[p];
    else return {};
  }
  return (typeof obj === "object" && obj !== null ? obj : {}) as Record<string, unknown>;
}

function inlineSchema(
  spec: OpenApiSpec,
  schema: Record<string, unknown>,
  depth = 0,
  maxDepth = 2
): Record<string, unknown> {
  if (depth >= maxDepth) return schema;
  if ("$ref" in schema && typeof schema.$ref === "string") {
    return inlineSchema(spec, resolveRef(spec, schema.$ref), depth + 1, maxDepth);
  }

  const result = { ...schema };

  // Inline combinator arrays (allOf / oneOf / anyOf)
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as Record<string, unknown>[]).map((s) =>
        inlineSchema(spec, s, depth + 1, maxDepth)
      );
    }
  }

  // Inline array items (regardless of whether type:"array" is declared)
  if (result.items && typeof result.items === "object") {
    result.items = inlineSchema(spec, result.items as Record<string, unknown>, depth + 1, maxDepth);
  }

  // Inline object properties (regardless of whether type:"object" is declared)
  if (result.properties && typeof result.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result.properties as Record<string, unknown>)) {
      props[k] = inlineSchema(spec, v as Record<string, unknown>, depth + 1, maxDepth);
    }
    result.properties = props;
  }

  return result;
}

function getSchemas(spec: OpenApiSpec): Record<string, unknown> {
  const components = spec.components as Record<string, unknown> | undefined;
  return (components?.schemas as Record<string, unknown>) ?? {};
}

function getPaths(spec: OpenApiSpec): Record<string, Record<string, unknown>> {
  return (spec.paths as Record<string, Record<string, unknown>>) ?? {};
}

// ---------------------------------------------------------------------------
// Tool implementations — throw Error for user-facing failures so the handler
// can return isError: true. Never return { error: "..." } objects.
// ---------------------------------------------------------------------------

function requireService(service: string): OpenApiSpec {
  const spec = loadSpec(service);
  if (!spec) throw new Error(`Service '${service}' not found. Available: ${getServices().join(", ") || "none — run refresh_specs"}`);
  return spec;
}

function toolListServices(): string[] {
  return getServices();
}

function toolGetServiceInfo(service: string): unknown {
  const spec = requireService(service);

  const info = (spec.info as Record<string, unknown>) ?? {};
  const tags = ((spec.tags as unknown[]) ?? []).map((t) => {
    const tag = t as Record<string, unknown>;
    return { name: tag.name, description: tag.description ?? "" };
  });
  const servers = ((spec.servers as unknown[]) ?? []).map(
    (s) => (s as Record<string, unknown>).url
  );

  const paths = getPaths(spec);
  let opCount = 0;
  for (const pathItem of Object.values(paths)) {
    for (const m of HTTP_METHODS) if (m in pathItem) opCount++;
  }

  return {
    service,
    title: info.title ?? "",
    version: info.version ?? "",
    description: info.description ?? "",
    servers,
    tags,
    pathCount: Object.keys(paths).length,
    operationCount: opCount,
    schemaCount: Object.keys(getSchemas(spec)).length,
  };
}

function toolListEndpoints(service: string, method?: string, tag?: string): unknown {
  const spec = requireService(service);

  const results: unknown[] = [];
  for (const [path, pathItem] of Object.entries(getPaths(spec))) {
    for (const m of HTTP_METHODS) {
      const op = pathItem[m] as Record<string, unknown> | undefined;
      if (!op) continue;
      if (method && m !== method.toLowerCase()) continue;
      const opTags = (op.tags as string[]) ?? [];
      if (tag && !opTags.includes(tag)) continue;
      results.push({
        method: m.toUpperCase(),
        path,
        operationId: op.operationId ?? "",
        summary: op.summary ?? "",
        tags: opTags,
      });
    }
  }

  return results.sort((a: unknown, b: unknown) => {
    const ar = a as Record<string, string>;
    const br = b as Record<string, string>;
    return ar.path < br.path ? -1 : ar.path > br.path ? 1 : 0;
  });
}

function toolSearchEndpoints(query: string, service?: string): unknown[] {
  const queryLower = query.toLowerCase();
  const services = service ? [service] : getServices();
  const results: unknown[] = [];

  for (const svc of services) {
    const spec = loadSpec(svc);
    if (!spec) continue;
    for (const [path, pathItem] of Object.entries(getPaths(spec))) {
      for (const m of HTTP_METHODS) {
        const op = pathItem[m] as Record<string, unknown> | undefined;
        if (!op) continue;
        const searchable = [
          path,
          m,
          op.summary ?? "",
          op.description ?? "",
          op.operationId ?? "",
          ...((op.tags as string[]) ?? []),
        ]
          .join(" ")
          .toLowerCase();
        if (searchable.includes(queryLower)) {
          results.push({
            service: svc,
            method: m.toUpperCase(),
            path,
            operationId: op.operationId ?? "",
            summary: op.summary ?? "",
            description: op.description ?? "",
            tags: (op.tags as string[]) ?? [],
          });
        }
      }
    }
  }

  return results;
}

function toolGetEndpoint(service: string, path: string, method: string): unknown {
  const spec = requireService(service);

  const paths = getPaths(spec);
  const pathItem = paths[path];
  if (!pathItem) throw new Error(`Path '${path}' not found in service '${service}'`);

  const op = pathItem[method.toLowerCase()] as Record<string, unknown> | undefined;
  if (!op) throw new Error(`Method '${method.toUpperCase()}' not found for path '${path}' in service '${service}'`);

  // Parameters (merge path-level + operation-level)
  const rawParams = [
    ...((pathItem.parameters as unknown[]) ?? []),
    ...((op.parameters as unknown[]) ?? []),
  ];
  const parameters = rawParams.map((p) => {
    let param = p as Record<string, unknown>;
    if ("$ref" in param && typeof param.$ref === "string") {
      param = resolveRef(spec, param.$ref);
    }
    return {
      name: param.name ?? "",
      in: param.in ?? "",
      required: param.required ?? false,
      description: param.description ?? "",
      schema: inlineSchema(spec, (param.schema as Record<string, unknown>) ?? {}),
    };
  });

  // Request body
  let requestBody: unknown = null;
  if (op.requestBody) {
    let rb = op.requestBody as Record<string, unknown>;
    if ("$ref" in rb && typeof rb.$ref === "string") rb = resolveRef(spec, rb.$ref);
    const content = rb.content as Record<string, Record<string, unknown>> | undefined;
    const schemas: Record<string, unknown> = {};
    for (const [mt, mo] of Object.entries(content ?? {})) {
      schemas[mt] = inlineSchema(spec, (mo.schema as Record<string, unknown>) ?? {});
    }
    requestBody = {
      required: rb.required ?? false,
      description: rb.description ?? "",
      content: schemas,
    };
  }

  // Responses
  const responses: Record<string, unknown> = {};
  for (const [status, resp] of Object.entries(
    (op.responses as Record<string, Record<string, unknown>>) ?? {}
  )) {
    let r = resp;
    if ("$ref" in r && typeof r.$ref === "string") r = resolveRef(spec, r.$ref);
    const content = r.content as Record<string, Record<string, unknown>> | undefined;
    const schemas: Record<string, unknown> = {};
    for (const [mt, mo] of Object.entries(content ?? {})) {
      schemas[mt] = inlineSchema(spec, (mo.schema as Record<string, unknown>) ?? {});
    }
    responses[status] = { description: r.description ?? "", content: schemas };
  }

  return {
    service,
    method: method.toUpperCase(),
    path,
    operationId: op.operationId ?? "",
    summary: op.summary ?? "",
    description: op.description ?? "",
    tags: (op.tags as string[]) ?? [],
    parameters,
    requestBody,
    responses,
  };
}

function toolListSchemas(service: string): unknown {
  const spec = requireService(service);
  return Object.keys(getSchemas(spec)).sort();
}

function toolGetSchema(service: string, schemaName: string): unknown {
  const spec = requireService(service);

  const schemas = getSchemas(spec);
  let name = schemaName;
  if (!(name in schemas)) {
    const match = Object.keys(schemas).find((k) => k.toLowerCase() === schemaName.toLowerCase());
    if (!match) throw new Error(`Schema '${schemaName}' not found in service '${service}'`);
    name = match;
  }

  return {
    service,
    name,
    schema: inlineSchema(spec, schemas[name] as Record<string, unknown>),
  };
}

function toolSearchSchemas(query: string, service?: string): unknown[] {
  const queryLower = query.toLowerCase();
  const services = service ? [service] : getServices();
  const results: unknown[] = [];

  for (const svc of services) {
    const spec = loadSpec(svc);
    if (!spec) continue;
    for (const [name, schema] of Object.entries(getSchemas(spec))) {
      const s = schema as Record<string, unknown>;
      const searchable = [name, s.title ?? "", s.description ?? ""].join(" ").toLowerCase();
      if (searchable.includes(queryLower)) {
        const props = Object.keys((s.properties as Record<string, unknown>) ?? {});
        results.push({
          service: svc,
          name,
          description: s.description ?? "",
          properties: props.slice(0, 20),
          propertyCount: props.length,
        });
      }
    }
  }

  return results;
}

async function toolCallEndpoint(
  service: string,
  path: string,
  method: string,
  pathParams?: Record<string, string>,
  queryParams?: Record<string, string>,
  body?: unknown,
  headers?: Record<string, string>,
  timeoutMs?: number
): Promise<unknown> {
  const gatewayUrl = process.env.GATEWAY_URL;
  if (!gatewayUrl) throw new Error("GATEWAY_URL environment variable is not set");

  requireService(service);

  // Substitute path parameters
  let resolvedPath = path;
  if (pathParams) {
    for (const [key, value] of Object.entries(pathParams)) {
      resolvedPath = resolvedPath.replace(`{${key}}`, encodeURIComponent(value));
    }
  }

  // Build URL: GATEWAY_URL/{service}{path}, or GATEWAY_URL{path} in flat mode
  const base = gatewayUrl.replace(/\/$/, "");
  let url = GATEWAY_MODE === "flat" ? `${base}${resolvedPath}` : `${base}/${service}${resolvedPath}`;

  if (queryParams && Object.keys(queryParams).length > 0) {
    url += `?${new URLSearchParams(queryParams).toString()}`;
  }

  const requestHeaders: Record<string, string> = { ...headers };
  // Token precedence: an Authorization header passed to this tool wins, then the
  // token the MCP client authenticated with, then the deployment-wide fallback.
  if (!Object.keys(requestHeaders).some((h) => h.toLowerCase() === "authorization")) {
    const token = callerStore.getStore()?.token || API_BEARER_TOKEN;
    if (token) {
      requestHeaders["Authorization"] = `Bearer ${token}`;
    } else if (CLIENT_TOKEN_MODE === "authorization") {
      throw new Error(
        "No API token available for this request. This server forwards the token you " +
        "configured on the MCP connection, so add it as an 'Authorization: Bearer <token>' header."
      );
    }
  }
  const upperMethod = method.toUpperCase();

  const fetchOptions: RequestInit = {
    method: upperMethod,
    headers: requestHeaders,
    signal: AbortSignal.timeout(timeoutMs ?? 30_000),
  };

  if (body !== undefined && !["GET", "HEAD"].includes(upperMethod)) {
    requestHeaders["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (e) {
    throw new Error(`Request failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  let responseBody: unknown;
  if (contentType.includes("application/json")) {
    try {
      responseBody = await response.json();
    } catch {
      responseBody = await response.text();
    }
  } else {
    responseBody = await response.text();
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => { responseHeaders[key] = value; });

  return {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body: responseBody,
  };
}

function toolRefreshSpecs(): Promise<unknown> {
  return new Promise((resolve) => {
    if (!existsSync(UPDATE_SCRIPT)) {
      resolve({ success: false, errors: `Update script not found at ${UPDATE_SCRIPT}` });
      return;
    }

    mkdirSync(API_DIR, { recursive: true });

    execFile("python3", [UPDATE_SCRIPT], { cwd: PROJECT_ROOT, timeout: UPDATE_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (!err) specCache.clear();
      resolve({
        success: !err,
        output: stdout,
        errors: stderr || (err?.message ?? ""),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

// The parts of a tool call worth keeping in the usage log. Only call_endpoint
// touches the upstream API, so only it contributes request detail.
function callDetails(name: string, args: Record<string, unknown>) {
  if (name !== "call_endpoint") return {};
  return {
    method: args.method ? String(args.method).toUpperCase() : undefined,
    path: args.path as string | undefined,
    query: args.query_params as Record<string, string> | undefined,
  };
}

function createMcpServer(): Server {
  const server = new Server(
    { name: "openapi-spec-serve", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_services",
        description: "List all available OpenAPI services that have local spec files.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_service_info",
        description:
          "Get an overview of a service: title, version, description, servers, tags, and counts of paths/operations/schemas.",
        inputSchema: {
          type: "object",
          properties: {
            service: { type: "string", description: "Service name (from list_services)" },
          },
          required: ["service"],
        },
      },
      {
        name: "list_endpoints",
        description:
          "List all endpoints for a service. Optionally filter by HTTP method or tag. Returns method, path, operationId, summary, tags.",
        inputSchema: {
          type: "object",
          properties: {
            service: { type: "string", description: "Service name (from list_services)" },
            method: {
              type: "string",
              description: "Optional HTTP method filter (get, post, put, patch, delete)",
            },
            tag: { type: "string", description: "Optional tag filter" },
          },
          required: ["service"],
        },
      },
      {
        name: "search_endpoints",
        description:
          "Search for endpoints across all services (or one service) by keyword. Searches path, method, summary, description, operationId, and tags.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search keyword or phrase" },
            service: { type: "string", description: "Optional: restrict search to one service" },
          },
          required: ["query"],
        },
      },
      {
        name: "get_endpoint",
        description:
          "Get full details for a specific endpoint: parameters, request body schema, and response schemas.",
        inputSchema: {
          type: "object",
          properties: {
            service: { type: "string", description: "Service name (from list_services)" },
            path: { type: "string", description: "API path e.g. /patients/{id}" },
            method: { type: "string", description: "HTTP method e.g. get, post" },
          },
          required: ["service", "path", "method"],
        },
      },
      {
        name: "list_schemas",
        description: "List all schema/model names defined in a service's components.",
        inputSchema: {
          type: "object",
          properties: {
            service: { type: "string", description: "Service name (from list_services)" },
          },
          required: ["service"],
        },
      },
      {
        name: "get_schema",
        description:
          "Get the full definition of a specific schema/model from a service (with $refs resolved up to 2 levels).",
        inputSchema: {
          type: "object",
          properties: {
            service: { type: "string", description: "Service name (from list_services)" },
            schema_name: { type: "string", description: "Schema name e.g. Patient, CreatePatientRequest" },
          },
          required: ["service", "schema_name"],
        },
      },
      {
        name: "search_schemas",
        description:
          "Search schema/model definitions by name or description across all services (or one service).",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search keyword or phrase" },
            service: { type: "string", description: "Optional: restrict search to one service" },
          },
          required: ["query"],
        },
      },
      {
        name: "refresh_specs",
        description:
          "Re-download all OpenAPI spec files from the API gateway by running the update script. Clears the in-memory cache.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "call_endpoint",
        description:
          "Execute a real HTTP request against a gateway API endpoint. " +
          "Use get_endpoint first to confirm the correct path, method, parameters, and body schema. " +
          (GATEWAY_MODE === "flat"
            ? "URL is built as: GATEWAY_URL{path} (the service name selects the spec file, not the URL). "
            : "URL is built as: GATEWAY_URL/{service}{path}. ") +
          (CLIENT_TOKEN_MODE === "authorization"
            ? "Authentication uses the API token this MCP connection was configured with, applied automatically. "
            : API_BEARER_TOKEN
              ? "Authentication is applied automatically. "
              : "") +
          "Responses are never cached — each call hits the live API. " +
          "Returns {status, statusText, headers, body} where body is parsed JSON or raw text.",
        inputSchema: {
          type: "object",
          properties: {
            service: { type: "string", description: "Service name from list_services e.g. 'patients'" },
            path: { type: "string", description: "Exact path from the spec with {param} placeholders e.g. /patients/{id}" },
            method: { type: "string", description: "HTTP method in any case: get, post, put, patch, delete" },
            path_params: {
              type: "object",
              description: "Values for {param} placeholders in path. e.g. {\"id\": \"abc123\"}. Omit if path has no placeholders.",
              additionalProperties: { type: "string" },
            },
            query_params: {
              type: "object",
              description: "URL query string key-value pairs. e.g. {\"page\": \"1\", \"limit\": \"20\"}. All values must be strings.",
              additionalProperties: { type: "string" },
            },
            body: {
              description: "JSON request body for POST/PUT/PATCH. Must match the schema from get_endpoint. Omit for GET/DELETE.",
            },
            headers: {
              type: "object",
              description: "Extra request headers. Use for auth: {\"Authorization\": \"Bearer <token>\"}. Content-Type is set automatically when body is present.",
              additionalProperties: { type: "string" },
            },
            timeout_ms: {
              type: "number",
              description: "Request timeout ms. Default 30000. Increase for slow or long-running endpoints.",
            },
          },
          required: ["service", "path", "method"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const a = args as Record<string, string | undefined>;
    const started = Date.now();
    const caller = callerStore.getStore() ?? ANONYMOUS;

    try {
      let result: unknown;

      switch (name) {
        case "list_services":
          result = toolListServices();
          break;
        case "get_service_info":
          result = toolGetServiceInfo(a.service!);
          break;
        case "list_endpoints":
          result = toolListEndpoints(a.service!, a.method, a.tag);
          break;
        case "search_endpoints":
          result = toolSearchEndpoints(a.query!, a.service);
          break;
        case "get_endpoint":
          result = toolGetEndpoint(a.service!, a.path!, a.method!);
          break;
        case "list_schemas":
          result = toolListSchemas(a.service!);
          break;
        case "get_schema":
          result = toolGetSchema(a.service!, a.schema_name!);
          break;
        case "search_schemas":
          result = toolSearchSchemas(a.query!, a.service);
          break;
        case "refresh_specs":
          result = await toolRefreshSpecs();
          break;
        case "call_endpoint": {
          const aa = args as Record<string, unknown>;
          result = await toolCallEndpoint(
            aa.service as string,
            aa.path as string,
            aa.method as string,
            aa.path_params as Record<string, string> | undefined,
            aa.query_params as Record<string, string> | undefined,
            aa.body,
            aa.headers as Record<string, string> | undefined,
            aa.timeout_ms as number | undefined
          );
          break;
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      let text: string;
      try {
        text = JSON.stringify(result, null, 2);
      } catch {
        text = JSON.stringify({ error: "Result could not be serialized" });
      }

      const upstreamStatus =
        name === "call_endpoint" && result && typeof result === "object"
          ? (result as { status?: number }).status
          : undefined;
      const ms = Date.now() - started;

      recordUsage({
        ts: new Date().toISOString(),
        key: caller.identity.key,
        token: LOG_TOKENS && caller.token ? caller.token : undefined,
        user: caller.identity.id,
        name: caller.identity.name,
        tool: name,
        ok: true,
        ms,
        bytes: text.length,
        ...callDetails(name, args as Record<string, unknown>),
        status: upstreamStatus,
      });
      log(
        `tool=${name} user=${describeIdentity(caller.identity)}` +
        (upstreamStatus !== undefined ? ` status=${upstreamStatus}` : "") +
        ` ms=${ms} bytes=${text.length}`
      );

      return { content: [{ type: "text", text }] };
    } catch (e) {
      // Re-throw MCP protocol errors (unknown tool, etc.) — SDK handles these
      if (e instanceof McpError) throw e;
      // User-facing tool errors: report via isError so the LLM sees the failure
      const message = e instanceof Error ? e.message : String(e);
      log(`Tool '${name}' error (user=${describeIdentity(caller.identity)}): ${message}`);
      recordUsage({
        ts: new Date().toISOString(),
        key: caller.identity.key,
        token: LOG_TOKENS && caller.token ? caller.token : undefined,
        user: caller.identity.id,
        name: caller.identity.name,
        tool: name,
        ok: false,
        ms: Date.now() - started,
        ...callDetails(name, args as Record<string, unknown>),
        error: message,
      });
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Bootstrap: download specs if api/ dir is empty
// ---------------------------------------------------------------------------

async function bootstrapIfNeeded(): Promise<void> {
  mkdirSync(API_DIR, { recursive: true });
  const hasFiles = existsSync(API_DIR) && readdirSync(API_DIR).some((f) => f.endsWith("-openapi.json"));
  if (!hasFiles) {
    if (!existsSync(UPDATE_SCRIPT)) {
      log(`[bootstrap] No spec files and update script not found at ${UPDATE_SCRIPT} — skipping`);
      return;
    }
    log(`[bootstrap] No spec files found, running ${UPDATE_SCRIPT}…`);
    await new Promise<void>((resolve) => {
      execFile("python3", [UPDATE_SCRIPT], { cwd: PROJECT_ROOT, timeout: UPDATE_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) log(`[bootstrap] update failed: ${stderr || stdout || err.message}`);
        else log(`[bootstrap] specs downloaded successfully`);
        resolve();
      });
    });
  } else {
    log(`[bootstrap] Spec files already present, skipping download`);
  }
}

// ---------------------------------------------------------------------------
// HTTP server (for remote / Coolify deployment)
// ---------------------------------------------------------------------------

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const BODY_SIZE_LIMIT = 1024 * 1024; // 1 MB

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
  "Access-Control-Expose-Headers": "mcp-session-id, WWW-Authenticate",
};

// The OAuth surface exists only where callers bring their own credential;
// in shared-token mode there is nothing for it to hand out.
const OAUTH_ENABLED = CLIENT_TOKEN_MODE === "authorization";

// Absolute origin as the client dialled it. Traefik sets the forwarding
// headers; PUBLIC_URL overrides them when something in front rewrites Host.
function publicBaseUrl(req: IncomingMessage): string {
  if (PUBLIC_URL) return PUBLIC_URL;
  const first = (v: string | string[] | undefined) => String(v ?? "").split(",")[0].trim();
  const proto = first(req.headers["x-forwarded-proto"]) || "http";
  const host = first(req.headers["x-forwarded-host"]) || first(req.headers.host) || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

type AuthResult =
  | { ok: true; context: CallerContext }
  | { ok: false; status: number; message: string; reason: string };

// In "off" mode the Authorization header carries a shared gate token.
// In "authorization" mode it carries the caller's own upstream API token, and
// the upstream itself decides whether that token is valid.
async function authorizeRequest(req: IncomingMessage): Promise<AuthResult> {
  if (CLIENT_TOKEN_MODE !== "authorization") {
    if (!AUTH_TOKEN) return { ok: true, context: ANONYMOUS };
    if (req.headers.authorization === `Bearer ${AUTH_TOKEN}`) return { ok: true, context: ANONYMOUS };
    return {
      ok: false, status: 401, message: "Unauthorized",
      reason: `auth_header_present=${!!req.headers.authorization} auth_token_set=${!!AUTH_TOKEN}`,
    };
  }

  const presented = bearerToken(req);
  if (!presented) {
    return {
      ok: false, status: 401,
      message: OAUTH_ENABLED
        ? "Authorization required. Connect this server as an OAuth connector, or send your own API token as 'Authorization: Bearer <token>'."
        : "Send your own API token as 'Authorization: Bearer <token>' — this server has no shared token.",
      reason: "no bearer token supplied",
    };
  }

  // Two kinds of bearer are accepted. A grant token was minted by this
  // server's OAuth flow and stands for a stored upstream credential; anything
  // else is taken to be the upstream credential itself, which is how clients
  // that can set a request header have always used this server.
  let token = presented;
  let grantId: string | undefined;
  if (presented.startsWith(GRANT_PREFIX)) {
    const grant = lookupGrant(presented);
    if (!grant) {
      return {
        ok: false, status: 401,
        message: "This connection was revoked or was never issued. Reconnect the connector.",
        reason: "unknown grant token",
      };
    }
    token = grant.upstream_token;
    grantId = grant.id;
  }

  const result = await resolveIdentity(token);
  if (!result.ok) {
    // The stored credential no longer works upstream, so the grant standing
    // for it is dead too — drop it, and the 401 sends the client back through
    // the OAuth flow to paste a fresh token.
    if (grantId && result.message === REJECTED_MESSAGE) {
      revokeGrant(grantId);
      log(`[oauth] grant=${grantId} revoked — its upstream token was rejected`);
      return {
        ok: false, status: 401,
        message: "Your stored API token is no longer valid. Reconnect the connector to paste a new one.",
        reason: `grant=${grantId} upstream token rejected`,
      };
    }
    return {
      ok: false,
      status: result.message === MISCONFIGURED_MESSAGE ? 503 : 401,
      message: result.message,
      reason: `${result.reason}${tokenSuffix(token)}`,
    };
  }

  return { ok: true, context: { token, identity: result.identity } };
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (c: Buffer) => {
      totalBytes += c.length;
      if (totalBytes > BODY_SIZE_LIMIT) {
        reject(new Error(`Request body exceeds ${BODY_SIZE_LIMIT} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const SESSION_TTL_MS = 30 * 60 * 1000;

async function startHttpServer(): Promise<void> {
  // Clients and grants live beside the specs and the usage log, on the volume
  // that survives redeploys.
  if (OAUTH_ENABLED) initOAuthStore(join(API_DIR, "oauth"));

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionLastSeen = new Map<string, number>();

  setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of sessionLastSeen) {
      if (now - ts > SESSION_TTL_MS) {
        log(`[session-gc] evicting idle session id=${id}`);
        transports.delete(id);
        sessionLastSeen.delete(id);
      }
    }
  }, 10 * 60 * 1000).unref();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Apply CORS headers to every response so browsers can always read the body
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

    const url = new URL(req.url ?? "/", "http://localhost");
    log(`${req.method} ${url.pathname} — ip=${req.socket.remoteAddress} ua=${req.headers["user-agent"] ?? "-"}`);

    try {
      // CORS preflight — browsers never send auth headers in OPTIONS
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health check — no auth required, used by Coolify health probe
      if (req.method === "GET" && url.pathname === "/health") {
        const services = getServices();
        log(`health → ok, services=${services.length} [${services.join(", ")}]`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, services: services.length }));
        return;
      }

      // OAuth — discovery, registration, consent and token exchange all have
      // to answer before any credential exists, so they sit ahead of the gate.
      if (OAUTH_ENABLED) {
        const oauthCtx: OAuthContext = {
          baseUrl: publicBaseUrl(req),
          serviceName: SERVICE_LABEL,
          log,
          verifyToken: async (token: string) => {
            const result = await resolveIdentity(token);
            if (!result.ok) {
              // The stock message is written for an MCP client's error log;
              // on this page it is read by someone who has just pasted
              // something into a box and needs to know what to do next.
              return {
                ok: false as const,
                message:
                  result.message === REJECTED_MESSAGE
                    ? `${SERVICE_LABEL} did not accept that token. Copy it again — it may be incomplete, or it may have been deleted.`
                    : result.message,
              };
            }
            // A token the upstream could not confirm must not be stored: the
            // user would leave believing they had connected, and every later
            // call would fail somewhere they cannot see.
            if (!result.identity.verified) {
              return {
                ok: false as const,
                message: `Could not reach ${SERVICE_LABEL} to check that token. Try again in a moment.`,
              };
            }
            return { ok: true as const, id: result.identity.id, name: result.identity.name };
          },
        };
        if (await handleOAuth(req, res, url, oauthCtx)) return;
      }

      // Connected accounts — same ADMIN_TOKEN gate as /usage
      if (OAUTH_ENABLED && url.pathname === "/admin/grants") {
        if (!ADMIN_TOKEN) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "ADMIN_TOKEN is not set — /admin/grants is disabled" }));
          return;
        }
        if (bearerToken(req) !== ADMIN_TOKEN) {
          log(`401 /admin/grants — bad or missing admin token`);
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        if (req.method === "GET") {
          const grants = listGrants();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ grants }, null, 2));
          return;
        }
        if (req.method === "DELETE" && url.searchParams.get("all") === "1") {
          const counts = revokeAllGrants();
          log(`DELETE /admin/grants?all=1 — dropped ${counts.grants} grant(s) and ${counts.clients} client(s)`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...counts }));
          return;
        }
        if (req.method === "DELETE") {
          const id = url.searchParams.get("id") ?? "";
          const removed = revokeGrant(id);
          log(`DELETE /admin/grants id=${id} — ${removed ? "revoked" : "not found"}`);
          res.writeHead(removed ? 200 : 404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: removed, id }));
          return;
        }
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }

      // Browsers ask for this on the consent page; answering here keeps it out
      // of the auth path, where it would log a 401 on every visit.
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Usage stats — gated by ADMIN_TOKEN, never by a caller's own token
      if ((req.method === "GET" || req.method === "DELETE") && url.pathname === "/usage") {
        if (!ADMIN_TOKEN) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "ADMIN_TOKEN is not set — /usage is disabled" }));
          return;
        }
        if (bearerToken(req) !== ADMIN_TOKEN) {
          log(`401 /usage — bad or missing admin token`);
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const month = url.searchParams.get("month") ?? undefined;

        if (req.method === "DELETE") {
          if (url.searchParams.get("confirm") !== "1") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Add ?confirm=1 — this deletes usage records permanently" }));
            return;
          }
          const removed = purgeUsage(month);
          log(`DELETE /usage — removed ${removed.length} file(s): [${removed.join(", ")}]`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, removed }));
          return;
        }

        const user = url.searchParams.get("user");
        const includeTokens = url.searchParams.get("tokens") === "1";
        let records = readUsage(month);
        if (user) records = records.filter((r) => r.user === user || r.key === user || r.token === user);

        const payload = url.searchParams.get("raw")
          ? {
              records: (includeTokens ? records : stripTokens(records))
                .slice(-Number(url.searchParams.get("limit") ?? 200)),
            }
          : summarizeUsage(records, includeTokens);

        log(`GET /usage — ${records.length} record(s)${month ? ` month=${month}` : ""}${user ? ` user=${user}` : ""}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload, null, 2));
        return;
      }

      const auth = await authorizeRequest(req);
      if (!auth.ok) {
        log(`${auth.status} Unauthorized — ${auth.reason}`);
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        // RFC 9728 §5.1 — this header is what makes an OAuth-capable client
        // start the flow instead of simply reporting a failure to the user.
        if (OAUTH_ENABLED && auth.status === 401) {
          const metadata = `${publicBaseUrl(req)}/.well-known/oauth-protected-resource`;
          headers["WWW-Authenticate"] = bearerToken(req)
            ? `Bearer error="invalid_token", error_description="${auth.message.replace(/"/g, "'")}", resource_metadata="${metadata}"`
            : `Bearer resource_metadata="${metadata}"`;
        }
        res.writeHead(auth.status, headers);
        res.end(JSON.stringify({ error: auth.message }));
        return;
      }
      const callerContext = auth.context;

      if (url.pathname === "/mcp") {
        // Every tool call for this request runs inside the caller's context
        await callerStore.run(callerContext, async () => {
          if (req.method === "POST") {
            const sessionId = req.headers["mcp-session-id"] as string | undefined;
            let transport: StreamableHTTPServerTransport;

            if (sessionId && transports.has(sessionId)) {
              log(`POST /mcp — resuming session=${sessionId}`);
              transport = transports.get(sessionId)!;
              sessionLastSeen.set(sessionId, Date.now());
            } else if (!sessionId) {
              log(`POST /mcp — new session`);
              transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => {
                  log(`session initialized id=${id}`);
                  transports.set(id, transport);
                  sessionLastSeen.set(id, Date.now());
                },
              });
              transport.onclose = () => {
                log(`session closed id=${transport.sessionId}`);
                if (transport.sessionId) {
                  transports.delete(transport.sessionId);
                  sessionLastSeen.delete(transport.sessionId);
                }
              };
              await createMcpServer().connect(transport);
            } else {
              log(`400 Unknown session id=${sessionId} — active sessions: [${[...transports.keys()].join(", ")}]`);
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Unknown session ID" }));
              return;
            }

            let rawBody: string;
            try {
              rawBody = await readBody(req);
            } catch (e) {
              log(`413 Body too large or read error: ${e}`);
              res.writeHead(413, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Request body too large" }));
              return;
            }

            let parsedBody: unknown;
            try {
              parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
              const method = (parsedBody as Record<string, unknown>)?.method;
              if (method) log(`MCP method=${method} session=${sessionId ?? "new"}`);
            } catch (e) {
              log(`400 Invalid JSON body: ${e}`);
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid JSON" }));
              return;
            }

            await transport.handleRequest(req, res, parsedBody);
            return;
          }

          if (req.method === "GET") {
            const sessionId = req.headers["mcp-session-id"] as string | undefined;
            if (!sessionId || !transports.has(sessionId)) {
              log(`400 GET /mcp — missing or unknown session id=${sessionId}`);
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Valid mcp-session-id header required" }));
              return;
            }
            log(`GET /mcp — SSE stream opened session=${sessionId}`);
            sessionLastSeen.set(sessionId, Date.now());
            await transports.get(sessionId)!.handleRequest(req, res);
            return;
          }

          if (req.method === "DELETE") {
            const sessionId = req.headers["mcp-session-id"] as string | undefined;
            if (sessionId && transports.has(sessionId)) {
              log(`DELETE /mcp — closing session=${sessionId}`);
              await transports.get(sessionId)!.handleRequest(req, res);
              transports.delete(sessionId);
              sessionLastSeen.delete(sessionId);
            } else {
              log(`404 DELETE /mcp — unknown session id=${sessionId}`);
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Session not found" }));
            }
            return;
          }

          log(`405 Method Not Allowed: ${req.method} /mcp`);
          res.writeHead(405, { "Content-Type": "text/plain" });
          res.end("Method Not Allowed");
        });
        return;
      }

      log(`404 Not Found: ${req.method} ${url.pathname}`);
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    } catch (err) {
      log(`Unhandled error in request handler: ${err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
  log(`HTTP server listening on port ${PORT}`);
  if (CLIENT_TOKEN_MODE === "authorization") {
    log(`Auth: per-caller — each client sends its own upstream API token as 'Authorization: Bearer <token>'`);
    log(`      tokens are verified against ${IDENTITY_PATH} and forwarded on call_endpoint; MCP_AUTH_TOKEN is ignored`);
    log(`OAuth: enabled — browser clients connect at /oauth/authorize and paste a ${SERVICE_LABEL} token`);
    log(`       ${listGrants().length} connected account(s)`);
    if (!PUBLIC_URL) log(`       PUBLIC_URL is not set — metadata URLs come from the X-Forwarded-* headers`);
    void checkIdentityEndpoint();
  } else {
    log(`Auth: ${AUTH_TOKEN ? "enabled (MCP_AUTH_TOKEN is set)" : "DISABLED — MCP_AUTH_TOKEN not set, all requests accepted"}`);
  }
  log(`Usage log: ${USAGE_DIR}${ADMIN_TOKEN ? " — readable at GET /usage" : " — GET /usage disabled (ADMIN_TOKEN not set)"}`);
  if (LOG_TOKENS) {
    log(`           LOG_TOKENS=true — raw caller API tokens are written to the usage log and kept indefinitely`);
  }

  // Graceful shutdown — Coolify/Docker sends SIGTERM on redeploy/stop
  const shutdown = (signal: string) => {
    log(`${signal} received, shutting down gracefully`);
    httpServer.close(() => {
      log(`HTTP server closed`);
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// ---------------------------------------------------------------------------
// Entry point — stdio for local dev, HTTP when PORT is set
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.PORT) {
    await startHttpServer();
    bootstrapIfNeeded().then(() => loadAllSpecs()).catch((err) => {
      log(`[bootstrap] unexpected error: ${err}`);
    });
    if (REFRESH_INTERVAL_MIN > 0) {
      log(`[auto-refresh] scheduling spec refresh every ${REFRESH_INTERVAL_MIN} min`);
      setInterval(() => {
        log(`[auto-refresh] triggering scheduled spec refresh`);
        toolRefreshSpecs().then((r) => log(`[auto-refresh] done`, JSON.stringify(r)));
      }, REFRESH_INTERVAL_MIN * 60 * 1000);
    }
  } else {
    await bootstrapIfNeeded();
    loadAllSpecs();
    const transport = new StdioServerTransport();
    await createMcpServer().connect(transport);
  }
}

main().catch((err) => {
  log(`Server error: ${err}`);
  process.exit(1);
});
