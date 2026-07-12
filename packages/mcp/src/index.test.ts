/**
 * HTTP-level MCP protocol tests: initialize → tools/list → tools/call against
 * createMcpApp backed by the in-memory local context (fresh temp dataDir).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { ScanResult, SecurityScanner } from "@hrb/core";
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

  test("tools/list exposes the six tools", async () => {
    const result = await rpcResult(app, "tools/list", {});
    const names = result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      "get_report",
      "list_recent_reports",
      "publish_report",
      "search_reports",
      "unpublish_report",
      "upload_report",
    ]);
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

/** tools/call with extra headers (per-user / static key auth tests). */
async function callToolWith(
  target: Hono,
  headers: Record<string, string>,
  name: string,
  args: Record<string, unknown>,
) {
  const res = await rpc(target, "tools/call", { name, arguments: args }, "/", headers);
  expect(res.status).toBe(200);
  const body = (await res.json()) as JsonRpcResponse;
  expect(body.error).toBeUndefined();
  return body.result;
}

class FakeScanner implements SecurityScanner {
  next: ScanResult = { verdict: "pass", findings: [] };

  async scan(): Promise<ScanResult> {
    return this.next;
  }
}

describe("per-user API keys and write tools", () => {
  const APP_BASE = "http://localhost:3000";
  const STATIC_KEY = "static-mcp-key-0123456789abcdef";
  let wctx: LocalContext;
  let wapp: Hono; // static key + per-user keys enabled
  let scanner: FakeScanner;
  let aliceKey: string;
  let bearer: Record<string, string>;

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hrb-mcp-write-test-"));
    scanner = new FakeScanner();
    wctx = createLocalContext({ dataDir, contentBaseUrl: CONTENT_BASE, scanner });
    const alice = getDevUser("alice");
    const issued = await wctx.apiKeys.issue({ sub: alice.sub, name: alice.name }, "mcp test");
    aliceKey = issued.plaintext;
    bearer = { authorization: `Bearer ${aliceKey}` };
    wapp = createMcpApp(
      {
        reportService: wctx.service,
        objectStorage: wctx.storage,
        apiKeys: wctx.apiKeys,
        appBaseUrl: APP_BASE,
      },
      { staticApiKey: STATIC_KEY },
    );
  });

  test("invalid hrb_ key is 401 (does not fall back to anonymous)", async () => {
    const res = await rpc(wapp, "tools/call", { name: "list_recent_reports", arguments: {} }, "/", {
      authorization: "Bearer hrb_invalid-key",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("unauthorized");
  });

  test("keyless caller (dev) cannot use write tools", async () => {
    // `app` from the top-level setup: no static key, no apiKeys store.
    const result = await callTool(app, "upload_report", {
      title: "t",
      html: "<html><body>x</body></html>",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unauthorized");
  });

  test("static key caller stays anonymous read-only", async () => {
    const headers = { authorization: `Bearer ${STATIC_KEY}` };
    const listed = await callToolWith(wapp, headers, "list_recent_reports", {});
    expect(listed.isError ?? false).toBe(false);
    const denied = await callToolWith(wapp, headers, "upload_report", {
      title: "t",
      html: "<html><body>x</body></html>",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("unauthorized");
  });

  test("upload → get (private, own) → publish → unpublish with a per-user key", async () => {
    const uploaded = parseToolJson(
      await callToolWith(wapp, bearer, "upload_report", {
        title: "MCP 経由レポート",
        description: "MCP からのアップロード",
        html: page("MCP 経由レポート", "MCP アップロード本文です。"),
      }),
    );
    expect(uploaded.status).toBe("private");
    expect(uploaded.verdict).toBe("pass");
    expect(uploaded.appUrl).toBe(`${APP_BASE}/reports/${uploaded.id}`);

    // Owner can read their private report through the key…
    const own = parseToolJson(await callToolWith(wapp, bearer, "get_report", { id: uploaded.id }));
    expect(own.report.id).toBe(uploaded.id);
    expect(own.report.status).toBe("private");
    expect(own.url).toBeUndefined();

    // …anonymous (static key) callers cannot.
    const anon = await callToolWith(
      wapp,
      { authorization: `Bearer ${STATIC_KEY}` },
      "get_report",
      { id: uploaded.id },
    );
    expect(anon.isError).toBe(true);

    const published = parseToolJson(
      await callToolWith(wapp, bearer, "publish_report", { id: uploaded.id }),
    );
    expect(published.status).toBe("published");
    expect(published.shareUrl).toBe(`${APP_BASE}/reports/${uploaded.id}`);
    expect(published.contentUrl).toBe(`${CONTENT_BASE}/r/${uploaded.id}/`);

    const unpublished = parseToolJson(
      await callToolWith(wapp, bearer, "unpublish_report", { id: uploaded.id }),
    );
    expect(unpublished.status).toBe("private");
  });

  test("publish_report visibility=unlisted: link-only — get works anonymously, list/search stay empty", async () => {
    const uploaded = parseToolJson(
      await callToolWith(wapp, bearer, "upload_report", {
        title: "リンク限定レポート",
        html: page("リンク限定レポート", "限定共有の本文です。"),
      }),
    );

    const published = parseToolJson(
      await callToolWith(wapp, bearer, "publish_report", {
        id: uploaded.id,
        visibility: "unlisted",
      }),
    );
    expect(published.status).toBe("unlisted");
    expect(published.contentUrl).toBe(`${CONTENT_BASE}/r/${uploaded.id}/`);

    // 匿名（static key）でも URL 付きで取得できる…
    const anon = parseToolJson(
      await callToolWith(wapp, { authorization: `Bearer ${STATIC_KEY}` }, "get_report", {
        id: uploaded.id,
      }),
    );
    expect(anon.report.status).toBe("unlisted");
    expect(anon.url).toBe(`${CONTENT_BASE}/r/${uploaded.id}/`);

    // …が、一覧・検索には載らない
    const listed = parseToolJson(await callToolWith(wapp, bearer, "list_recent_reports", {}));
    expect(listed.reports.map((r: any) => r.id)).not.toContain(uploaded.id);
    const searched = parseToolJson(
      await callToolWith(wapp, bearer, "search_reports", { query: "限定共有" }),
    );
    expect(searched.results.map((r: any) => r.id)).not.toContain(uploaded.id);

    // visibility 省略の再呼び出しで published へ切替（後方互換）
    const republished = parseToolJson(
      await callToolWith(wapp, bearer, "publish_report", { id: uploaded.id }),
    );
    expect(republished.status).toBe("published");
    const relisted = parseToolJson(await callToolWith(wapp, bearer, "list_recent_reports", {}));
    expect(relisted.reports.map((r: any) => r.id)).toContain(uploaded.id);

    // 後始末: 他テストの一覧に影響しないよう非公開へ戻す
    await callToolWith(wapp, bearer, "unpublish_report", { id: uploaded.id });
  });

  test("cannot publish someone else's report (owner check)", async () => {
    const bob = getDevUser("bob");
    const { report, upload } = await wctx.service.create(bob, { title: "bob の下書き", kind: "html" });
    await wctx.storage.putStagingObject(upload.key, new TextEncoder().encode(page("bob", "b")));
    await wctx.service.complete(bob, report.id, upload.key);
    const result = await callToolWith(wapp, bearer, "publish_report", { id: report.id });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("forbidden");
  });

  test("blocked upload is rejected (scan always runs)", async () => {
    scanner.next = {
      verdict: "block",
      findings: [{ ruleId: "test-block", severity: "block", message: "test blocked" }],
    };
    try {
      const rejected = parseToolJson(
        await callToolWith(wapp, bearer, "upload_report", {
          title: "悪性レポート",
          html: "<html><body>evil</body></html>",
        }),
      );
      expect(rejected.status).toBe("rejected");
      expect(rejected.verdict).toBe("block");
      expect(rejected.findings.map((f: any) => f.ruleId)).toContain("test-block");
      expect(rejected.message).toContain("rejected");
    } finally {
      scanner.next = { verdict: "pass", findings: [] };
    }
  });

  test("upload consumes the daily quota", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hrb-mcp-quota-test-"));
    const qctx = createLocalContext({ dataDir, contentBaseUrl: CONTENT_BASE, dailyUploadLimit: 1 });
    const alice = getDevUser("alice");
    const issued = await qctx.apiKeys.issue({ sub: alice.sub, name: alice.name }, "quota");
    const qapp = createMcpApp({
      reportService: qctx.service,
      objectStorage: qctx.storage,
      apiKeys: qctx.apiKeys,
    });
    const headers = { authorization: `Bearer ${issued.plaintext}` };
    const args = { title: "quota", html: "<html><body>q</body></html>" };
    const first = await callToolWith(qapp, headers, "upload_report", args);
    expect(first.isError ?? false).toBe(false);
    const second = await callToolWith(qapp, headers, "upload_report", args);
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("rate_limited");
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
