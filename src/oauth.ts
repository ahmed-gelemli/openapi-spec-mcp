// ---------------------------------------------------------------------------
// OAuth 2.1 authorization server (for browser-based MCP clients)
// ---------------------------------------------------------------------------
//
// claude.ai's custom-connector UI takes a URL and nothing else — there is no
// field for a request header, so the per-caller token scheme that works in
// Claude Code cannot be configured there. The MCP authorization spec is the
// only way in, and it requires the server to speak OAuth.
//
// The upstream (Canvas) publishes an OAuth2 provider of its own, but using it
// needs a developer key that only a Canvas admin can issue. So this server is
// the authorization server instead, and the "login" step it presents is a page
// asking the user to paste the access token they generated in Canvas. The
// client never learns that token: it receives an opaque grant token minted
// here, which the MCP layer exchanges back into the upstream credential on
// every request.
//
// What that buys, in spec terms: this file implements RFC 9728 (protected
// resource metadata), RFC 8414 (authorization server metadata), RFC 7591
// (dynamic client registration, which is how claude.ai registers itself), and
// the authorization-code grant with PKCE. Clients are public — no secrets are
// issued, and PKCE is mandatory.

import { randomBytes, createHash, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { IncomingMessage, ServerResponse } from "http";
import { join } from "path";

// Grant tokens are recognisable on sight so the MCP auth path can tell them
// apart from a raw upstream token pasted into a Claude Code --header.
export const GRANT_PREFIX = "mcp_";

const AUTH_REQUEST_TTL_MS = 15 * 60 * 1000;
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

export type OAuthClient = {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created: string;
};

export type Grant = {
  id: string;              // sha256(access_token)[:12] — safe to log and to name in admin calls
  access_token: string;    // what the MCP client sends us
  upstream_token: string;  // the credential it stands for
  client_id: string;
  client_name?: string;
  user?: string;           // upstream account id, resolved at consent time
  name?: string;
  created: string;
  last_used?: string;
};

type AuthRequest = {
  client_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  resource?: string;
  scope?: string;
  created: number;
};

type AuthCode = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  upstream_token: string;
  user?: string;
  name?: string;
  created: number;
};

export type VerifyResult =
  | { ok: true; id?: string; name?: string }
  | { ok: false; message: string };

export type OAuthContext = {
  // Public origin of this server, e.g. https://mcp.example.com — every URL in
  // the metadata documents has to be absolute and has to match what the client
  // dialled, or issuer validation fails.
  baseUrl: string;
  // Resolves a pasted upstream token to an account, or explains why it cannot.
  verifyToken: (token: string) => Promise<VerifyResult>;
  // Shown on the consent page: "Connect your Canvas account".
  serviceName: string;
  log: (msg: string) => void;
};

// ---------------------------------------------------------------------------
// State — clients and grants persist, in-flight authorizations do not
// ---------------------------------------------------------------------------

// Both survive redeploys: autoDeploy fires on every push to main, and signing
// everyone out because a spec-updater comment changed would be absurd.
let storePath = "";
let clients = new Map<string, OAuthClient>();
let grants = new Map<string, Grant>();

// Deliberately in memory only. Both are minutes-lived, and losing them mid-flow
// costs the user one click on "Connect" again.
const authRequests = new Map<string, AuthRequest>();
const authCodes = new Map<string, AuthCode>();

export function initOAuthStore(dir: string): void {
  storePath = join(dir, "oauth.json");
  if (!existsSync(storePath)) return;
  try {
    const raw = JSON.parse(readFileSync(storePath, "utf-8")) as {
      clients?: OAuthClient[];
      grants?: Grant[];
    };
    clients = new Map((raw.clients ?? []).map((c) => [c.client_id, c]));
    grants = new Map((raw.grants ?? []).map((g) => [g.access_token, g]));
  } catch {
    // A corrupt store must not stop the server from booting; connected clients
    // re-authorize, which is the same cost as a first connect.
    clients = new Map();
    grants = new Map();
  }
}

function persist(): void {
  if (!storePath) return;
  const payload = JSON.stringify(
    { clients: [...clients.values()], grants: [...grants.values()] },
    null,
    2,
  );
  const tmp = `${storePath}.tmp`;
  mkdirSync(join(storePath, ".."), { recursive: true });
  writeFileSync(tmp, payload);
  renameSync(tmp, storePath);
}

function sweep(): void {
  const now = Date.now();
  for (const [id, r] of authRequests) if (now - r.created > AUTH_REQUEST_TTL_MS) authRequests.delete(id);
  for (const [code, c] of authCodes) if (now - c.created > AUTH_CODE_TTL_MS) authCodes.delete(code);
}

