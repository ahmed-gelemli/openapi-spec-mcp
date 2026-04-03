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
import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// build/ is one level below the project root
const PROJECT_ROOT = join(__dirname, "..");
const API_DIR = join(PROJECT_ROOT, "api");
const UPDATE_SCRIPT = join(PROJECT_ROOT, "update_specs.py");

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string, ...args: unknown[]) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ${msg}`, ...args);
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
  if (schema.type === "array" && schema.items && typeof schema.items === "object") {
    return { ...schema, items: inlineSchema(spec, schema.items as Record<string, unknown>, depth + 1, maxDepth) };
  }
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties as Record<string, unknown>)) {
      props[k] = inlineSchema(spec, v as Record<string, unknown>, depth + 1, maxDepth);
    }
    return { ...schema, properties: props };
  }
  return schema;
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

  // Build URL: GATEWAY_URL/service/path
  const base = gatewayUrl.replace(/\/$/, "");
  let url = `${base}/${service}${resolvedPath}`;

  if (queryParams && Object.keys(queryParams).length > 0) {
    url += `?${new URLSearchParams(queryParams).toString()}`;
  }

  const requestHeaders: Record<string, string> = { ...headers };
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
    specCache.clear();

    if (!existsSync(UPDATE_SCRIPT)) {
      resolve({ success: false, errors: `Update script not found at ${UPDATE_SCRIPT}` });
      return;
    }

    mkdirSync(API_DIR, { recursive: true });

    execFile("python3", [UPDATE_SCRIPT], { cwd: PROJECT_ROOT, timeout: 120_000 }, (err, stdout, stderr) => {
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
          "Call an API endpoint on the gateway. Uses GATEWAY_URL as the base. Pass Authorization and other credentials via headers.",
        inputSchema: {
          type: "object",
          properties: {
            service: { type: "string", description: "Service name (from list_services)" },
            path: { type: "string", description: "API path e.g. /patients/{id}" },
            method: { type: "string", description: "HTTP method: get, post, put, patch, delete" },
            path_params: {
              type: "object",
              description: "Path parameter values e.g. {\"id\": \"123\"}",
              additionalProperties: { type: "string" },
            },
            query_params: {
              type: "object",
              description: "Query string parameters",
              additionalProperties: { type: "string" },
            },
            body: { description: "JSON request body" },
            headers: {
              type: "object",
              description: "Request headers e.g. {\"Authorization\": \"Bearer token\"}",
              additionalProperties: { type: "string" },
            },
            timeout_ms: {
              type: "number",
              description: "Request timeout in milliseconds (default: 30000)",
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

      return { content: [{ type: "text", text }] };
    } catch (e) {
      // Re-throw MCP protocol errors (unknown tool, etc.) — SDK handles these
      if (e instanceof McpError) throw e;
      // User-facing tool errors: report via isError so the LLM sees the failure
      const message = e instanceof Error ? e.message : String(e);
      log(`Tool '${name}' error: ${message}`);
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
    log(`[bootstrap] No spec files found, running update_specs.py…`);
    await new Promise<void>((resolve) => {
      execFile("python3", [UPDATE_SCRIPT], { cwd: PROJECT_ROOT, timeout: 120_000 }, (err, stdout, stderr) => {
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
  "Access-Control-Expose-Headers": "mcp-session-id",
};

function isAuthorized(req: IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true;
  return req.headers.authorization === `Bearer ${AUTH_TOKEN}`;
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

async function startHttpServer(): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

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

      if (!isAuthorized(req)) {
        const authHeader = req.headers.authorization;
        log(`401 Unauthorized — auth_header_present=${!!authHeader} auth_token_set=${!!AUTH_TOKEN}`);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      if (url.pathname === "/mcp") {
        if (req.method === "POST") {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          let transport: StreamableHTTPServerTransport;

          if (sessionId && transports.has(sessionId)) {
            log(`POST /mcp — resuming session=${sessionId}`);
            transport = transports.get(sessionId)!;
          } else if (!sessionId) {
            log(`POST /mcp — new session`);
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (id) => {
                log(`session initialized id=${id}`);
                transports.set(id, transport);
              },
            });
            transport.onclose = () => {
              log(`session closed id=${transport.sessionId}`);
              if (transport.sessionId) transports.delete(transport.sessionId);
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
          await transports.get(sessionId)!.handleRequest(req, res);
          return;
        }

        if (req.method === "DELETE") {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          if (sessionId && transports.has(sessionId)) {
            log(`DELETE /mcp — closing session=${sessionId}`);
            await transports.get(sessionId)!.handleRequest(req, res);
            transports.delete(sessionId);
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
  log(`Auth: ${AUTH_TOKEN ? "enabled (MCP_AUTH_TOKEN is set)" : "DISABLED — MCP_AUTH_TOKEN not set, all requests accepted"}`);

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
    setInterval(() => {
      log(`[auto-refresh] triggering scheduled spec refresh`);
      toolRefreshSpecs().then((r) => log(`[auto-refresh] done`, JSON.stringify(r)));
    }, 45 * 60 * 1000);
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
