/**
 * ReportRepository 共通契約スイート。
 *
 * プロダクションコードから import してはならない。ports.ts の
 * `ReportRepository` 契約を検証するアダプタ非依存の共通スイートで、
 * 新アダプタ（将来の Cloudflare 等）の受け入れ基準となる。
 *
 * 許可 import: ../ports.ts の型・@hrb/shared の型・bun:test のみ。
 * 特定アダプタ（local/ や aws/）へ依存してはならない。
 */
import { describe, expect, test } from "bun:test";
import type { ReportMeta } from "@hrb/shared";
import type { Page, PageOptions, ReportFlag, ReportRepository } from "../ports.ts";

/** 各 test ごとに空の新インスタンスを返す factory（テスト間の状態共有を避ける）。 */
export type RepositoryFactory = () => ReportRepository | Promise<ReportRepository>;

/** [A-Za-z0-9_-]{21} の有効な report id を seed から決定的に作る。 */
function rid(seed: string): string {
  const base = seed.replace(/[^A-Za-z0-9_-]/g, "-");
  return `${base}${"0".repeat(21)}`.slice(0, 21);
}

function makeMeta(id: string, over: Partial<ReportMeta> = {}): ReportMeta {
  return {
    id,
    title: "タイトル",
    description: "",
    tags: [],
    ownerSub: "user-alice",
    ownerName: "Alice",
    status: "private",
    kind: "html",
    version: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    findings: [],
    versions: [],
    ...over,
  };
}

function makeFlag(over: Partial<ReportFlag> = {}): ReportFlag {
  return { reason: "スパム", createdAt: "2026-07-02T00:00:00.000Z", ...over };
}

/** DomainError（構造的に {code, httpStatus} を持つ）を投げたことと code を検証する。 */
async function expectDomainError(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    expect(typeof (err as { httpStatus?: number }).httpStatus).toBe("number");
    return;
  }
  throw new Error(`expected a DomainError(${code}) to be thrown`);
}

