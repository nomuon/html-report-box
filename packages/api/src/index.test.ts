/**
 * @hrb/api integration tests — drive createApp() with app.request() against
 * a real local context (temp dataDir) and a controllable fake scanner.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalContext, DEV_USER_HEADER } from "@hrb/core/local";
import type { ScanResult, SecurityScanner } from "@hrb/core";
import { createApp, FLAG_RATE_LIMIT } from "./app.ts";
import type { AppType } from "./app.ts";

const BASE = "http://localhost:3000";
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

class FakeScanner implements SecurityScanner {
  next: ScanResult = { verdict: "pass", findings: [] };

  async scan(): Promise<ScanResult> {
    return this.next;
  }
}

function makeEnv(opts: { dailyUploadLimit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hrb-api-test-"));
  tempDirs.push(dir);
  const scanner = new FakeScanner();
  const ctx = createLocalContext({
    dataDir: dir,
    contentBaseUrl: BASE,
    scanner,
    ...(opts.dailyUploadLimit !== undefined ? { dailyUploadLimit: opts.dailyUploadLimit } : {}),
  });
  const app = createApp({
    service: ctx.service,
    auth: ctx.auth,
    userAdmin: ctx.userAdmin,
    contentBaseUrl: BASE,
    ...(opts.dailyUploadLimit !== undefined ? { dailyUploadLimit: opts.dailyUploadLimit } : {}),
  });
  return { ctx, app, scanner };
}

interface CallOptions {
  user?: string;
  body?: unknown;
  ip?: string;
  rawBody?: string;
}

async function call(
  app: AppType,
  method: string,
  path: string,
  opts: CallOptions = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.user) headers[DEV_USER_HEADER] = opts.user;
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined || opts.rawBody !== undefined) {
    headers["content-type"] = "application/json";
    init.body = opts.rawBody ?? JSON.stringify(opts.body);
  }
  const res = await app.request(`/api${path}`, init);
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body (should not happen for /api routes)
  }
  return { status: res.status, json };
}

/** create → stage bytes → complete. Returns ids and both responses (report ends private). */
async function upload(
  env: ReturnType<typeof makeEnv>,
  user: string,
  title: string,
  html = `<html><head><title>${title}</title></head><body>report body for ${title}</body></html>`,
) {
  const created = await call(env.app, "POST", "/reports", {
    user,
    body: { title, kind: "html" },
  });
  expect(created.status).toBe(201);
  const id: string = created.json.report.id;
  const key: string = created.json.upload.key;
  await env.ctx.storage.putStagingObject(key, new TextEncoder().encode(html));
  const completed = await call(env.app, "POST", `/reports/${id}/complete`, {
    user,
    body: { key },
  });
  return { created, completed, id, key };
}

/** upload + owner publish（公開まで通す） */
async function uploadPublished(
  env: ReturnType<typeof makeEnv>,
  user: string,
  title: string,
  html?: string,
) {
  const result = await upload(env, user, title, html);
  const published = await call(env.app, "POST", `/reports/${result.id}/publish`, { user });
  expect(published.status).toBe(200);
  return { ...result, published };
}

// =====================
// GET /config
// =====================

test("GET /config returns dev auth config and limits", async () => {
  const env = makeEnv();
  const res = await call(env.app, "GET", "/config");
  expect(res.status).toBe(200);
  expect(res.json.contentBaseUrl).toBe(BASE);
  expect(res.json.auth.mode).toBe("dev");
  expect(res.json.auth.users).toEqual(["alice", "bob", "admin"]);
  expect(res.json.limits.dailyUploadLimit).toBeGreaterThan(0);
  expect(res.json.limits.maxHtmlSizeBytes).toBeGreaterThan(0);
});

// =====================
// Auth guards
// =====================

test("authenticated routes reject unauthenticated callers with 401", async () => {
  const env = makeEnv();
  for (const [method, path] of [
    ["POST", "/reports"],
    ["GET", "/me/reports"],
    ["PATCH", "/reports/abc"],
    ["DELETE", "/reports/abc"],
  ] as const) {
    const res = await call(env.app, method, path, { body: {} });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("unauthorized");
  }
});