// Looked up on every MCP request, so it stays cheap: a Map hit plus a dated
// write at most once a minute.
export function lookupGrant(accessToken: string): Grant | undefined {
  const grant = grants.get(accessToken);
  if (!grant) return undefined;
  const now = new Date().toISOString();
  if (!grant.last_used || now.slice(0, 16) !== grant.last_used.slice(0, 16)) {
    grant.last_used = now;
    persist();
  }
  return grant;
}

export function listGrants(): Omit<Grant, "access_token" | "upstream_token">[] {
  return [...grants.values()].map(({ access_token: _a, upstream_token: _u, ...rest }) => rest);
}

// Accepts the short id from listGrants(), so revoking never requires handling
// the live token itself.
export function revokeGrant(id: string): boolean {
  for (const [token, grant] of grants) {
    if (grant.id === id) {
      grants.delete(token);
      persist();
      return true;
    }
  }
  return false;
}

// Drops every grant and every registered client: the server is back to the
// state it shipped in, and every connected client has to run the flow again.
export function revokeAllGrants(): { grants: number; clients: number } {
  const counts = { grants: grants.size, clients: clients.size };
  grants.clear();
  clients.clear();
  persist();
  return counts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

function shortId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function verifyPkce(verifier: string, challenge: string): boolean {
  const expected = base64url(createHash("sha256").update(verifier).digest());
  const a = Buffer.from(expected);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > limit) {
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body, null, 2));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

// An invalid client_id or redirect_uri must never be redirected to — that is
// the open-redirect hole the spec warns about — so those errors render here.
function errorPage(res: ServerResponse, status: number, title: string, detail: string): void {
  html(
    res,
    status,
    page(`
      <h1>${escapeHtml(title)}</h1>
      <p class="muted">${escapeHtml(detail)}</p>
    `),
  );
}

// ---------------------------------------------------------------------------
// Consent page
// ---------------------------------------------------------------------------