/** cursor を辿ってページを全消費し、全 item を連結して返す。 */
async function drain(
  fetch: (opts: PageOptions) => Promise<Page<ReportMeta>>,
  limit: number,
): Promise<ReportMeta[]> {
  const out: ReportMeta[] = [];
  let cursor: string | undefined;
  // 無限ループ保険（想定件数を大きく超えたら異常）。
  for (let guard = 0; guard < 100; guard++) {
    const page: Page<ReportMeta> = await fetch({ limit, ...(cursor ? { cursor } : {}) });
    out.push(...page.items);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

export function runRepositoryConformance(name: string, factory: RepositoryFactory): void {
  describe(`ReportRepository conformance: ${name}`, () => {
    test("create then get roundtrips; get/getMany return null/absent for unknown ids", async () => {
      const repo = await factory();
      const meta = makeMeta(rid("get"));
      await repo.create(meta);

      expect(await repo.get(meta.id)).toEqual(meta);
      expect(await repo.get(rid("missing"))).toBeNull();

      const many = await repo.getMany([meta.id, rid("missing")]);
      expect(many.size).toBe(1);
      expect(many.get(meta.id)).toEqual(meta);
      expect(many.has(rid("missing"))).toBe(false);
    });

    test("create rejects a duplicate id with a conflict DomainError", async () => {
      const repo = await factory();
      const meta = makeMeta(rid("dup"));
      await repo.create(meta);
      await expectDomainError(() => repo.create(makeMeta(meta.id)), "conflict");
    });

    test("update replaces an existing record; update of a missing id throws", async () => {
      const repo = await factory();
      const meta = makeMeta(rid("upd"));
      await repo.create(meta);

      const changed = makeMeta(meta.id, { title: "更新後", version: 2 });
      await repo.update(changed);
      expect(await repo.get(meta.id)).toEqual(changed);

      await expectDomainError(
        () => repo.update(makeMeta(rid("ghost"))),
        "not_found",
      );
    });

    test("listPublished returns only published, updatedAt descending, paginated by cursor", async () => {
      const repo = await factory();
      // updatedAt が新しい順に p3 > p2 > p1。private/rejected は除外される。
      await repo.create(makeMeta(rid("p1"), { status: "published", updatedAt: "2026-07-01T00:00:00.000Z" }));
      await repo.create(makeMeta(rid("p2"), { status: "published", updatedAt: "2026-07-02T00:00:00.000Z" }));
      await repo.create(makeMeta(rid("p3"), { status: "published", updatedAt: "2026-07-03T00:00:00.000Z" }));
      await repo.create(makeMeta(rid("x1"), { status: "private", updatedAt: "2026-07-09T00:00:00.000Z" }));
      await repo.create(makeMeta(rid("x2"), { status: "rejected", updatedAt: "2026-07-09T00:00:00.000Z" }));

      const first = await repo.listPublished({ limit: 2 });
      expect(first.items.map((m) => m.id)).toEqual([rid("p3"), rid("p2")]);
      expect(first.nextCursor).toBeDefined();

      const all = await drain((opts) => repo.listPublished(opts), 2);
      expect(all.map((m) => m.id)).toEqual([rid("p3"), rid("p2"), rid("p1")]);
      expect(all.every((m) => m.status === "published")).toBe(true);
    });

    test("listPublished supports order=asc and a kind filter", async () => {
      const repo = await factory();
      await repo.create(makeMeta(rid("k1"), { status: "published", kind: "html", updatedAt: "2026-07-01T00:00:00.000Z" }));
      await repo.create(makeMeta(rid("k2"), { status: "published", kind: "zip", updatedAt: "2026-07-02T00:00:00.000Z" }));
      await repo.create(makeMeta(rid("k3"), { status: "published", kind: "html", updatedAt: "2026-07-03T00:00:00.000Z" }));

      // order=asc は updatedAt 昇順（古い順）。
      const asc = await drain((opts) => repo.listPublished({ ...opts, order: "asc" }), 2);
      expect(asc.map((m) => m.id)).toEqual([rid("k1"), rid("k2"), rid("k3")]);

      // kind フィルタは指定 kind のみ返す（ページをまたいでも正確）。
      const zipOnly = await drain((opts) => repo.listPublished({ ...opts, kind: "zip" }), 2);
      expect(zipOnly.map((m) => m.id)).toEqual([rid("k2")]);

      const htmlAsc = await drain(
        (opts) => repo.listPublished({ ...opts, kind: "html", order: "asc" }),
        2,
      );
      expect(htmlAsc.map((m) => m.id)).toEqual([rid("k1"), rid("k3")]);
    });

    test("listPublished supports a single exact tag filter", async () => {
      const repo = await factory();
      await repo.create(makeMeta(rid("t1"), { status: "published", tags: ["月次", "営業"], updatedAt: "2026-07-01T00:00:00.000Z" }));
      await repo.create(makeMeta(rid("t2"), { status: "published", tags: ["週次"], updatedAt: "2026-07-02T00:00:00.000Z" }));
      await repo.create(makeMeta(rid("t3"), { status: "published", updatedAt: "2026-07-03T00:00:00.000Z" }));
      await repo.create(makeMeta(rid("t4"), { status: "private", tags: ["月次"], updatedAt: "2026-07-04T00:00:00.000Z" }));

      const monthly = await drain((opts) => repo.listPublished({ ...opts, tag: "月次" }), 2);
      expect(monthly.map((m) => m.id)).toEqual([rid("t1")]);
      // 完全一致のみ（部分一致では絞り込まれない）
      const partial = await drain((opts) => repo.listPublished({ ...opts, tag: "月" }), 2);
      expect(partial).toEqual([]);
    });

    test("listByOwner returns all statuses for one owner, newest first", async () => {
      const repo = await factory();
      await repo.create(makeMeta(rid("o1"), { ownerSub: "alice", status: "private", updatedAt: "2026-07-01T00:00:00.000Z" }));
      await repo.create(makeMeta(rid("o2"), { ownerSub: "alice", status: "published", updatedAt: "2026-07-05T00:00:00.000Z" }));
      await repo.create(makeMeta(rid("o3"), { ownerSub: "bob", status: "published", updatedAt: "2026-07-09T00:00:00.000Z" }));

      const page = await repo.listByOwner("alice");
      expect(page.items.map((m) => m.id)).toEqual([rid("o2"), rid("o1")]);
    });

    test("listAll returns everything, optionally filtered by status, newest first", async () => {
      const repo = await factory();
      await repo.create(makeMeta(rid("a1"), { status: "private", updatedAt: "2026-07-01T00:00:00.000Z" }));
      await repo.create(makeMeta(rid("a2"), { status: "published", updatedAt: "2026-07-02T00:00:00.000Z" }));
      await repo.create(makeMeta(rid("a3"), { status: "published", updatedAt: "2026-07-03T00:00:00.000Z" }));

      const everything = await repo.listAll();
      expect(everything.items.map((m) => m.id)).toEqual([rid("a3"), rid("a2"), rid("a1")]);

      const onlyPublished = await repo.listAll({ status: "published" });
      expect(onlyPublished.items.map((m) => m.id)).toEqual([rid("a3"), rid("a2")]);
    });

    test("document tokens: put stores, get reads back, empty put clears", async () => {
      const repo = await factory();
      const id = rid("tok");
      await repo.create(makeMeta(id));

      expect(await repo.getDocumentTokens(id)).toEqual([]);
      await repo.putDocumentTokens(id, ["alpha", "beta"]);
      expect([...(await repo.getDocumentTokens(id))].sort()).toEqual(["alpha", "beta"]);

      await repo.putDocumentTokens(id, []);
      expect(await repo.getDocumentTokens(id)).toEqual([]);
    });

    test("pending upload pointer: set/get/clear", async () => {
      const repo = await factory();
      const id = rid("pend");
      await repo.create(makeMeta(id));

      expect(await repo.getPendingUpload(id)).toBeNull();
      await repo.setPendingUpload(id, "staging/pend/u1");
      expect(await repo.getPendingUpload(id)).toBe("staging/pend/u1");
      // 上書きは最新値。
      await repo.setPendingUpload(id, "staging/pend/u2");
      expect(await repo.getPendingUpload(id)).toBe("staging/pend/u2");
      await repo.clearPendingUpload(id);
      expect(await repo.getPendingUpload(id)).toBeNull();
    });

    test("incrementDailyUploads returns the post-increment count per owner and date", async () => {
      const repo = await factory();
      expect(await repo.incrementDailyUploads("alice", "2026-07-12")).toBe(1);
      expect(await repo.incrementDailyUploads("alice", "2026-07-12")).toBe(2);
      expect(await repo.incrementDailyUploads("alice", "2026-07-12")).toBe(3);
      // 日付が変われば独立してリセット。
      expect(await repo.incrementDailyUploads("alice", "2026-07-13")).toBe(1);
      // オーナーが変われば独立。
      expect(await repo.incrementDailyUploads("bob", "2026-07-12")).toBe(1);
    });

    test("getDailyUploads reads the current count (0 when nothing was uploaded)", async () => {
      const repo = await factory();
      expect(await repo.getDailyUploads("alice", "2026-07-12")).toBe(0);
      await repo.incrementDailyUploads("alice", "2026-07-12");
      await repo.incrementDailyUploads("alice", "2026-07-12");
      expect(await repo.getDailyUploads("alice", "2026-07-12")).toBe(2);
      // 読み取りはカウントを消費しない。
      expect(await repo.getDailyUploads("alice", "2026-07-12")).toBe(2);
      // 別日・別オーナーは独立。
      expect(await repo.getDailyUploads("alice", "2026-07-13")).toBe(0);
      expect(await repo.getDailyUploads("bob", "2026-07-12")).toBe(0);
    });

    test("view counter: increment returns the post-increment count, get reads without consuming", async () => {
      const repo = await factory();
      const id = rid("view");
      await repo.create(makeMeta(id));

      expect(await repo.getViewCount(id)).toBe(0);
      expect(await repo.incrementViewCount(id)).toBe(1);
      expect(await repo.incrementViewCount(id)).toBe(2);
      expect(await repo.getViewCount(id)).toBe(2);
      // 読み取りはカウントを消費しない。
      expect(await repo.getViewCount(id)).toBe(2);
      // 別レポートは独立。
      expect(await repo.getViewCount(rid("other"))).toBe(0);
    });

    test("flags: add/list, listFlagged surfaces flagged ids, clearFlags resolves", async () => {
      const repo = await factory();
      const flagged = rid("flg");
      const clean = rid("cln");
      await repo.create(makeMeta(flagged));
      await repo.create(makeMeta(clean));

      const flag = makeFlag({ reason: "フィッシング" });
      await repo.addFlag(flagged, flag);
      await repo.addFlag(flagged, makeFlag({ reason: "重複通報" }));

      expect((await repo.listFlags(flagged)).map((f) => f.reason)).toEqual([
        "フィッシング",
        "重複通報",
      ]);
      expect(await repo.listFlags(clean)).toEqual([]);

      const flaggedList = await repo.listFlagged();
      expect(flaggedList.map((e) => e.id)).toEqual([flagged]);
      expect(flaggedList[0]?.flags).toHaveLength(2);

      await repo.clearFlags(flagged);
      expect(await repo.listFlags(flagged)).toEqual([]);
      expect(await repo.listFlagged()).toEqual([]);
    });

    test("delete removes META along with tokens, pending pointer, flags, and view counter", async () => {
      const repo = await factory();
      const id = rid("del");
      await repo.create(makeMeta(id));
      await repo.putDocumentTokens(id, ["alpha"]);
      await repo.setPendingUpload(id, "staging/del/u1");
      await repo.addFlag(id, makeFlag());
      await repo.incrementViewCount(id);

      await repo.delete(id);

      expect(await repo.get(id)).toBeNull();
      expect(await repo.getDocumentTokens(id)).toEqual([]);
      expect(await repo.getPendingUpload(id)).toBeNull();
      expect(await repo.listFlags(id)).toEqual([]);
      expect(await repo.listFlagged()).toEqual([]);
      expect(await repo.getViewCount(id)).toBe(0);
    });
  });
}
