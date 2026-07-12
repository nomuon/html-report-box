/**
 * dev / vps 共通のルートハンドラ群 — server.ts から依存注入形に切り出したもの。
 *
 *   handleApi         → Hono アプリ（/api/*）。dev では CORS を付与
 *   handleMcp         → @hrb/mcp（/mcp）
 *   handleLocalUpload → S3 presigned POST のローカル代替（/local-upload）
 *   handleContent     → 公開コンテンツ配信（/r/*）。CloudFront の content
 *                       ディストリビューションと同じ CSP / セキュリティヘッダを付与
 *
 * Local-only module（Bun サーバー専用。Lambda には載らない）。
 */
import { buildContentCsp, CONTENT_X_ROBOTS_TAG, MAX_ZIP_SIZE_BYTES } from "@hrb/shared";
import { contentTypeForPath, isDomainError } from "@hrb/core";

type FetchLike = { fetch(req: Request): Response | Promise<Response> };

export interface RouteHandlerOptions {
  /** createApp() 済みの Hono アプリ（/api/*）。 */
  app: FetchLike;
  /** createMcpApp() を /mcp にマウント済みの Hono アプリ。 */
  mcp: FetchLike;
  storage: {
    putStagingObject(key: string, data: Uint8Array): Promise<void>;
    getContentObject(key: string): Promise<Uint8Array | null>;
  };
  /** /r/<id> → /r/<id>/ リダイレクトに使うコンテンツ側オリジン。 */
  contentBaseUrl: string;
  /** 別ポートの web dev サーバー向け CORS（dev のみ true）。 */
  corsEnabled: boolean;
}

export interface RouteHandlers {
  handleApi(req: Request): Promise<Response>;
  handleMcp(req: Request): Promise<Response>;
  handleLocalUpload(req: Request): Promise<Response>;
  handleContent(req: Request): Promise<Response>;
  /** /local-upload の OPTIONS 応答（dev の CORS プリフライト用）。 */
  uploadPreflight(): Response;
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type, x-dev-user, authorization",
  "access-control-max-age": "86400",
};

const MCP_CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "access-control-allow-headers":
    "content-type, authorization, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "mcp-session-id",
};

const CONTENT_CSP = buildContentCsp();

function withHeaders(res: Response, extra: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function createRouteHandlers(opts: RouteHandlerOptions): RouteHandlers {
  const { app, mcp, storage, contentBaseUrl, corsEnabled } = opts;

  async function handleApi(req: Request): Promise<Response> {
    if (!corsEnabled) return app.fetch(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    return withHeaders(await app.fetch(req), CORS_HEADERS);
  }

  async function handleMcp(req: Request): Promise<Response> {
    if (!corsEnabled) return mcp.fetch(req);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
    }
    return withHeaders(await mcp.fetch(req), MCP_CORS_HEADERS);
  }

  // ---- /local-upload: S3 presigned POST のローカル代替 ----

  function uploadError(status: number, message: string): Response {
    const res = Response.json({ error: { code: "bad_request", message } }, { status });
    return corsEnabled ? withHeaders(res, CORS_HEADERS) : res;
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
      await storage.putStagingObject(key, new Uint8Array(await file.arrayBuffer()));
    } catch (err) {
      if (isDomainError(err)) return uploadError(err.httpStatus, err.message);
      throw err;
    }
    // S3 presigned POST returns 204 No Content on success.
    const res = new Response(null, { status: 204 });
    return corsEnabled ? withHeaders(res, CORS_HEADERS) : res;
  }

  function uploadPreflight(): Response {
    return new Response(null, { status: 204, headers: corsEnabled ? CORS_HEADERS : {} });
  }

  // ---- /r/*: 公開コンテンツ配信（content CloudFront と同じヘッダポリシー） ----

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
      return Response.redirect(`${contentBaseUrl}/r/${rest}/`, 301);
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
      data = await storage.getContentObject(`reports/${id}/${path}`);
    } catch {
      data = null;
    }
    if (!data) return new Response("not found", { status: 404 });
    return new Response(req.method === "HEAD" ? null : (data as Uint8Array<ArrayBuffer>), {
      headers: {
        "content-type": contentTypeForPath(path),
        "content-length": String(data.byteLength),
        "content-security-policy": CONTENT_CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-robots-tag": CONTENT_X_ROBOTS_TAG,
      },
    });
  }

  return { handleApi, handleMcp, handleLocalUpload, handleContent, uploadPreflight };
}