test("admin routes: 401 unauthenticated, 403 for non-admin, 200 for admin", async () => {
  const env = makeEnv();
  const unauth = await call(env.app, "GET", "/admin/reports");
  expect(unauth.status).toBe(401);
  const alice = await call(env.app, "GET", "/admin/reports", { user: "alice" });
  expect(alice.status).toBe(403);
  expect(alice.json.error.code).toBe("forbidden");
  const admin = await call(env.app, "GET", "/admin/reports", { user: "admin" });
  expect(admin.status).toBe(200);
  expect(admin.json.reports).toEqual([]);
});

test("unknown dev user is treated as unauthenticated", async () => {
  const env = makeEnv();
  const res = await call(env.app, "GET", "/me/reports", { user: "mallory" });
  expect(res.status).toBe(401);
});

// =====================
// Validation and error shape
// =====================

test("invalid JSON body → 400 bad_request; invalid fields → 400 validation_failed", async () => {
  const env = makeEnv();
  const badJson = await call(env.app, "POST", "/reports", { user: "alice", rawBody: "{nope" });
  expect(badJson.status).toBe(400);
  expect(badJson.json.error.code).toBe("bad_request");

  const badBody = await call(env.app, "POST", "/reports", {
    user: "alice",
    body: { title: "", kind: "html" },
  });
  expect(badBody.status).toBe(400);
  expect(badBody.json.error.code).toBe("validation_failed");
  expect(typeof badBody.json.error.message).toBe("string");
});

test("GET /search requires q", async () => {
  const env = makeEnv();
  const res = await call(env.app, "GET", "/search");
  expect(res.status).toBe(400);
  expect(res.json.error.code).toBe("validation_failed");
});

test("unknown route → 404 with error envelope", async () => {
  const env = makeEnv();
  const res = await call(env.app, "GET", "/nope");
  expect(res.status).toBe(404);
  expect(res.json.error.code).toBe("not_found");
});

// =====================
// Lifecycle: create → complete(pass, private) → publish → visible → authz on delete
// =====================

test("alice uploads (pass) → private; publish makes it public; bob can read but not delete", async () => {
  const env = makeEnv();
  const { completed, id } = await upload(env, "alice", "Quarterly Numbers");
  expect(completed.status).toBe(200);
  expect(completed.json.report.status).toBe("private");
  expect(completed.json.url).toBeUndefined();

  // Private: invisible to everyone but the owner/admin.
  expect((await call(env.app, "GET", "/reports")).json.reports).toHaveLength(0);
  expect((await call(env.app, "GET", `/reports/${id}`, { user: "bob" })).status).toBe(404);

  // bob cannot publish alice's report; alice can.
  expect((await call(env.app, "POST", `/reports/${id}/publish`, { user: "bob" })).status).toBe(403);
  const published = await call(env.app, "POST", `/reports/${id}/publish`, { user: "alice" });
  expect(published.status).toBe(200);
  expect(published.json.report.status).toBe("published");
  expect(published.json.url).toBe(`${BASE}/r/${id}/`);

  // Public list (unauthenticated) sees it, without private fields.
  const list = await call(env.app, "GET", "/reports");
  expect(list.status).toBe(200);
  expect(list.json.reports).toHaveLength(1);
  expect(list.json.reports[0].id).toBe(id);
  expect(list.json.reports[0].ownerSub).toBeUndefined();
  expect(list.json.reports[0].verdict).toBeUndefined();
  expect(list.json.reports[0].ownerName).toBe("Alice");

  // bob can read the published report.
  const asBob = await call(env.app, "GET", `/reports/${id}`, { user: "bob" });
  expect(asBob.status).toBe(200);
  expect(asBob.json.url).toBe(`${BASE}/r/${id}/`);

  // Search finds it.
  const search = await call(env.app, "GET", "/search?q=quarterly");
  expect(search.status).toBe(200);
  expect(search.json.results.map((r: any) => r.report.id)).toContain(id);

  // bob cannot delete or patch someone else's report.
  const bobDelete = await call(env.app, "DELETE", `/reports/${id}`, { user: "bob" });
  expect(bobDelete.status).toBe(403);
  const bobPatch = await call(env.app, "PATCH", `/reports/${id}`, {
    user: "bob",
    body: { title: "hijack" },
  });
  expect(bobPatch.status).toBe(403);

  // Owner can patch metadata.
  const patched = await call(env.app, "PATCH", `/reports/${id}`, {
    user: "alice",
    body: { title: "Quarterly Numbers v2" },
  });
  expect(patched.status).toBe(200);
  expect(patched.json.report.title).toBe("Quarterly Numbers v2");

  // Admin may delete anything.
  const adminDelete = await call(env.app, "DELETE", `/reports/${id}`, { user: "admin" });
  expect(adminDelete.status).toBe(200);
  expect(adminDelete.json.ok).toBe(true);
  const gone = await call(env.app, "GET", `/reports/${id}`);
  expect(gone.status).toBe(404);
});

