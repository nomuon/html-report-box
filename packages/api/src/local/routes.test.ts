import { describe, expect, test } from "bun:test";
import { buildContentCsp, MAX_ZIP_SIZE_BYTES } from "@hrb/shared";
import { createRouteHandlers } from "./routes.ts";
import type { RouteHandlerOptions } from "./routes.ts";

const CONTENT_ORIGIN = "https://content.example.com";

function makeHandlers(overrides: Partial<RouteHandlerOptions> = {}) {
  const objects = new Map<string, Uint8Array>();
  const staged = new Map<string, Uint8Array>();
  const issued = new Set(["staging/x", "staging/big"]);
  const handlers = createRouteHandlers({
    app: { fetch: async () => Response.json({ ok: true }) },
    mcp: { fetch: async () => Response.json({ jsonrpc: "2.0" }) },
    storage: {
      putStagingObject: async (key, data) => void staged.set(key, data),
      getContentObject: async (key) => objects.get(key) ?? null,
    },
    isIssuedStagingKey: async (key) => issued.has(key),
    contentBaseUrl: CONTENT_ORIGIN,
    corsEnabled: false,
    ...overrides,
  });
  return { handlers, objects, staged, issued };
}

describe("handleContent", () => {
  test("公開オブジェクトを CSP + セキュリティヘッダ付きで配信する", async () => {
    const { handlers, objects } = makeHandlers();
    objects.set("reports/abc/index.html", new TextEncoder().encode("<h1>hi</h1>"));
    const res = await handlers.handleContent(new Request(`${CONTENT_ORIGIN}/r/abc/`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(buildContentCsp());
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toBe("<h1>hi</h1>");
  });

  test("/r/<id> は contentBaseUrl の /r/<id>/ へ 301", async () => {
    const { handlers } = makeHandlers();
    const res = await handlers.handleContent(new Request(`${CONTENT_ORIGIN}/r/abc`));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${CONTENT_ORIGIN}/r/abc/`);
  });

  test("dotfile・トラバーサル・空セグメントは 404", async () => {
    const { handlers, objects } = makeHandlers();
    objects.set("reports/abc/.extracted.txt", new Uint8Array([1]));
    for (const path of ["/r/abc/.extracted.txt", "/r/.hidden/index.html", "/r/abc//x.html"]) {
      const res = await handlers.handleContent(new Request(`${CONTENT_ORIGIN}${path}`));
      expect(res.status).toBe(404);
    }
  });

  test("GET/HEAD 以外は 405", async () => {
    const { handlers } = makeHandlers();
    const res = await handlers.handleContent(
      new Request(`${CONTENT_ORIGIN}/r/abc/`, { method: "POST" }),
    );
    expect(res.status).toBe(405);
  });
});

describe("handleLocalUpload", () => {
  function uploadRequest(fields: Record<string, string | Blob>): Request {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return new Request("http://app.local/local-upload", { method: "POST", body: form });
  }

  test("key + file で 204、staging に保存される", async () => {
    const { handlers, staged } = makeHandlers();
    const res = await handlers.handleLocalUpload(
      uploadRequest({ key: "staging/x", file: new Blob(["<html></html>"]) }),
    );
    expect(res.status).toBe(204);
    expect(staged.has("staging/x")).toBe(true);
  });

  test("未発行（or 消費済み）キーは 403 で拒否し staging に書き込まない", async () => {
    const { handlers, staged } = makeHandlers();
    const res = await handlers.handleLocalUpload(
      uploadRequest({ key: "staging/not-issued", file: new Blob(["x"]) }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    expect(staged.size).toBe(0);
  });

  test("key 欠落は 400、サイズ超過は 413", async () => {
    const { handlers } = makeHandlers();
    expect((await handlers.handleLocalUpload(uploadRequest({ file: new Blob(["x"]) }))).status).toBe(400);
    const big = new Blob([new Uint8Array(MAX_ZIP_SIZE_BYTES + 1)]);
    expect(
      (await handlers.handleLocalUpload(uploadRequest({ key: "staging/big", file: big }))).status,
    ).toBe(413);
  });
});

// 認証本体は createMcpApp 内（@hrb/mcp のテストが担保）。ここでは 401/200 が
// handleMcp を素通しで伝わることを静的キー middleware で検証する。
describe("MCP API キー（handleMcp が認証結果を素通しすること）", () => {
  test("キー設定時は Bearer なし 401 / 一致で 200", async () => {
    const { Hono } = await import("hono");
    const { bearerApiKeyAuth } = await import("@hrb/mcp");
    const apiKey = "k".repeat(32);
    const mcpRoot = new Hono();
    mcpRoot.use("/mcp", bearerApiKeyAuth(apiKey));
    mcpRoot.all("/mcp", (c) => c.json({ ok: true }));
    const { handlers } = makeHandlers({ mcp: mcpRoot });
    const denied = await handlers.handleMcp(
      new Request("http://app.local/mcp", { method: "POST" }),
    );
    expect(denied.status).toBe(401);
    const allowed = await handlers.handleMcp(
      new Request("http://app.local/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
    expect(allowed.status).toBe(200);
  });
});

describe("CORS の有効/無効", () => {
  test("corsEnabled=true（dev）: API レスポンスと OPTIONS に CORS ヘッダ", async () => {
    const { handlers } = makeHandlers({ corsEnabled: true });
    const res = await handlers.handleApi(new Request("http://app.local/api/reports"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = await handlers.handleApi(
      new Request("http://app.local/api/reports", { method: "OPTIONS" }),
    );
    expect(preflight.status).toBe(204);
    const mcpPreflight = await handlers.handleMcp(
      new Request("http://app.local/mcp", { method: "OPTIONS" }),
    );
    expect(mcpPreflight.headers.get("access-control-expose-headers")).toBe("mcp-session-id");
  });

  test("corsEnabled=false（vps）: CORS ヘッダなし・OPTIONS は素通し", async () => {
    const { handlers } = makeHandlers({ corsEnabled: false });
    const res = await handlers.handleApi(new Request("http://app.local/api/reports"));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const mcpRes = await handlers.handleMcp(new Request("http://app.local/mcp", { method: "POST" }));
    expect(mcpRes.headers.get("access-control-allow-origin")).toBeNull();
  });
});
