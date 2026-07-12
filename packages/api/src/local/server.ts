/**
 * Self-hosted server (Bun-only) — HRB_TARGET で dev / vps を切り替えて起動する。
 *
 *   dev（既定）: `bun run dev`（--hot）。1 リスナー・同一オリジンで全部入り:
 *     /api/* /mcp /local-upload /r/* + SPA。x-dev-user 有効・CORS 有効。
 *   vps: `HRB_TARGET=vps bun run start`。2 リスナーでオリジン分離:
 *     app リスナー（PORT）    → /api/* /mcp /local-upload + SPA（/r/* なし）
 *     content リスナー（HRB_CONTENT_PORT）→ /r/* のみ
 *     ホスト名→ポートの振り分けはリバースプロキシ（Caddy 等）が行う。
 *     docs/DEPLOYMENT.md 参照。
 *
 * ルート実装は routes.ts、環境変数の解決は server-config.ts に分離。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createLocalContext, StubDomainReputation } from "@hrb/core/local";
import { createScanner, createZipExtractor } from "@hrb/scanner";
import { bearerApiKeyAuth, createMcpApp } from "@hrb/mcp";
import { createApp } from "../app.ts";
import { createRouteHandlers } from "./routes.ts";
import { resolveServerConfig } from "./server-config.ts";

const config = resolveServerConfig(process.env);
const tag = `[${config.target}]`;
for (const warning of config.warnings) console.warn(`${tag} warning: ${warning}`);

const ctx = createLocalContext({
  dataDir: config.dataDir,
  contentBaseUrl: config.contentOrigin,
  scanner: createScanner({ domainReputation: new StubDomainReputation() }),
  zipExtractor: createZipExtractor(),
  ...(config.googleAuth
    ? {
        googleAuth: {
          clientId: config.googleAuth.clientId,
          adminEmails: config.googleAuth.adminEmails,
          allowDevHeader: config.allowDevUserHeader,
        },
      }
    : {}),
});
const app = createApp({
  service: ctx.service,
  auth: ctx.auth,
  ...(ctx.sessionAuth ? { sessionAuth: ctx.sessionAuth } : {}),
  userAdmin: ctx.userAdmin,
  contentBaseUrl: config.contentOrigin,
});

const mcpRoot = new Hono();
// vps では MCP_API_KEY 必須（server-config が担保）。dev もキー設定時のみ認証。
mcpRoot.use("/mcp", bearerApiKeyAuth(config.mcpApiKey ?? undefined));
mcpRoot.route("/mcp", createMcpApp({ reportService: ctx.service, objectStorage: ctx.storage }));

const handlers = createRouteHandlers({
  app,
  mcp: mcpRoot,
  storage: ctx.storage,
  // 発行時に setPendingUpload で保存されたキー（staging/<reportId>/<rand>）と
  // 一致する場合のみ /local-upload を受理する（presigned POST の署名検証相当）。
  isIssuedStagingKey: async (key) => {
    const reportId = key.match(/^staging\/([^/]+)\//)?.[1];
    if (!reportId) return false;
    return (await ctx.repo.getPendingUpload(reportId)) === key;
  },
  contentBaseUrl: config.contentOrigin,
  corsEnabled: config.corsEnabled,
});

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
    console.warn(`${tag} failed to load packages/web/index.html, serving placeholder:`, err);
    return null;
  }
}

const spa = await loadSpaRoute();
const placeholder = () =>
  new Response(PLACEHOLDER_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const appRoutes: Record<string, any> = {
  "/api/*": handlers.handleApi,
  "/mcp": handlers.handleMcp,
  "/local-upload": { POST: handlers.handleLocalUpload, OPTIONS: () => handlers.uploadPreflight() },
  "/*": spa ?? placeholder,
};

if (config.target === "dev") {
  // dev: 全ルートを 1 リスナー・同一オリジンで配信（従来どおり）。
  const server = Bun.serve({
    port: config.port,
    development: true,
    routes: { ...appRoutes, "/r/*": handlers.handleContent },
  });
  console.log(`${tag} HTML Report Box api on ${server.url}`);
} else {
  // vps: app と content を別リスナーに分離。app 側の routes に /r/* が存在
  // しないため、リバースプロキシの設定ミスがあっても app オリジンから
  // アップロード HTML が配信されることはない（fail-secure）。
  const appServer = Bun.serve({ port: config.port, development: false, routes: appRoutes });
  const contentServer = Bun.serve({
    port: config.contentPort as number,
    development: false,
    routes: { "/r/*": handlers.handleContent },
    fetch: () => new Response("not found", { status: 404 }),
  });
  console.log(`${tag} app listener     : ${appServer.url} (proxy from ${config.appOrigin})`);
  console.log(`${tag} content listener : ${contentServer.url} (proxy from ${config.contentOrigin})`);
}

console.log(`${tag}   data dir : ${config.dataDir}`);
console.log(
  `${tag}   spa      : ${spa ? webIndexPath : "placeholder (packages/web/index.html missing)"}`,
);
console.log(
  config.googleAuth
    ? `${tag}   auth     : google (client ${config.googleAuth.clientId.slice(0, 12)}…, admins: ${config.googleAuth.adminEmails.join(", ") || "none"})`
    : `${tag}   auth     : dev users via x-dev-user: alice | bob | admin`,
);
console.log(`${tag}   scanner  : @hrb/scanner (StubDomainReputation) + zip extractor`);
console.log(
  `${tag}   mcp      : POST ${config.appOrigin}/mcp${config.mcpApiKey ? " (Bearer API key)" : " (no API key)"}`,
);
