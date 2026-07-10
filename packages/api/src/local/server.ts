/**
 * Local dev server (Bun-only) — `bun --hot packages/api/src/local/server.ts`.
 *
 *   /api/*         → Hono app (createLocalContext, dataDir=.local-data)
 *   /local-upload  → dev replacement for the S3 presigned POST target
 *   /r/*           → published content from LocalObjectStorage
 *   /mcp           → @hrb/mcp Streamable HTTP server (stateless, no API key)
 *   everything else→ SPA (packages/web/index.html via Bun HTML import,
 *                    placeholder page until @hrb/web exists)
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { MAX_ZIP_SIZE_BYTES } from "@hrb/shared";
import { contentTypeForPath, isDomainError } from "@hrb/core";
import { createLocalContext, StubDomainReputation } from "@hrb/core/local";
import { createScanner, createZipExtractor } from "@hrb/scanner";
import { createMcpApp } from "@hrb/mcp";
import { createApp } from "../app.ts";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.HRB_DATA_DIR ?? ".local-data";
const BASE_URL = `http://localhost:${PORT}`;

const ctx = createLocalContext({
  dataDir: DATA_DIR,
  contentBaseUrl: BASE_URL,
  scanner: createScanner({ domainReputation: new StubDomainReputation() }),
  zipExtractor: createZipExtractor(),
});
const app = createApp({
  service: ctx.service,
  auth: ctx.auth,
  userAdmin: ctx.userAdmin,
  contentBaseUrl: BASE_URL,
});

// ---- CORS (so a separate web dev server, e.g. :5173, can call /api) ----

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type, x-dev-user",
  "access-control-max-age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function handleApi(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  return withCors(await app.fetch(req));
}

// ---- /mcp: remote MCP server (stateless Streamable HTTP; no API key in dev) ----

const MCP_CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "access-control-allow-headers":
    "content-type, authorization, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "mcp-session-id",
};

const mcpRoot = new Hono();
mcpRoot.route("/mcp", createMcpApp({ reportService: ctx.service, objectStorage: ctx.storage }));

async function handleMcp(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
  }
  const res = await mcpRoot.fetch(req);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(MCP_CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// ---- /local-upload: dev stand-in for the S3 presigned POST ----

function uploadError(status: number, message: string): Response {
  return withCors(Response.json({ error: { code: "bad_request", message } }, { status }));
}

async function handleLocalUpload(req: Request): Promise<Response> {
  let form: Awaited<ReturnType<Request["formData"]>>;
  try {
    form = await req.formData();
  } catch {
    return uploadError(400, "expected multipart/form-data with key + file fields");
  }
  const key = form.get("key");
  const file = form.get("file");
  if (typeof key !== "string" || key.length === 0) {
    return uploadError(400, "missing form field: key");
  }
  if (!(file instanceof Blob)) {
    return uploadError(400, "missing form field: file");
  }
  if (file.size > MAX_ZIP_SIZE_BYTES) {
    return uploadError(413, `file exceeds ${MAX_ZIP_SIZE_BYTES} bytes`);
  }
  try {
    await ctx.storage.putStagingObject(key, new Uint8Array(await file.arrayBuffer()));
  } catch (err) {
    if (isDomainError(err)) return uploadError(err.httpStatus, err.message);
    throw err;
  }
  // S3 presigned POST returns 204 No Content on success.
  return withCors(new Response(null, { status: 204 }));
}

// ---- /r/*: serve published content like the content CloudFront would ----

async function handleContent(req: Request): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  const url = new URL(req.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("not found", { status: 404 });
  }
  const rest = pathname.replace(/^\/r\//, "");
  const slash = rest.indexOf("/");
  if (rest.length === 0) return new Response("not found", { status: 404 });
  if (slash === -1) {
    // /r/<id> → /r/<id>/ so relative asset URLs resolve.
    return Response.redirect(`${BASE_URL}/r/${rest}/`, 301);
  }
  const id = rest.slice(0, slash);
  let path = rest.slice(slash + 1);
  if (path === "" || path.endsWith("/")) path += "index.html";
  const segments = path.split("/");
  // Dotfiles (e.g. the internal .extracted.txt) and empty/traversal segments are never served.
  if (id.startsWith(".") || segments.some((s) => s === "" || s.startsWith("."))) {
    return new Response("not found", { status: 404 });
  }
  let data: Uint8Array | null;
  try {
    data = await ctx.storage.getContentObject(`reports/${id}/${path}`);
  } catch {
    data = null;
  }
  if (!data) return new Response("not found", { status: 404 });
  return new Response(req.method === "HEAD" ? null : (data as Uint8Array<ArrayBuffer>), {
    headers: {
      "content-type": contentTypeForPath(path),
      "content-length": String(data.byteLength),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
    },
  });
}

// ---- SPA: packages/web/index.html when it exists, placeholder otherwise ----

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>HTML Report Box (dev)</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto; line-height: 1.6;">
  <h1>HTML Report Box — dev server</h1>
  <p><code>packages/web/index.html</code> is not present yet (built in S4), so this
  placeholder is served instead. The API is fully functional:</p>
  <ul>
    <li><code>GET /api/config</code> — client bootstrap config</li>
    <li><code>GET /api/reports</code> / <code>GET /api/search?q=…</code></li>
    <li><code>x-dev-user: alice|bob|admin</code> header selects the dev user</li>
    <li>published reports are served under <code>/r/&lt;id&gt;/</code></li>
  </ul>
</body>
</html>`;

const webIndexPath = fileURLToPath(new URL("../../../web/index.html", import.meta.url));

async function loadSpaRoute(): Promise<unknown> {
  if (!existsSync(webIndexPath)) return null;
  try {
    return (await import(webIndexPath)).default;
  } catch (err) {
    console.warn("[dev] failed to load packages/web/index.html, serving placeholder:", err);
    return null;
  }
}

const spa = await loadSpaRoute();
const placeholder = () =>
  new Response(PLACEHOLDER_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const routes: Record<string, any> = {
  "/api/*": handleApi,
  "/mcp": handleMcp,
  "/local-upload": { POST: handleLocalUpload, OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }) },
  "/r/*": handleContent,
  "/*": spa ?? placeholder,
};

const server = Bun.serve({
  port: PORT,
  development: true,
  routes,
});

console.log(`[dev] HTML Report Box api on ${server.url}`);
console.log(`[dev]   data dir : ${DATA_DIR}`);
console.log(`[dev]   spa      : ${spa ? webIndexPath : "placeholder (packages/web/index.html missing)"}`);
console.log(`[dev]   dev users: x-dev-user: alice | bob | admin`);
console.log(`[dev]   scanner  : @hrb/scanner (StubDomainReputation) + yauzl zip extractor`);
console.log(`[dev]   mcp      : POST ${BASE_URL}/mcp (no API key in dev)`);
