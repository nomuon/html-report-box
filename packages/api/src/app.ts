/**
 * @hrb/api — createApp(ctx): the Hono HTTP layer for base path /api.
 *
 * Route protection is declarative: public routes take no guard, login-only
 * routes use `requireAuth`, and everything under /admin/* uses `requireAdmin`.
 * Errors are always `{error:{code,message}}`; DomainError.httpStatus decides
 * the status code.
 *
 * Portable (Node 22 / Lambda). Bun-only code lives under src/local/.
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodType } from "zod";
import {
  AdminListReportsQuerySchema,
  CompleteReportRequestSchema,
  CreateReportRequestSchema,
  CreateUploadUrlRequestSchema,
  DAILY_UPLOAD_LIMIT,
  FlagReportRequestSchema,
  GoogleLoginRequestSchema,
  ListReportsQuerySchema,
  MAX_HTML_SIZE_BYTES,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_SIZE_BYTES,
  MAX_ZIP_UNCOMPRESSED_BYTES,
  PaginationQuerySchema,
  SearchQuerySchema,
  UpdateReportContentRequestSchema,
  UpdateReportRequestSchema,
  makeError,
  toOwnedReport,
  toPublicReport,
} from "@hrb/shared";
import type { GetConfigResponse } from "@hrb/shared";
import { DomainError, isDomainError } from "@hrb/core";
import type { AuthUser, AuthVerifier, PageOptions, ReportService, SessionAuth, UserAdmin } from "@hrb/core";
import { createMemoryRateLimiter } from "./rate-limit.ts";
import type { RateLimiter } from "./rate-limit.ts";

// Defaults for the unauthenticated flag endpoint (per client IP).
export const FLAG_RATE_LIMIT = 5;
export const FLAG_RATE_WINDOW_MS = 10 * 60 * 1000;

export interface AppContext {
  service: ReportService;
  auth: AuthVerifier;
  /** Login/logout endpoints (google mode). Absent → routes are not mounted. */
  sessionAuth?: SessionAuth;
  userAdmin: UserAdmin;
  /** Origin serving uploaded content, e.g. http://localhost:3000 (GET /config). */
  contentBaseUrl: string;
  /** Advertised in GET /config; must match what the ReportService enforces. */
  dailyUploadLimit?: number;
  /** Rate limiter for POST /reports/:id/flag (defaults to in-memory per-IP). */
  flagLimiter?: RateLimiter;
  /**
   * Number of trusted reverse proxies that append to X-Forwarded-For in front
   * of this app (e.g. CloudFront + API Gateway). The client IP is read from the
   * right — skipping this many trusted hops — because everything to the LEFT of
   * the trusted infrastructure is attacker-controllable. Default 0 = the app is
   * directly behind one trusted proxy, so the rightmost XFF entry is authoritative.
   */
  trustedProxyHops?: number;
}

type Env = { Variables: { user: AuthUser | null } };
export type AppType = Hono<Env>;

// ---- helpers ----

function parseWith<T>(schema: ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first && first.path.length > 0 ? `${what}.${first.path.join(".")}` : what;
    throw new DomainError("validation_failed", first ? `${where}: ${first.message}` : `invalid ${what}`);
  }
  return result.data;
}

async function readJson(c: Context<Env>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new DomainError("bad_request", "request body must be valid JSON");
  }
}

function mustUser(c: Context<Env>): AuthUser {
  const user = c.get("user");
  if (!user) throw new DomainError("unauthorized", "authentication required");
  return user;
}

/**
 * Derive the client IP from the TRUSTED-proxy position in X-Forwarded-For.
 *
 * CloudFront / API Gateway append the real viewer IP to any client-supplied
 * XFF, so the header arrives as `<attacker-spoofed…>, <real-viewer-ip>`. Taking
 * the leftmost entry (as before) let an attacker forge the value on every
 * request — rotating it to defeat the per-IP flag rate limiter and to poison
 * the persisted audit sourceIp. We read from the right instead, skipping
 * `trustedProxyHops` proxies we control, so the value cannot be spoofed by the
 * client.
 */
function clientIp(c: Context<Env>, trustedProxyHops = 0): string | undefined {
  const forwarded = c.req.header("x-forwarded-for");
  if (!forwarded) return undefined;
  const parts = forwarded
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  const idx = parts.length - 1 - trustedProxyHops;
  const ip = parts[idx >= 0 ? idx : 0];
  return ip && ip.length > 0 ? ip : undefined;
}

function auditInfo(c: Context<Env>, trustedProxyHops?: number): { sourceIp?: string; userAgent?: string } {
  const sourceIp = clientIp(c, trustedProxyHops);
  const userAgent = c.req.header("user-agent");
  return {
    ...(sourceIp !== undefined ? { sourceIp } : {}),
    ...(userAgent !== undefined ? { userAgent } : {}),
  };
}

function pageOptions(query: { limit?: number; cursor?: string }): PageOptions {
  return {
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
  };
}

