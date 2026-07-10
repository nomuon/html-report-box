/**
 * @hrb/mcp — remote MCP server (Streamable HTTP), stateless mode.
 *
 * createMcpApp(ctx) returns a Hono app that handles MCP requests on "/"
 * (mounted at /mcp by the api dev server / API Gateway route). A fresh
 * McpServer + transport pair is created per request — no session state, so
 * the same code runs on Lambda and locally.
 *
 * Portable (Node 22); no Bun-only APIs.
 */
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import { buildMcpServer } from "./server.ts";
import type { McpContext } from "./server.ts";

export const PACKAGE_NAME = "@hrb/mcp";

export { buildMcpServer, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./server.ts";
export type { McpContext } from "./server.ts";

/**
 * Hono app processing MCP Streamable HTTP requests at "/".
 * POST carries JSON-RPC; GET/DELETE return 405 (no SSE stream / session
 * in stateless mode).
 */
export function createMcpApp(ctx: McpContext): Hono {
  const app = new Hono();
  // Stateless mode: no server-push SSE stream and no session to terminate,
  // so GET/DELETE are 405 per the Streamable HTTP spec.
  app.on(["GET", "DELETE"], "/", (c) =>
    c.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method Not Allowed" }, id: null },
      405,
      { Allow: "POST" },
    ),
  );
  app.post("/", async (c) => {
    const server = buildMcpServer(ctx);
    const transport = new StreamableHTTPTransport({
      // Stateless: no session ids, request-scoped server instances.
      sessionIdGenerator: undefined,
      // Plain JSON responses instead of SSE — simpler for Lambda and tests.
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const res = await transport.handleRequest(c);
    return res ?? c.body(null, 202);
  });
  return app;
}

/**
 * Static API-key check ("Authorization: Bearer <key>").
 * When `apiKey` is undefined/empty the check is skipped (local mode; in AWS
 * the key comes from SSM via the MCP_API_KEY environment variable).
 */
export function bearerApiKeyAuth(apiKey: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    if (!apiKey) return next();
    const given = Buffer.from(c.req.header("authorization") ?? "", "utf8");
    const expected = Buffer.from(`Bearer ${apiKey}`, "utf8");
    const ok = given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) {
      return c.json({ error: { code: "unauthorized", message: "invalid or missing API key" } }, 401);
    }
    return next();
  };
}
