#!/usr/bin/env node
import "dotenv/config";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
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
// Tool implementations
// ---------------------------------------------------------------------------

function toolListServices(): string[] {
  const services = getServices();
  if (services.length === 0) {
    return ["No spec files found. Run refresh_specs to download them."] as string[];
  }
  return services;
}

function toolGetServiceInfo(service: string): unknown {
  const spec = loadSpec(service);
  if (!spec) return { error: `Service '${service}' not found. Available: ${getServices().join(", ")}` };

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
  const spec = loadSpec(service);
  if (!spec) return { error: `Service '${service}' not found. Available: ${getServices().join(", ")}` };

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
  const spec = loadSpec(service);
  if (!spec) return { error: `Service '${service}' not found` };

  const paths = getPaths(spec);
  const pathItem = paths[path];
  if (!pathItem) return { error: `Path '${path}' not found in service '${service}'` };

  const op = pathItem[method.toLowerCase()] as Record<string, unknown> | undefined;
  if (!op) return { error: `Method '${method}' not found for '${path}'` };

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
  const spec = loadSpec(service);
  if (!spec) return { error: `Service '${service}' not found` };
  return Object.keys(getSchemas(spec)).sort();
}

function toolGetSchema(service: string, schemaName: string): unknown {
  const spec = loadSpec(service);
  if (!spec) return { error: `Service '${service}' not found` };

  const schemas = getSchemas(spec);
  let name = schemaName;
  if (!(name in schemas)) {
    // Case-insensitive fallback
    const match = Object.keys(schemas).find((k) => k.toLowerCase() === schemaName.toLowerCase());
    if (!match) return { error: `Schema '${schemaName}' not found in service '${service}'` };
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

function toolRefreshSpecs(): Promise<unknown> {
  return new Promise((resolve) => {
    // Clear cache so refreshed files are reloaded
    specCache.clear();

    if (!existsSync(UPDATE_SCRIPT)) {
      resolve({ error: `Update script not found at ${UPDATE_SCRIPT}` });
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
          service: { type: "string" },
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
          service: { type: "string" },
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
          service: { type: "string" },
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
          service: { type: "string" },
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
          query: { type: "string" },
          service: { type: "string", description: "Optional: restrict to one service" },
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const a = args as Record<string, string | undefined>;

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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
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

function isAuthorized(req: IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true;
  return req.headers.authorization === `Bearer ${AUTH_TOKEN}`;
}

function log(msg: string, ...args: unknown[]) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ${msg}`, ...args);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function startHttpServer(): Promise<void> {
  // One transport per session; keyed by session ID.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
  };

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    log(`${req.method} ${url.pathname} — ip=${req.socket.remoteAddress} ua=${req.headers["user-agent"] ?? "-"}`);

    // CORS preflight — must respond before auth check, browsers never send auth here
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // Health check (no auth required — used by Coolify health probe)
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
      res.writeHead(401, { ...CORS_HEADERS, "Content-Type": "application/json" });
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
          // New session — fresh Server instance per connection
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

        const rawBody = await readBody(req);
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
          res.writeHead(404);
          res.end("Session not found");
        }
        return;
      }

      log(`405 Method Not Allowed: ${req.method} /mcp`);
      res.writeHead(405);
      res.end("Method Not Allowed");
      return;
    }

    log(`404 Not Found: ${req.method} ${url.pathname}`);
    res.writeHead(404);
    res.end("Not Found");
  });

  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
  log(`HTTP server listening on port ${PORT}`);
  log(`Auth: ${AUTH_TOKEN ? "enabled (MCP_AUTH_TOKEN is set)" : "DISABLED — MCP_AUTH_TOKEN not set, all requests accepted"}`);
}

// ---------------------------------------------------------------------------
// Entry point — stdio for local dev, HTTP when PORT is set
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.PORT) {
    // Start HTTP server immediately so the health check passes,
    // then bootstrap and load specs in the background.
    await startHttpServer();
    bootstrapIfNeeded().then(() => loadAllSpecs()).catch((err) => {
      console.error("[bootstrap] unexpected error:", err);
    });
  } else {
    await bootstrapIfNeeded();
    loadAllSpecs();
    const transport = new StdioServerTransport();
    await createMcpServer().connect(transport);
  }
}

main().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