test("non-published report: owner and admin see it, others get 404", async () => {
  const env = makeEnv();
  const created = await call(env.app, "POST", "/reports", {
    user: "alice",
    body: { title: "Draft", kind: "html" },
  });
  expect(created.status).toBe(201);
  const id = created.json.report.id;

  const unauth = await call(env.app, "GET", `/reports/${id}`);
  expect(unauth.status).toBe(404);
  const asBob = await call(env.app, "GET", `/reports/${id}`, { user: "bob" });
  expect(asBob.status).toBe(404);

  const asAlice = await call(env.app, "GET", `/reports/${id}`, { user: "alice" });
  expect(asAlice.status).toBe(200);
  expect(asAlice.json.report.status).toBe("private");
  expect(asAlice.json.url).toBeUndefined();

  const asAdmin = await call(env.app, "GET", `/reports/${id}`, { user: "admin" });
  expect(asAdmin.status).toBe(200);

  // Owner sees it in /me/reports while private.
  const mine = await call(env.app, "GET", "/me/reports", { user: "alice" });
  expect(mine.status).toBe(200);
  expect(mine.json.reports.map((r: any) => r.id)).toContain(id);
});

test("complete with an unknown key → 400", async () => {
  const env = makeEnv();
  const created = await call(env.app, "POST", "/reports", {
    user: "alice",
    body: { title: "Keyed", kind: "html" },
  });
  const res = await call(env.app, "POST", `/reports/${created.json.report.id}/complete`, {
    user: "alice",
    body: { key: "staging/forged/key" },
  });
  expect(res.status).toBe(400);
});

test("complete before the file is uploaded → 400 upload_incomplete", async () => {
  const env = makeEnv();
  const created = await call(env.app, "POST", "/reports", {
    user: "alice",
    body: { title: "Empty", kind: "html" },
  });
  const res = await call(env.app, "POST", `/reports/${created.json.report.id}/complete`, {
    user: "alice",
    body: { key: created.json.upload.key },
  });
  expect(res.status).toBe(400);
  expect(res.json.error.code).toBe("upload_incomplete");
});

// =====================
// Overwrite
// =====================

test("overwrite via upload-url bumps version and keeps a published report published", async () => {
  const env = makeEnv();
  const { id } = await uploadPublished(env, "alice", "Versioned");

  const urlRes = await call(env.app, "POST", `/reports/${id}/upload-url`, {
    user: "alice",
    body: { kind: "html" },
  });
  expect(urlRes.status).toBe(200);
  const key2: string = urlRes.json.upload.key;
  await env.ctx.storage.putStagingObject(
    key2,
    new TextEncoder().encode("<html><head><title>Versioned v2</title></head><body>updated</body></html>"),
  );
  const completed2 = await call(env.app, "POST", `/reports/${id}/complete`, {
    user: "alice",
    body: { key: key2 },
  });
  expect(completed2.status).toBe(200);
  expect(completed2.json.report.version).toBe(2);
  expect(completed2.json.report.status).toBe("published");

  // bob cannot request an upload URL for alice's report.
  const bobUrl = await call(env.app, "POST", `/reports/${id}/upload-url`, {
    user: "bob",
    body: { kind: "html" },
  });
  expect(bobUrl.status).toBe(403);
});

// =====================
// Daily upload quota
// =====================

test("daily upload quota → 429 rate_limited", async () => {
  const env = makeEnv({ dailyUploadLimit: 2 });
  const body = { title: "Quota", kind: "html" };
  expect((await call(env.app, "POST", "/reports", { user: "alice", body })).status).toBe(201);
  expect((await call(env.app, "POST", "/reports", { user: "alice", body })).status).toBe(201);
  const third = await call(env.app, "POST", "/reports", { user: "alice", body });
  expect(third.status).toBe(429);
  expect(third.json.error.code).toBe("rate_limited");
  // Other users have their own quota.
  expect((await call(env.app, "POST", "/reports", { user: "bob", body })).status).toBe(201);
});

