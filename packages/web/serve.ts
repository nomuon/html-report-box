/**
 * @hrb/web dev server (Bun only — never shipped to Lambda).
 *
 * Serves the SPA via Bun HTML imports on :5173 and proxies API-shaped paths
 * (/api/*, /local-upload, /r/*) to the @hrb/api dev server on :3000 so the
 * browser stays same-origin (no CORS needed in local dev).
 */
import index from "./index.html";

const API_ORIGIN = process.env.HRB_API_ORIGIN ?? "http://localhost:3000";
const PORT = Number(process.env.HRB_WEB_PORT ?? process.env.PORT ?? 5173);

async function proxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = new URL(url.pathname + url.search, API_ORIGIN);
  const headers = new Headers(req.headers);
  headers.delete("host");
  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }
  try {
    return await fetch(target, init);
  } catch {
    return new Response(
      JSON.stringify({ error: { code: "internal", message: `API server unreachable at ${API_ORIGIN}` } }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}

const server = Bun.serve({
  port: PORT,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/api/*": proxy,
    "/local-upload": proxy,
    "/r/*": proxy,
    "/*": index,
  },
});

console.log(`[web] http://localhost:${server.port} (proxying /api, /local-upload, /r/* -> ${API_ORIGIN})`);