// ---- app factory ----

export function createApp(ctx: AppContext): AppType {
  const flagLimiter =
    ctx.flagLimiter ??
    createMemoryRateLimiter({ limit: FLAG_RATE_LIMIT, windowMs: FLAG_RATE_WINDOW_MS });
  const trustedProxyHops = ctx.trustedProxyHops ?? 0;

  const app = new Hono<Env>().basePath("/api");

  // Resolve credentials once for every request; routes decide what they need.
  app.use(async (c, next) => {
    c.set("user", await ctx.auth.verify(c.req.header()));
    await next();
  });

  const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
    mustUser(c);
    await next();
  };

  const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
    const user = mustUser(c);
    if (!user.isAdmin) throw new DomainError("forbidden", "admin privileges required");
    await next();
  };

  app.notFound((c) => c.json(makeError("not_found", "no such route"), 404));

  app.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(makeError(err.code, err.message), err.httpStatus as ContentfulStatusCode);
    }
    console.error("[api] unhandled error:", err);
    return c.json(makeError("internal", "internal server error"), 500);
  });

  // =====================
  // Public routes
  // =====================

  app.get("/config", (c) => {
    const config: GetConfigResponse = {
      contentBaseUrl: ctx.contentBaseUrl,
      auth: ctx.auth.authConfig(),
      limits: {
        maxHtmlSizeBytes: MAX_HTML_SIZE_BYTES,
        maxZipSizeBytes: MAX_ZIP_SIZE_BYTES,
        maxZipUncompressedBytes: MAX_ZIP_UNCOMPRESSED_BYTES,
        maxZipEntries: MAX_ZIP_ENTRIES,
        dailyUploadLimit: ctx.dailyUploadLimit ?? DAILY_UPLOAD_LIMIT,
      },
    };
    return c.json(config);
  });

  // Session login/logout — mounted only when the auth mode issues its own
  // sessions (google mode locally; Cognito owns the session in AWS mode).
  const sessionAuth = ctx.sessionAuth;
  if (sessionAuth) {
    app.post("/auth/google", async (c) => {
      const body = parseWith(GoogleLoginRequestSchema, await readJson(c), "login");
      const session = await sessionAuth.loginWithGoogle(body.credential);
      return c.json(session);
    });

    app.post("/auth/logout", async (c) => {
      const token = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (token) await sessionAuth.logout(token);
      return c.json({ ok: true as const });
    });
  }

  app.get("/reports", async (c) => {
    const query = parseWith(ListReportsQuerySchema, c.req.query(), "query");
    const page = await ctx.service.listPublished(pageOptions(query));
    return c.json({
      reports: page.items.map(toPublicReport),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    });
  });

  app.get("/search", async (c) => {
    const query = parseWith(SearchQuerySchema, c.req.query(), "query");
    const results = await ctx.service.search(query.q, query.limit ?? 20);
    return c.json({ results });
  });

  app.get("/reports/:id", async (c) => {
    const { report, url, isOwner } = await ctx.service.get(c.req.param("id"), c.get("user"));
    // Scan outcome is owner/admin-only context (PublicReport omits it by design).
    const canSeeScan = isOwner || (c.get("user")?.isAdmin ?? false);
    return c.json({
      report: toPublicReport(report),
      isOwner,
      ...(url !== undefined ? { url } : {}),
      ...(canSeeScan && report.verdict !== undefined
        ? { verdict: report.verdict, findings: report.findings }
        : {}),
    });
  });

  // Unauthenticated abuse report, rate limited per client IP.
  app.post("/reports/:id/flag", async (c) => {
    const sourceIp = clientIp(c, trustedProxyHops);
    if (!flagLimiter.allow(`flag:${sourceIp ?? "unknown"}`)) {
      throw new DomainError("rate_limited", "too many reports from this address; try again later");
    }
    const body = parseWith(FlagReportRequestSchema, await readJson(c), "flag");
    await ctx.service.flag(c.req.param("id"), body.reason, {
      ...(sourceIp !== undefined ? { sourceIp } : {}),
    });
    return c.json({ ok: true as const });
  });

  // =====================
  // Authenticated routes
  // =====================

  app.get("/me/reports", requireAuth, async (c) => {
    const query = parseWith(PaginationQuerySchema, c.req.query(), "query");
    const page = await ctx.service.listMine(mustUser(c), pageOptions(query));
    return c.json({
      reports: page.items.map(toOwnedReport),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    });
  });

  app.get("/me/quota", requireAuth, async (c) => {
    return c.json(await ctx.service.getUploadQuota(mustUser(c)));
  });

  app.post("/reports", requireAuth, async (c) => {
    const body = parseWith(CreateReportRequestSchema, await readJson(c), "report");
    const { report, upload } = await ctx.service.create(
      mustUser(c),
      body,
      auditInfo(c, trustedProxyHops),
    );
    return c.json({ report: toOwnedReport(report), upload }, 201);
  });

  app.post("/reports/:id/upload-url", requireAuth, async (c) => {
    const body = parseWith(CreateUploadUrlRequestSchema, await readJson(c), "upload-url");
    const { upload } = await ctx.service.issueUploadUrl(mustUser(c), c.req.param("id"), body.kind);
    return c.json({ upload });
  });

  app.post("/reports/:id/complete", requireAuth, async (c) => {
    const body = parseWith(CompleteReportRequestSchema, await readJson(c), "complete");
    const { report, url } = await ctx.service.complete(mustUser(c), c.req.param("id"), body.key);
    return c.json({
      report: toOwnedReport(report),
      ...(url !== undefined ? { url } : {}),
    });
  });

  app.post("/reports/:id/publish", requireAuth, async (c) => {
    const { report, url } = await ctx.service.publish(mustUser(c), c.req.param("id"));
    return c.json({ report: toOwnedReport(report), url });
  });

  app.post("/reports/:id/unpublish", requireAuth, async (c) => {
    const report = await ctx.service.unpublish(mustUser(c), c.req.param("id"));
    return c.json({ report: toOwnedReport(report) });
  });

  app.get("/reports/:id/source", requireAuth, async (c) => {
    const source = await ctx.service.getSource(mustUser(c), c.req.param("id"));
    return c.json(source);
  });

  app.put("/reports/:id/content", requireAuth, async (c) => {
    const body = parseWith(UpdateReportContentRequestSchema, await readJson(c), "content");
    const { report, url } = await ctx.service.editContent(mustUser(c), c.req.param("id"), body.html);
    return c.json({
      report: toOwnedReport(report),
      ...(url !== undefined ? { url } : {}),
    });
  });

  app.patch("/reports/:id", requireAuth, async (c) => {
    const body = parseWith(UpdateReportRequestSchema, await readJson(c), "report update");
    const report = await ctx.service.update(mustUser(c), c.req.param("id"), body);
    return c.json({ report: toOwnedReport(report) });
  });

  app.delete("/reports/:id", requireAuth, async (c) => {
    await ctx.service.delete(mustUser(c), c.req.param("id"));
    return c.json({ ok: true as const });
  });

  // =====================
  // Admin routes
  // =====================

  app.use("/admin/*", requireAdmin);

  app.get("/admin/reports", async (c) => {
    const query = parseWith(AdminListReportsQuerySchema, c.req.query(), "query");
    const page = await ctx.service.adminList(mustUser(c), {
      ...pageOptions(query),
      ...(query.status !== undefined ? { status: query.status } : {}),
    });
    return c.json({
      reports: page.items,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    });
  });

  app.get("/admin/flagged", async (c) => {
    const query = parseWith(PaginationQuerySchema, c.req.query(), "query");
    const page = await ctx.service.adminListFlagged(mustUser(c), pageOptions(query));
    return c.json({
      items: page.items,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    });
  });

  app.get("/admin/reports/:id/flags", async (c) => {
    const flags = await ctx.service.adminListFlags(mustUser(c), c.req.param("id"));
    return c.json({ flags });
  });

  app.delete("/admin/reports/:id/flags", async (c) => {
    await ctx.service.adminClearFlags(mustUser(c), c.req.param("id"));
    return c.json({ ok: true as const });
  });

  app.post("/admin/reports/:id/takedown", async (c) => {
    const report = await ctx.service.adminTakedown(mustUser(c), c.req.param("id"));
    return c.json({ report });
  });

  app.get("/admin/users", async (c) => {
    const query = parseWith(PaginationQuerySchema, c.req.query(), "query");
    const page = await ctx.userAdmin.listUsers(pageOptions(query));
    return c.json({
      users: page.items,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    });
  });

  const setAdmin = async (c: Context<Env>, username: string, isAdmin: boolean) => {
    try {
      await ctx.userAdmin.setAdmin(username, isAdmin);
    } catch (err) {
      if (isDomainError(err)) throw err;
      // Local adapter (and the Cognito adapter's UserNotFoundException in S6)
      // signal unknown users with a plain error.
      throw new DomainError("not_found", "user not found");
    }
    return c.json({ ok: true as const });
  };

  app.put("/admin/users/:username/admin", (c) => setAdmin(c, c.req.param("username"), true));
  app.delete("/admin/users/:username/admin", (c) => setAdmin(c, c.req.param("username"), false));

  // Account deletion cascades into the user's reports (sub resolved first so a
  // half-failed cascade can be retried while the account still exists).
  app.delete("/admin/users/:username", async (c) => {
    const username = c.req.param("username");
    const me = mustUser(c);
    const sub = await ctx.userAdmin.getUserSub(username);
    if (sub === null) throw new DomainError("not_found", "user not found");
    if (sub === me.sub) throw new DomainError("bad_request", "cannot delete your own account");
    const deletedReports = await ctx.service.adminDeleteByOwner(me, sub);
    await ctx.userAdmin.deleteUser(username);
    return c.json({ ok: true as const, deletedReports });
  });

  return app;
}
