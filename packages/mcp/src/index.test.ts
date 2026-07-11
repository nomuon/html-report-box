/**
 * HTTP-level MCP protocol tests: initialize → tools/list → tools/call against
 * createMcpApp backed by the in-memory local context (fresh temp dataDir).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createLocalContext, getDevUser } from "@hrb/core/local";
import type { LocalContext } from "@hrb/core/local";
import { bearerApiKeyAuth, createMcpApp, MCP_SERVER_NAME } from "./index.ts";
import type { McpContext } from "./index.ts";
import { createMcpLambdaApp } from "./lambda.ts";

const CONTENT_BASE = "http://localhost:3000";

const page = (title: string, body: string) =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

let ctx: LocalContext;
let mcpCtx: McpContext;
let app: Hono;
let salesId: string; // published first
let auditId: string; // published second (more recent)
let draftId: string; // created but never completed → private (no content)

async function publish(owner: string, title: string, body: string): Promise<string> {
  const user = getDevUser(owner);
  const { report, upload } = await ctx.service.create(user, { title, kind: "html" });
  await ctx.storage.putStagingObject(upload.key, new TextEncoder().encode(page(title, body)));
  await ctx.service.complete(user, report.id, upload.key);
  const done = await ctx.service.publish(user, report.id);
  expect(done.report.status).toBe("published");
  return report.id;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

let nextId = 1;
async function rpc(target: Hono, method: string, params: unknown, path = "/", headers: Record<string, string> = {}) {
  const res = await target.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return res;
}

async function rpcResult(target: Hono, method: string, params: unknown): Promise<any> {
  const res = await rpc(target, method, params);
  expect(res.status).toBe(200);
  const body = (await res.json()) as JsonRpcResponse;
  expect(body.error).toBeUndefined();
  return body.result;
}

/** Unwrap a tools/call result whose single text content is JSON. */
async function callTool(target: Hono, name: string, args: Record<string, unknown>) {
  const result = await rpcResult(target, "tools/call", { name, arguments: args });
  return result;
}

function parseToolJson(result: any): any {
  expect(result.isError ?? false).toBe(false);
  expect(result.content[0].type).toBe("text");
  return JSON.parse(result.content[0].text);
}

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hrb-mcp-test-"));
  // Deterministic, strictly increasing clock so updatedAt ordering is stable.
  let tick = Date.parse("2026-07-01T00:00:00.000Z");
  ctx = createLocalContext({
    dataDir,
    contentBaseUrl: CONTENT_BASE,
    now: () => new Date((tick += 1000)),
  });
  mcpCtx = { reportService: ctx.service, objectStorage: ctx.storage };
  app = createMcpApp(mcpCtx);

  salesId = await publish(
    "alice",
    "2026年6月度 月次売上レポート",
    "クラウド事業部の売上が前年比120%と好調に推移しました。",
  );
  auditId = await publish("bob", "セキュリティ監査チェックリスト", "四半期のセキュリティ監査項目の一覧です。");
  const alice = getDevUser("alice");
  const draft = await ctx.service.create(alice, { title: "下書きレポート", kind: "html" });
  draftId = draft.report.id;
});

