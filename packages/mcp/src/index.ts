/**
 * @hrb/mcp — remote MCP server (Streamable HTTP), stateless mode.
 *
 * createMcpApp(ctx, options) returns a Hono app that handles MCP requests on
 * "/" (mounted at /mcp by the api dev server / API Gateway route). A fresh
 * McpServer + transport pair is created per request — no session state, so
 * the same code runs on Lambda and locally.
 *
 * Auth (resolved per request from "Authorization: Bearer <token>"):
 *   - "hrb_..." per-user API key → verified via ApiKeyStore; the caller acts
 *     as that user (write tools enabled, own private reports readable)
 *   - static key (options.staticApiKey) → anonymous read-only (従来どおり)
 *   - no key configured (dev) → anonymous read-only
 *
 * Portable (Node 22); no Bun-only APIs.
 */
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import { looksLikeApiKey } from "@hrb/core";
import type { AuthUser } from "@hrb/core";
import { buildMcpServer } from "./server.ts";
import type { McpContext } from "./server.ts";

export const PACKAGE_NAME = "@hrb/mcp";

export { buildMcpServer, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./server.ts";
export type { McpAuth, McpContext } from "./server.ts";

export interface McpAppOptions {
  /**
   * Static API key (vps: HRB 環境変数 MCP_API_KEY / AWS: SSM). When set,
   * requests must present either this key (anonymous read-only) or a valid
   * per-user "hrb_" key. Unset → keyless anonymous access (dev).
   */
  staticApiKey?: string;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function unauthorized(c: Context, message: string) {
  return c.json({ error: { code: "unauthorized", message } }, 401);
}

/**
 * Hono app processing MCP Streamable HTTP requests at "/".
 * POST carries JSON-RPC; GET/DELETE return 405 (no SSE stream / session
 * in stateless mode).
 */
export function createMcpApp(ctx: McpContext, options: McpAppOptions = {}): Hono {
  const staticApiKey = options.staticApiKey;
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
    const authorization = c.req.header("authorization") ?? "";
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    let user: AuthUser | null = null;
    if (token !== undefined && looksLikeApiKey(token)) {
      // Per-user key: must verify — never falls back to anonymous access.
      const verified = ctx.apiKeys ? await ctx.apiKeys.verify(token) : null;
      if (!verified) return unauthorized(c, "invalid API key");
      // API キー経由は常に非 admin として振る舞う（書き込みはオーナー権限のみ）。
      user = { sub: verified.ownerSub, name: verified.ownerName, isAdmin: false };
    } else if (staticApiKey) {
      if (!timingSafeEqualStr(authorization, `Bearer ${staticApiKey}`)) {
        return unauthorized(c, "invalid or missing API key");
      }
    }
    const server = buildMcpServer(ctx, { user });
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
 *
 * Note: createMcpApp performs this check itself (plus per-user "hrb_" keys);
 * this middleware remains for callers guarding other routes with the static key.
 */
export function bearerApiKeyAuth(apiKey: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    if (!apiKey) return next();
    const given = c.req.header("authorization") ?? "";
    if (!timingSafeEqualStr(given, `Bearer ${apiKey}`)) {
      return c.json({ error: { code: "unauthorized", message: "invalid or missing API key" } }, 401);
    }
    return next();
  };
}
