/**
 * /api/auth/* — google-mode login/logout routes. The Google ID token
 * verification is faked; everything below it (session store, verify
 * middleware) is real (temp dataDir).
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalContext } from "@hrb/core/local";
import { createApp } from "./app.ts";

const BASE = "http://localhost:3000";
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeGoogleApp() {
  const dir = mkdtempSync(join(tmpdir(), "hrb-auth-routes-"));
  tempDirs.push(dir);
  const ctx = createLocalContext({
    dataDir: dir,
    contentBaseUrl: BASE,
    googleAuth: {
      clientId: "test-client-id",
      adminEmails: ["boss@example.com"],
      verifyIdToken: async (credential) => {
        if (credential !== "good-credential") throw new Error("bad token");
        return {
          sub: "google-carol",
          email: "carol@example.com",
          email_verified: true,
          name: "Carol",
          picture: "https://lh3.example/carol.png",
        };
      },
    },
  });
  const app = createApp({
    service: ctx.service,
    auth: ctx.auth,
    ...(ctx.sessionAuth ? { sessionAuth: ctx.sessionAuth } : {}),
    userAdmin: ctx.userAdmin,
    contentBaseUrl: BASE,
  });
  return app;
}

test("google login issues a session usable as a Bearer token", async () => {
  const app = makeGoogleApp();
  const res = await app.request("/api/auth/google", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "good-credential" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; user: { email: string; isAdmin: boolean } };
  expect(body.user.email).toBe("carol@example.com");
  expect(body.user.isAdmin).toBe(false);

  const me = await app.request("/api/me/reports", {
    headers: { authorization: `Bearer ${body.token}` },
  });
  expect(me.status).toBe(200);
});

test("google login rejects a bad credential with 401", async () => {
  const app = makeGoogleApp();
  const res = await app.request("/api/auth/google", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "forged" }),
  });
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("unauthorized");
});

test("logout revokes the session", async () => {
  const app = makeGoogleApp();
  const login = await app.request("/api/auth/google", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "good-credential" }),
  });
  const { token } = (await login.json()) as { token: string };

  const out = await app.request("/api/auth/logout", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(out.status).toBe(200);

  const me = await app.request("/api/me/reports", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(me.status).toBe(401);
});

test("auth routes are not mounted in dev mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hrb-auth-routes-dev-"));
  tempDirs.push(dir);
  const ctx = createLocalContext({ dataDir: dir, contentBaseUrl: BASE });
  const app = createApp({
    service: ctx.service,
    auth: ctx.auth,
    userAdmin: ctx.userAdmin,
    contentBaseUrl: BASE,
  });
  const res = await app.request("/api/auth/google", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "x" }),
  });
  expect(res.status).toBe(404);
});