describe("MCP protocol over Streamable HTTP (stateless)", () => {
  test("initialize returns server info", async () => {
    const result = await rpcResult(app, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.1" },
    });
    expect(result.serverInfo.name).toBe(MCP_SERVER_NAME);
    expect(result.capabilities.tools).toBeDefined();
  });

  test("tools/list exposes the three tools", async () => {
    const result = await rpcResult(app, "tools/list", {});
    const names = result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["get_report", "list_recent_reports", "search_reports"]);
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  test("GET / is rejected in stateless mode", async () => {
    const res = await app.request("/", {
      method: "GET",
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(405);
  });
});

describe("search_reports", () => {
  test("finds published reports by Japanese query", async () => {
    const data = parseToolJson(await callTool(app, "search_reports", { query: "売上" }));
    expect(data.results.length).toBe(1);
    const hit = data.results[0];
    expect(hit.id).toBe(salesId);
    expect(hit.title).toBe("2026年6月度 月次売上レポート");
    expect(hit.url).toBe(`${CONTENT_BASE}/r/${salesId}/`);
    expect(hit.matchedAll).toBe(true);
  });

  test("matches body text, not only titles", async () => {
    const data = parseToolJson(await callTool(app, "search_reports", { query: "クラウド事業部" }));
    expect(data.results.map((r: any) => r.id)).toContain(salesId);
  });

  test("returns empty results for no match", async () => {
    const data = parseToolJson(await callTool(app, "search_reports", { query: "存在しない語句xyzq" }));
    expect(data.results).toEqual([]);
  });

  test("rejects invalid arguments (empty query)", async () => {
    const result = await rpcResult(app, "tools/call", {
      name: "search_reports",
      arguments: { query: "" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("get_report", () => {
  test("returns metadata, share URL and extracted text", async () => {
    const data = parseToolJson(await callTool(app, "get_report", { id: salesId }));
    expect(data.report.id).toBe(salesId);
    expect(data.report.title).toBe("2026年6月度 月次売上レポート");
    expect(data.url).toBe(`${CONTENT_BASE}/r/${salesId}/`);
    expect(data.extractedText).toContain("クラウド事業部の売上");
    expect(data.extractedTextTruncated).toBe(false);
    // Public view: no owner sub / audit fields.
    expect(data.report.ownerSub).toBeUndefined();
    expect(data.report.sourceIp).toBeUndefined();
  });

  test("non-published report is not visible", async () => {
    const result = await callTool(app, "get_report", { id: draftId });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  test("unknown id yields a not-found tool error", async () => {
    const result = await callTool(app, "get_report", { id: "nonexistent-id-123456" });
    expect(result.isError).toBe(true);
  });
});

describe("list_recent_reports", () => {
  test("lists published reports, most recent first, excluding drafts", async () => {
    const data = parseToolJson(await callTool(app, "list_recent_reports", {}));
    const ids = data.reports.map((r: any) => r.id);
    expect(ids).toEqual([auditId, salesId]);
    expect(ids).not.toContain(draftId);
    expect(data.reports[0].url).toBe(`${CONTENT_BASE}/r/${auditId}/`);
  });

  test("honors limit", async () => {
    const data = parseToolJson(await callTool(app, "list_recent_reports", { limit: 1 }));
    expect(data.reports.length).toBe(1);
    expect(data.reports[0].id).toBe(auditId);
  });
});

describe("API key gate (lambda app)", () => {
  const params = {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.1" },
  };

  test("rejects missing or wrong bearer token when a key is configured", async () => {
    const guarded = createMcpLambdaApp(mcpCtx,{ apiKey: "sekret-key" });
    const noAuth = await rpc(guarded, "initialize", params, "/mcp");
    expect(noAuth.status).toBe(401);
    const wrong = await rpc(guarded, "initialize", params, "/mcp", {
      authorization: "Bearer wrong",
    });
    expect(wrong.status).toBe(401);
  });

  test("accepts the correct bearer token on /mcp and /", async () => {
    const guarded = createMcpLambdaApp(mcpCtx,{ apiKey: "sekret-key" });
    for (const path of ["/mcp", "/"]) {
      const ok = await rpc(guarded, "initialize", params, path, {
        authorization: "Bearer sekret-key",
      });
      expect(ok.status).toBe(200);
    }
  });

  test("skips the check when no key is configured", async () => {
    // Ensure the env fallback does not accidentally apply in tests.
    delete process.env.MCP_API_KEY;
    const open = createMcpLambdaApp(mcpCtx,{ apiKey: undefined });
    const res = await rpc(open, "initialize", params, "/mcp");
    expect(res.status).toBe(200);
  });

  test("middleware is constant-time-safe for differing lengths", async () => {
    // Regression guard: differing header length must not throw.
    const mw = bearerApiKeyAuth("k");
    expect(typeof mw).toBe("function");
    const guarded = createMcpLambdaApp(mcpCtx,{ apiKey: "k" });
    const res = await rpc(guarded, "initialize", params, "/mcp", {
      authorization: "Bearer way-longer-than-expected",
    });
    expect(res.status).toBe(401);
  });
});