// =====================
// Flags (unauthenticated, rate limited per IP)
// =====================

test("flag: works unauthenticated on published reports, rate limited per IP, admin can list", async () => {
  const env = makeEnv();
  const { id } = await uploadPublished(env, "alice", "Flag Target");

  const ok = await call(env.app, "POST", `/reports/${id}/flag`, {
    body: { reason: "looks suspicious" },
    ip: "10.0.0.1",
  });
  expect(ok.status).toBe(200);
  expect(ok.json.ok).toBe(true);

  // Flags are admin-only to read.
  const asAlice = await call(env.app, "GET", `/admin/reports/${id}/flags`, { user: "alice" });
  expect(asAlice.status).toBe(403);
  const flags = await call(env.app, "GET", `/admin/reports/${id}/flags`, { user: "admin" });
  expect(flags.status).toBe(200);
  expect(flags.json.flags).toHaveLength(1);
  expect(flags.json.flags[0].reason).toBe("looks suspicious");
  expect(flags.json.flags[0].sourceIp).toBe("10.0.0.1");

  // Same IP is limited after FLAG_RATE_LIMIT calls (one consumed above).
  for (let i = 1; i < FLAG_RATE_LIMIT; i++) {
    const res = await call(env.app, "POST", `/reports/${id}/flag`, {
      body: { reason: `spam ${i}` },
      ip: "10.0.0.1",
    });
    expect(res.status).toBe(200);
  }
  const limited = await call(env.app, "POST", `/reports/${id}/flag`, {
    body: { reason: "over the line" },
    ip: "10.0.0.1",
  });
  expect(limited.status).toBe(429);
  expect(limited.json.error.code).toBe("rate_limited");

  // A different IP still may flag.
  const otherIp = await call(env.app, "POST", `/reports/${id}/flag`, {
    body: { reason: "from elsewhere" },
    ip: "10.0.0.2",
  });
  expect(otherIp.status).toBe(200);
});

test("AZ-1: spoofing the leftmost X-Forwarded-For entry cannot bypass the flag limiter", async () => {
  const env = makeEnv();
  const { id } = await uploadPublished(env, "alice", "XFF Spoof Target");

  // CloudFront/API Gateway append the real viewer IP, so the trusted client IP
  // is the RIGHTMOST entry. An attacker rotating the leftmost value on each
  // request must still be keyed by the same trusted 203.0.113.7 and get limited.
  for (let i = 0; i < FLAG_RATE_LIMIT; i++) {
    const res = await call(env.app, "POST", `/reports/${id}/flag`, {
      body: { reason: `spoof ${i}` },
      ip: `10.0.0.${i}, 203.0.113.7`,
    });
    expect(res.status).toBe(200);
  }
  const limited = await call(env.app, "POST", `/reports/${id}/flag`, {
    body: { reason: "still spoofing" },
    ip: "10.0.0.99, 203.0.113.7",
  });
  expect(limited.status).toBe(429);

  // The persisted audit sourceIp is the trusted rightmost value, not the spoof.
  const flags = await call(env.app, "GET", `/admin/reports/${id}/flags`, { user: "admin" });
  expect(flags.json.flags.every((f: { sourceIp?: string }) => f.sourceIp === "203.0.113.7")).toBe(
    true,
  );
});

test("flag on a non-published report → 404", async () => {
  const env = makeEnv();
  const created = await call(env.app, "POST", "/reports", {
    user: "alice",
    body: { title: "Not Yet", kind: "html" },
  });
  const res = await call(env.app, "POST", `/reports/${created.json.report.id}/flag`, {
    body: { reason: "premature" },
    ip: "10.9.9.9",
  });
  expect(res.status).toBe(404);
});

// =====================
// Publish / unpublish (owner-controlled visibility)
// =====================

