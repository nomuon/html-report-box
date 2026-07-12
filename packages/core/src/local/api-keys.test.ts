/**
 * LocalApiKeyStore — issue / list / revoke / verify と「保存は sha256 ハッシュ
 * のみ（平文は永続化されない）」の検証。
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_KEY_PREFIX, hashApiKey } from "../api-keys.ts";
import { DomainError } from "../errors.ts";
import { LocalApiKeyStore } from "./api-keys.ts";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeStore(now?: () => Date): { store: LocalApiKeyStore; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "hrb-apikeys-test-"));
  tempDirs.push(dataDir);
  return { store: new LocalApiKeyStore(dataDir, now ? { now } : {}), dataDir };
}

const alice = { sub: "dev-alice", name: "Alice" };
const bob = { sub: "dev-bob", name: "Bob" };

test("issue returns a hrb_ plaintext once and metadata without secrets", async () => {
  const { store } = makeStore();
  const { key, plaintext } = await store.issue(alice, "CI キー");
  expect(plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
  // "hrb_" + base64url(32 bytes) = 4 + 43 chars
  expect(plaintext.length).toBeGreaterThanOrEqual(40);
  expect(key.name).toBe("CI キー");
  expect(plaintext.startsWith(key.prefix)).toBe(true);
  expect(key.prefix.length).toBeLessThan(plaintext.length);
  expect(JSON.stringify(key)).not.toContain(plaintext);
});

test("only the sha256 hash is persisted, never the plaintext", async () => {
  const { store, dataDir } = makeStore();
  const { plaintext } = await store.issue(alice, "secret check");
  const raw = readFileSync(join(dataDir, "api-keys.json"), "utf8");
  expect(raw).not.toContain(plaintext);
  expect(raw).toContain(hashApiKey(plaintext));
});

test("verify resolves the owner and updates lastUsedAt", async () => {
  let tick = Date.parse("2026-07-01T00:00:00.000Z");
  const { store } = makeStore(() => new Date((tick += 1000)));
  const { key, plaintext } = await store.issue(alice, "mcp");
  const verified = await store.verify(plaintext);
  expect(verified).toEqual({ ownerSub: alice.sub, ownerName: alice.name, keyId: key.keyId });
  const [listed] = await store.list(alice.sub);
  expect(listed?.lastUsedAt).toBeDefined();
  expect(listed!.lastUsedAt! > listed!.createdAt).toBe(true);
});

test("verify returns null for unknown or tampered keys", async () => {
  const { store } = makeStore();
  await store.issue(alice, "a");
  expect(await store.verify("hrb_totally-unknown-key")).toBeNull();
  expect(await store.verify("")).toBeNull();
});

test("list returns only the owner's keys, newest first", async () => {
  let tick = Date.parse("2026-07-01T00:00:00.000Z");
  const { store } = makeStore(() => new Date((tick += 1000)));
  const first = await store.issue(alice, "first");
  await store.issue(bob, "bobs");
  const second = await store.issue(alice, "second");
  const keys = await store.list(alice.sub);
  expect(keys.map((k) => k.keyId)).toEqual([second.key.keyId, first.key.keyId]);
  expect(keys.map((k) => k.name)).toEqual(["second", "first"]);
});

test("revoke removes the key; verify fails afterwards", async () => {
  const { store } = makeStore();
  const { key, plaintext } = await store.issue(alice, "to revoke");
  await store.revoke(alice.sub, key.keyId);
  expect(await store.list(alice.sub)).toEqual([]);
  expect(await store.verify(plaintext)).toBeNull();
});

test("revoke of another owner's key (or unknown id) is not_found", async () => {
  const { store } = makeStore();
  const { key, plaintext } = await store.issue(alice, "mine");
  expect(store.revoke(bob.sub, key.keyId)).rejects.toThrow(DomainError);
  expect(store.revoke(alice.sub, "no-such-key")).rejects.toThrow(DomainError);
  // 失敗した revoke はキーを消していない
  expect(await store.verify(plaintext)).not.toBeNull();
});