function page(main: string, mainClass = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect your account</title>
<style>
  :root {
    --bg: #ffffff; --fg: #1a1a19; --muted: #6b6b68; --line: #e3e2de;
    --field: #ffffff; --accent: #c8613a; --accent-fg: #ffffff;
    --warn-bg: #fdf2ee; --warn-fg: #8f3a17;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #191917; --fg: #f2f1ee; --muted: #9a9893; --line: #33322e;
      --field: #201f1d; --accent: #d97757; --accent-fg: #1a1a19;
      --warn-bg: #2c1c15; --warn-fg: #eba98c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem; background: var(--bg); color: var(--fg);
    font: 16px/1.55 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 34rem; margin: 0 auto; }
  main.solo { max-width: 24rem; min-height: calc(100vh - 5rem); display: flex; flex-direction: column; justify-content: center; }
  h1 { font-size: 1.4rem; line-height: 1.25; margin: 0 0 .4rem; letter-spacing: -.01em; }
  p { margin: 0 0 1rem; }
  .muted { color: var(--muted); font-size: .925rem; }
  ol { margin: 0 0 1.5rem; padding-left: 1.2rem; color: var(--muted); font-size: .925rem; }
  li { margin-bottom: .35rem; }
  li strong { color: var(--fg); font-weight: 600; }
  a { color: var(--accent); }
  label { display: block; font-size: .85rem; font-weight: 600; margin-bottom: .4rem; }
  input[type=password], input[type=text] {
    width: 100%; padding: .7rem .8rem; font: inherit; font-size: .95rem;
    color: var(--fg); background: var(--field);
    border: 1px solid var(--line); border-radius: 8px;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
  button {
    margin-top: 1rem; width: 100%; padding: .7rem 1rem; font: inherit; font-weight: 600;
    color: var(--accent-fg); background: var(--accent);
    border: 0; border-radius: 8px; cursor: pointer;
  }
  button:hover { filter: brightness(1.06); }
  .card { border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem; }
  .error {
    background: var(--warn-bg); color: var(--warn-fg); border-radius: 8px;
    padding: .7rem .85rem; font-size: .9rem; margin-bottom: 1.1rem;
  }
  .foot { margin-top: 1.5rem; font-size: .8rem; color: var(--muted); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
</style>
</head>
<body><main${mainClass ? ` class="${mainClass}"` : ""}>
${main}
</main></body>
</html>`;
}

// Deliberately wordless: a field and a button, nothing to read. The only text
// that ever appears is the failure message — without it a mistyped token is a
// dead end with no way to tell.
function consentPage(requestId: string, error?: string): string {
  return page(`
  <form method="POST" action="/oauth/authorize" autocomplete="off">
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
    <input id="token" name="token" type="password" required autofocus
           spellcheck="false" autocapitalize="off" autocomplete="new-password"
           aria-label="Access token">
    <button type="submit">Connect</button>
  </form>
  `, "solo");
}

// ---------------------------------------------------------------------------
// Metadata documents
// ---------------------------------------------------------------------------

// RFC 9728. The 401 on /mcp points here, and this points at the authorization
// server — which happens to be the same origin.
function protectedResourceMetadata(ctx: OAuthContext): unknown {
  return {
    resource: `${ctx.baseUrl}/mcp`,
    authorization_servers: [ctx.baseUrl],
    bearer_methods_supported: ["header"],
    resource_documentation: `${ctx.baseUrl}/health`,
  };
}

// RFC 8414. token_endpoint_auth_methods_supported is "none" because every
// client here is public: claude.ai runs the flow in a browser, so a secret
// would be a secret in a user agent.
function authorizationServerMetadata(ctx: OAuthContext): unknown {
  return {
    issuer: ctx.baseUrl,
    authorization_endpoint: `${ctx.baseUrl}/oauth/authorize`,
    token_endpoint: `${ctx.baseUrl}/oauth/token`,
    registration_endpoint: `${ctx.baseUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// Returns true when the request belonged to the OAuth surface and has been
// answered; false lets the caller carry on with its own routing.
export async function handleOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: OAuthContext,
): Promise<boolean> {
  const path = url.pathname.replace(/\/$/, "") || "/";

  // Clients may probe either the bare well-known or one suffixed with the
  // resource path (/.well-known/oauth-protected-resource/mcp). Both are the
  // same document here, since this server exposes exactly one resource.
  if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
    json(res, 200, protectedResourceMetadata(ctx));
    return true;
  }
  if (
    req.method === "GET" &&
    (path.startsWith("/.well-known/oauth-authorization-server") ||
      path.startsWith("/.well-known/openid-configuration"))
  ) {
    json(res, 200, authorizationServerMetadata(ctx));
    return true;
  }

  if (path === "/oauth/register" && req.method === "POST") return handleRegister(req, res, ctx);
  if (path === "/oauth/authorize" && req.method === "GET") return handleAuthorizeGet(res, url, ctx);
  if (path === "/oauth/authorize" && req.method === "POST") return handleAuthorizePost(req, res, ctx);
  if (path === "/oauth/token" && req.method === "POST") return handleToken(req, res, ctx);

  return false;
}

// RFC 7591 dynamic client registration. Open registration: anyone may register
// a client, which is what the spec expects of an MCP server, and registering
// alone grants nothing — the user still has to paste a token on the consent
// page before that client can do anything.
async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OAuthContext,
): Promise<boolean> {
  sweep();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    json(res, 400, { error: "invalid_client_metadata", error_description: "Body must be JSON" });
    return true;
  }

  const redirectUris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as unknown[]) : [];
  const uris = redirectUris.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
  if (uris.length === 0) {
    json(res, 400, {
      error: "invalid_redirect_uri",
      error_description: "At least one http(s) redirect_uri is required",
    });
    return true;
  }

  const client: OAuthClient = {
    client_id: randomToken(16),
    client_name: typeof body.client_name === "string" ? body.client_name : undefined,
    redirect_uris: uris,
    created: new Date().toISOString(),
  };
  clients.set(client.client_id, client);
  persist();
  ctx.log(`[oauth] registered client ${client.client_id} (${client.client_name ?? "unnamed"}) → ${uris.join(", ")}`);

  json(res, 201, {
    client_id: client.client_id,
    client_id_issued_at: Math.floor(Date.parse(client.created) / 1000),
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  return true;
}

function handleAuthorizeGet(res: ServerResponse, url: URL, ctx: OAuthContext): boolean {
  sweep();
  const q = url.searchParams;
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";

  const client = clients.get(clientId);
  if (!client) {
    errorPage(res, 400, "Unknown application", "This application is not registered with this server.");
    return true;
  }
  // Exact match, per OAuth 2.1 — no prefix or wildcard matching.
  if (!client.redirect_uris.includes(redirectUri)) {
    errorPage(res, 400, "Invalid redirect", "The redirect address does not match the one this application registered.");
    return true;
  }

  const state = q.get("state") ?? undefined;
  const fail = (error: string, description: string) => {
    const target = new URL(redirectUri);
    target.searchParams.set("error", error);
    target.searchParams.set("error_description", description);
    if (state) target.searchParams.set("state", state);
    target.searchParams.set("iss", ctx.baseUrl);
    res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
    res.end();
  };

  if (q.get("response_type") !== "code") {
    fail("unsupported_response_type", "Only the authorization code flow is supported");
    return true;
  }
  const challenge = q.get("code_challenge");
  if (!challenge || q.get("code_challenge_method") !== "S256") {
    fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    return true;
  }

  const requestId = randomToken(18);
  authRequests.set(requestId, {
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    resource: q.get("resource") ?? undefined,
    scope: q.get("scope") ?? undefined,
    created: Date.now(),
  });

  ctx.log(`[oauth] authorize request=${requestId} client=${clientId} (${client.client_name ?? "unnamed"})`);
  html(
    res,
    200,
    consentPage(requestId),
  );
  return true;
}

// The consent form carries only the opaque request id — every parameter that
// matters (redirect_uri above all) stays server-side, so a tampered form
// cannot redirect the resulting code somewhere else.
async function handleAuthorizePost(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OAuthContext,
): Promise<boolean> {
  sweep();
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await readBody(req));
  } catch {
    errorPage(res, 400, "Bad request", "The form submission could not be read.");
    return true;
  }

  const requestId = form.get("request_id") ?? "";
  const request = authRequests.get(requestId);
  if (!request) {
    errorPage(res, 400, "This page expired", "Go back to the application and start the connection again.");
    return true;
  }
  const token = (form.get("token") ?? "").trim();
  const reject = (message: string) =>
    html(
      res,
      400,
      consentPage(requestId, message),
    );

  if (!token) {
    reject("Paste an access token to continue.");
    return true;
  }

  const verified = await ctx.verifyToken(token);
  if (!verified.ok) {
    ctx.log(`[oauth] consent rejected for request=${requestId}: ${verified.message}`);
    reject(verified.message);
    return true;
  }

  const code = randomToken(24);
  authCodes.set(code, {
    client_id: request.client_id,
    redirect_uri: request.redirect_uri,
    code_challenge: request.code_challenge,
    upstream_token: token,
    user: verified.id,
    name: verified.name,
    created: Date.now(),
  });
  authRequests.delete(requestId);

  ctx.log(
    `[oauth] consent granted request=${requestId} user=${verified.id ?? "?"} (${verified.name ?? "unnamed"})`,
  );

  const target = new URL(request.redirect_uri);
  target.searchParams.set("code", code);
  if (request.state) target.searchParams.set("state", request.state);
  target.searchParams.set("iss", ctx.baseUrl);
  res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
  res.end();
  return true;
}

