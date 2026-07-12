/**
 * /me/api-keys の integration テスト — 発行（平文は 201 レスポンス限り）/
 * 一覧（平文なし）/ 失効 / 上限 / 認可。
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_API_KEYS_PER_USER } from "@hrb/shared";
import { API_KEY_PREFIX } from "@hrb/core";
import { createLocalContext, DEV_USER_HEADER } from "@hrb/core/local";
import { createApp } from "./app.ts";
import type { AppType } from "./app.ts";

const BASE = "http://localhost:3000";
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "hrb-api-keys-test-"));
  tempDirs.push(dir);
  const ctx = createLocalContext({ dataDir: dir, contentBaseUrl: BASE });
  const app = createApp({
    service: ctx.service,
    auth: ctx.auth,
    apiKeys: ctx.apiKeys,
    userAdmin: ctx.userAdmin,
    contentBaseUrl: BASE,
  });
  return { ctx, app };
}

async function call(
  app: AppType,
  method: string,
  path: string,
  opts: { user?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.user) headers[DEV_USER_HEADER] = opts.user;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await app.request(`/api${path}`, init);
  return { status: res.status, json: await res.json() };
}

test("発行は 201 で平文を一度だけ返し、一覧には平文が現れない", async () => {
  const { app } = makeEnv();
  const created = await call(app, "POST", "/me/api-keys", { user: "alice", body: { name: "CI" } });
  expect(created.status).toBe(201);
  expect(created.json.plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
  expect(created.json.key.name).toBe("CI");
  expect(created.json.plaintext.startsWith(created.json.key.prefix)).toBe(true);

  const listed = await call(app, "GET", "/me/api-keys", { user: "alice" });
  expect(listed.status).toBe(200);
  expect(listed.json.keys.length).toBe(1);
  expect(listed.json.keys[0].keyId).toBe(created.json.key.keyId);
  expect(JSON.stringify(listed.json)).not.toContain(created.json.plaintext);
  // ハッシュも露出しない
  expect(Object.keys(listed.json.keys[0]).sort()).toEqual([
    "createdAt",
    "keyId",
    "name",
    "prefix",
  ]);
});

test("一覧は自分のキーのみ", async () => {
  const { app } = makeEnv();
  await call(app, "POST", "/me/api-keys", { user: "alice", body: { name: "alice-key" } });
  await call(app, "POST", "/me/api-keys", { user: "bob", body: { name: "bob-key" } });
  const listed = await call(app, "GET", "/me/api-keys", { user: "bob" });
  expect(listed.json.keys.map((k: any) => k.name)).toEqual(["bob-key"]);
});

test("失効で一覧から消え、他人のキーは失効できない（404）", async () => {
  const { app } = makeEnv();
  const created = await call(app, "POST", "/me/api-keys", { user: "alice", body: { name: "x" } });
  const keyId = created.json.key.keyId;

  const stranger = await call(app, "DELETE", `/me/api-keys/${keyId}`, { user: "bob" });
  expect(stranger.status).toBe(404);
  expect(stranger.json.error.code).toBe("not_found");

  const revoked = await call(app, "DELETE", `/me/api-keys/${keyId}`, { user: "alice" });
  expect(revoked.status).toBe(200);
  expect((await call(app, "GET", "/me/api-keys", { user: "alice" })).json.keys).toEqual([]);
});

test(`上限 ${MAX_API_KEYS_PER_USER} 本を超える発行は conflict`, async () => {
  const { app } = makeEnv();
  for (let i = 0; i < MAX_API_KEYS_PER_USER; i++) {
    const res = await call(app, "POST", "/me/api-keys", { user: "alice", body: { name: `k${i}` } });
    expect(res.status).toBe(201);
  }
  const over = await call(app, "POST", "/me/api-keys", { user: "alice", body: { name: "over" } });
  expect(over.status).toBe(409);
  expect(over.json.error.code).toBe("conflict");
  // 別ユーザーの上限には影響しない
  expect((await call(app, "POST", "/me/api-keys", { user: "bob", body: { name: "b" } })).status).toBe(201);
});

test("未認証は 401、name 不正は 400", async () => {
  const { app } = makeEnv();
  expect((await call(app, "GET", "/me/api-keys")).status).toBe(401);
  expect((await call(app, "POST", "/me/api-keys", { body: { name: "x" } })).status).toBe(401);
  expect((await call(app, "DELETE", "/me/api-keys/abc")).status).toBe(401);
  const bad = await call(app, "POST", "/me/api-keys", { user: "alice", body: { name: "" } });
  expect(bad.status).toBe(400);
  expect(bad.json.error.code).toBe("validation_failed");
});
