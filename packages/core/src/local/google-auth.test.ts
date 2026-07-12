/**
 * GoogleAuthVerifier — login provisioning, session verify/logout/expiry,
 * admin allowlist, dev-header fallback, and the UserAdmin view. The Google
 * ID token verification itself is faked (network-free).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDomainError } from "../errors.ts";
import { GoogleAuthVerifier } from "./google-auth.ts";
import type { GoogleIdTokenPayload } from "./google-auth.ts";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeVerifier(opts: {
  payloads?: Record<string, GoogleIdTokenPayload>;
  adminEmails?: string[];
  allowDevHeader?: boolean;
  now?: () => Date;
  dataDir?: string;
} = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "hrb-google-auth-"));
  if (!opts.dataDir) tempDirs.push(dataDir);
  const verifier = new GoogleAuthVerifier({
    clientId: "test-client-id",
    dataDir,
    ...(opts.adminEmails ? { adminEmails: opts.adminEmails } : {}),
    ...(opts.allowDevHeader !== undefined ? { allowDevHeader: opts.allowDevHeader } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    verifyIdToken: async (credential) => {
      const payload = opts.payloads?.[credential];
      if (!payload) throw new Error("bad token");
      return payload;
    },
  });
  return { verifier, dataDir };
}

const ALICE: GoogleIdTokenPayload = {
  sub: "google-alice",
  email: "Alice@Example.com",
  email_verified: true,
  name: "Alice Example",
  picture: "https://lh3.example/alice.png",
};

describe("GoogleAuthVerifier.loginWithGoogle", () => {
  test("provisions the user on first login and returns a working session", async () => {
    const { verifier } = makeVerifier({ payloads: { good: ALICE } });
    const { token, user } = await verifier.loginWithGoogle("good");
    expect(user).toEqual({
      sub: "google-alice",
      name: "Alice Example",
      email: "alice@example.com",
      picture: "https://lh3.example/alice.png",
      isAdmin: false,
    });
    const verified = await verifier.verify({ authorization: `Bearer ${token}` });
    expect(verified).toEqual({ sub: "google-alice", name: "Alice Example", isAdmin: false });
  });

  test("rejects an invalid credential with unauthorized", async () => {
    const { verifier } = makeVerifier();
    const err: unknown = await verifier.loginWithGoogle("nope").catch((e: unknown) => e);
    expect(isDomainError(err) && err.code === "unauthorized").toBe(true);
  });

  test("rejects unverified emails", async () => {
    const { verifier } = makeVerifier({
      payloads: { bad: { ...ALICE, email_verified: false } },
    });
    const err: unknown = await verifier.loginWithGoogle("bad").catch((e: unknown) => e);
    expect(isDomainError(err) && err.code === "unauthorized").toBe(true);
  });

  test("admin allowlist grants isAdmin (case-insensitive)", async () => {
    const { verifier } = makeVerifier({
      payloads: { good: ALICE },
      adminEmails: ["ALICE@example.com"],
    });
    const { user } = await verifier.loginWithGoogle("good");
    expect(user.isAdmin).toBe(true);
  });

  test("sessions persist across instances (same dataDir)", async () => {
    const { verifier, dataDir } = makeVerifier({ payloads: { good: ALICE } });
    const { token } = await verifier.loginWithGoogle("good");
    const { verifier: reopened } = makeVerifier({ dataDir });
    const verified = await reopened.verify({ authorization: `Bearer ${token}` });
    expect(verified?.sub).toBe("google-alice");
  });
});

describe("GoogleAuthVerifier.verify", () => {
  test("logout revokes the session", async () => {
    const { verifier } = makeVerifier({ payloads: { good: ALICE } });
    const { token } = await verifier.loginWithGoogle("good");
    await verifier.logout(token);
    expect(await verifier.verify({ authorization: `Bearer ${token}` })).toBeNull();
  });

  test("expired sessions are rejected", async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00Z");
    const { verifier } = makeVerifier({
      payloads: { good: ALICE },
      now: () => new Date(nowMs),
    });
    const { token } = await verifier.loginWithGoogle("good");
    nowMs += 31 * 24 * 60 * 60 * 1000; // past the 30-day TTL
    expect(await verifier.verify({ authorization: `Bearer ${token}` })).toBeNull();
  });

  test("unknown bearer tokens and missing headers return null", async () => {
    const { verifier } = makeVerifier();
    expect(await verifier.verify({ authorization: "Bearer bogus" })).toBeNull();
    expect(await verifier.verify({})).toBeNull();
  });

  test("dev header fallback keeps local curl/seed flows working", async () => {
    const { verifier } = makeVerifier();
    const user = await verifier.verify({ "x-dev-user": "admin" });
    expect(user).toEqual({ sub: "dev-admin", name: "Admin", isAdmin: true });
  });

  test("allowDevHeader=false（vps）では dev header を無視する", async () => {
    const { verifier } = makeVerifier({ allowDevHeader: false });
    expect(await verifier.verify({ "x-dev-user": "admin" })).toBeNull();
  });

  test("authConfig advertises google mode with the client id", () => {
    const { verifier } = makeVerifier();
    expect(verifier.authConfig()).toEqual({ mode: "google", clientId: "test-client-id" });
  });
});

describe("GoogleAuthVerifier.userAdmin", () => {
  test("lists provisioned users, toggles admin persistently, deletes with session cascade", async () => {
    const { verifier } = makeVerifier({
      payloads: {
        a: ALICE,
        b: { sub: "google-bob", email: "bob@example.com", email_verified: true, name: "Bob" },
      },
    });
    await verifier.loginWithGoogle("a");
    const { token: bobToken } = await verifier.loginWithGoogle("b");
    const admin = verifier.userAdmin();

    const { items } = await admin.listUsers();
    expect(items.map((u) => u.username)).toEqual(["alice@example.com", "bob@example.com"]);

    await admin.setAdmin("bob@example.com", true);
    // A setAdmin() grant survives re-login.
    const { user: bobAgain } = await verifier.loginWithGoogle("b");
    expect(bobAgain.isAdmin).toBe(true);

    expect(await admin.getUserSub("alice@example.com")).toBe("google-alice");
    expect(await admin.getUserSub("ghost@example.com")).toBeNull();

    await admin.deleteUser("bob@example.com");
    expect(await verifier.verify({ authorization: `Bearer ${bobToken}` })).toBeNull();
    const err: unknown = await admin.setAdmin("bob@example.com", true).catch((e: unknown) => e);
    expect(isDomainError(err) && err.code === "not_found").toBe(true);
  });
});