async function handleToken(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OAuthContext,
): Promise<boolean> {
  sweep();
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid_request", error_description: "Body could not be read" });
    return true;
  }

  if (form.get("grant_type") !== "authorization_code") {
    json(res, 400, {
      error: "unsupported_grant_type",
      error_description: "Only authorization_code is supported",
    });
    return true;
  }

  const code = form.get("code") ?? "";
  const entry = authCodes.get(code);
  // Single use, whatever happens next.
  authCodes.delete(code);
  if (!entry || Date.now() - entry.created > AUTH_CODE_TTL_MS) {
    json(res, 400, { error: "invalid_grant", error_description: "Authorization code is invalid or expired" });
    return true;
  }
  if (form.get("client_id") !== entry.client_id) {
    json(res, 400, { error: "invalid_grant", error_description: "client_id does not match the code" });
    return true;
  }
  const redirectUri = form.get("redirect_uri");
  if (redirectUri && redirectUri !== entry.redirect_uri) {
    json(res, 400, { error: "invalid_grant", error_description: "redirect_uri does not match the code" });
    return true;
  }
  const verifier = form.get("code_verifier") ?? "";
  if (!verifier || !verifyPkce(verifier, entry.code_challenge)) {
    json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
    return true;
  }

  const accessToken = `${GRANT_PREFIX}${randomToken(32)}`;
  const grant: Grant = {
    id: shortId(accessToken),
    access_token: accessToken,
    upstream_token: entry.upstream_token,
    client_id: entry.client_id,
    client_name: clients.get(entry.client_id)?.client_name,
    user: entry.user,
    name: entry.name,
    created: new Date().toISOString(),
  };
  grants.set(accessToken, grant);
  persist();
  ctx.log(`[oauth] issued grant=${grant.id} user=${grant.user ?? "?"} client=${grant.client_id}`);

  // No expires_in: the upstream token behind it does not expire unless the
  // user set an expiry, and a lifetime we invented would just log people out
  // for no reason. Revocation is by deleting the grant or the upstream token.
  json(res, 200, { access_token: accessToken, token_type: "Bearer" });
  return true;
}