test("unpublish hides a published report; owner keeps access and can republish", async () => {
  const env = makeEnv();
  const { id } = await uploadPublished(env, "alice", "Toggle Target");

  // bob cannot unpublish.
  expect((await call(env.app, "POST", `/reports/${id}/unpublish`, { user: "bob" })).status).toBe(403);

  const hidden = await call(env.app, "POST", `/reports/${id}/unpublish`, { user: "alice" });
  expect(hidden.status).toBe(200);
  expect(hidden.json.report.status).toBe("private");

  expect((await call(env.app, "GET", `/reports/${id}`)).status).toBe(404);
  expect((await call(env.app, "GET", "/reports")).json.reports).toHaveLength(0);

  // Owner still reads it and its source; others cannot.
  const owner = await call(env.app, "GET", `/reports/${id}`, { user: "alice" });
  expect(owner.status).toBe(200);
  const source = await call(env.app, "GET", `/reports/${id}/source`, { user: "alice" });
  expect(source.status).toBe(200);
  expect(source.json.kind).toBe("html");
  expect(source.json.html).toContain("Toggle Target");
  expect((await call(env.app, "GET", `/reports/${id}/source`, { user: "bob" })).status).toBe(403);
  expect((await call(env.app, "GET", `/reports/${id}/source`)).status).toBe(401);

  // Republish restores the public URL.
  const again = await call(env.app, "POST", `/reports/${id}/publish`, { user: "alice" });
  expect(again.status).toBe(200);
  expect(again.json.url).toBe(`${BASE}/r/${id}/`);
});

// =====================
// Direct HTML edit
// =====================

test("PUT /reports/:id/content re-scans and updates in place", async () => {
  const env = makeEnv();
  const { id } = await uploadPublished(env, "alice", "Editable");

  const edited = await call(env.app, "PUT", `/reports/${id}/content`, {
    user: "alice",
    body: { html: "<html><head><title>Editable v2</title></head><body>edited body</body></html>" },
  });
  expect(edited.status).toBe(200);
  expect(edited.json.report.version).toBe(2);
  expect(edited.json.report.status).toBe("published");
  expect(edited.json.url).toBe(`${BASE}/r/${id}/`);

  const source = await call(env.app, "GET", `/reports/${id}/source`, { user: "alice" });
  expect(source.json.html).toContain("edited body");

  // Non-owner cannot edit; empty body fails validation.
  expect(
    (await call(env.app, "PUT", `/reports/${id}/content`, { user: "bob", body: { html: "<p>x</p>" } }))
      .status,
  ).toBe(403);
  expect(
    (await call(env.app, "PUT", `/reports/${id}/content`, { user: "alice", body: { html: "" } }))
      .status,
  ).toBe(400);

  // Blocked edit rejects the report.
  env.scanner.next = {
    verdict: "block",
    findings: [{ ruleId: "eval-atob", severity: "block", message: "decode-and-execute chain" }],
  };
  const blocked = await call(env.app, "PUT", `/reports/${id}/content`, {
    user: "alice",
    body: { html: "<html><body>bad</body></html>" },
  });
  expect(blocked.status).toBe(200);
  expect(blocked.json.report.status).toBe("rejected");
  expect((await call(env.app, "GET", `/reports/${id}`)).status).toBe(404);
});

test("warn verdict → private with findings; owner can publish without admin approval", async () => {
  const env = makeEnv();
  env.scanner.next = {
    verdict: "warn",
    findings: [{ ruleId: "external-form", severity: "warn", message: "form posts externally" }],
  };
  const { completed, id } = await upload(env, "alice", "Warned Report");
  expect(completed.status).toBe(200);
  expect(completed.json.report.status).toBe("private");
  expect(completed.json.url).toBeUndefined();
  expect(completed.json.report.findings).toHaveLength(1);

  // Not publicly visible while private.
  expect((await call(env.app, "GET", `/reports/${id}`)).status).toBe(404);
  expect((await call(env.app, "GET", `/reports/${id}`, { user: "bob" })).status).toBe(404);

  // Owner publishes it themselves — no admin gate.
  const published = await call(env.app, "POST", `/reports/${id}/publish`, { user: "alice" });
  expect(published.status).toBe(200);
  expect(published.json.report.status).toBe("published");
  expect(published.json.report.verdict).toBe("warn");

  const pub = await call(env.app, "GET", `/reports/${id}`);
  expect(pub.status).toBe(200);
  expect(pub.json.url).toBe(`${BASE}/r/${id}/`);
});

test("block verdict → rejected immediately, findings visible to owner", async () => {
  const env = makeEnv();
  env.scanner.next = {
    verdict: "block",
    findings: [{ ruleId: "eval-atob", severity: "block", message: "decode-and-execute chain" }],
  };
  const { completed, id } = await upload(env, "alice", "Malicious");
  expect(completed.status).toBe(200);
  expect(completed.json.report.status).toBe("rejected");
  expect(completed.json.url).toBeUndefined();

  expect((await call(env.app, "GET", `/reports/${id}`)).status).toBe(404);
  const owner = await call(env.app, "GET", `/reports/${id}`, { user: "alice" });
  expect(owner.json.report.status).toBe("rejected");
  // Scan outcome is exposed to the owner via /me/reports (OwnedReport shape);
  // GET /reports/:id keeps the public shape per GetReportResponseSchema.
  const mine = await call(env.app, "GET", "/me/reports", { user: "alice" });
  const owned = mine.json.reports.find((r: any) => r.id === id);
  expect(owned.verdict).toBe("block");
  expect(owned.findings[0].ruleId).toBe("eval-atob");
  // Not in the public list or search.
  const list = await call(env.app, "GET", "/reports");
  expect(list.json.reports).toHaveLength(0);
});

// =====================
// Admin takedown
// =====================

test("admin takedown unpublishes and blocks owner re-upload", async () => {
  const env = makeEnv();
  const { id } = await uploadPublished(env, "alice", "Taken Down");

  const takedown = await call(env.app, "POST", `/admin/reports/${id}/takedown`, { user: "admin" });
  expect(takedown.status).toBe(200);
  expect(takedown.json.report.status).toBe("takedown");

  expect((await call(env.app, "GET", `/reports/${id}`)).status).toBe(404);
  const search = await call(env.app, "GET", "/search?q=taken");
  expect(search.json.results).toHaveLength(0);

  const ownerRetry = await call(env.app, "POST", `/reports/${id}/upload-url`, {
    user: "alice",
    body: { kind: "html" },
  });
  expect(ownerRetry.status).toBe(403);
  // 再公開もソース閲覧も不可
  expect((await call(env.app, "POST", `/reports/${id}/publish`, { user: "alice" })).status).toBe(403);
  expect((await call(env.app, "GET", `/reports/${id}/source`, { user: "alice" })).status).toBe(403);
});

// =====================
// Admin 通報一覧
// =====================

test("GET /admin/flagged lists flagged reports; DELETE .../flags resolves them", async () => {
  const env = makeEnv();
  const { id } = await uploadPublished(env, "alice", "Flagged Once");
  await call(env.app, "POST", `/reports/${id}/flag`, {
    body: { reason: "見た目が怪しい" },
    ip: "10.1.1.1",
  });

  expect((await call(env.app, "GET", "/admin/flagged", { user: "alice" })).status).toBe(403);
  const flagged = await call(env.app, "GET", "/admin/flagged", { user: "admin" });
  expect(flagged.status).toBe(200);
  expect(flagged.json.items).toHaveLength(1);
  expect(flagged.json.items[0].report.id).toBe(id);
  expect(flagged.json.items[0].flags[0].reason).toBe("見た目が怪しい");

  expect((await call(env.app, "DELETE", `/admin/reports/${id}/flags`, { user: "alice" })).status).toBe(403);
  const cleared = await call(env.app, "DELETE", `/admin/reports/${id}/flags`, { user: "admin" });
  expect(cleared.status).toBe(200);
  expect(cleared.json.ok).toBe(true);
  expect((await call(env.app, "GET", "/admin/flagged", { user: "admin" })).json.items).toHaveLength(0);
});

// =====================
// Admin users
// =====================

test("admin user management: list, grant, revoke, unknown user 404", async () => {
  const env = makeEnv();
  const list = await call(env.app, "GET", "/admin/users", { user: "admin" });
  expect(list.status).toBe(200);
  expect(list.json.users.map((u: any) => u.username).sort()).toEqual(["admin", "alice", "bob"]);

  const grant = await call(env.app, "PUT", "/admin/users/bob/admin", { user: "admin" });
  expect(grant.status).toBe(200);
  const after = await call(env.app, "GET", "/admin/users", { user: "admin" });
  expect(after.json.users.find((u: any) => u.username === "bob").isAdmin).toBe(true);

  const revoke = await call(env.app, "DELETE", "/admin/users/bob/admin", { user: "admin" });
  expect(revoke.status).toBe(200);
  const after2 = await call(env.app, "GET", "/admin/users", { user: "admin" });
  expect(after2.json.users.find((u: any) => u.username === "bob").isAdmin).toBe(false);

  const unknown = await call(env.app, "PUT", "/admin/users/mallory/admin", { user: "admin" });
  expect(unknown.status).toBe(404);
  expect(unknown.json.error.code).toBe("not_found");
});
