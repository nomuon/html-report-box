/**
 * Integration tests: ReportService + local adapters (temp dataDir per test).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "./errors.ts";
import type { SecurityScanner } from "./ports.ts";
import { createLocalContext, getDevUser, type LocalContext } from "./local/index.ts";

const alice = getDevUser("alice");
const bob = getDevUser("bob");
const admin = getDevUser("admin");

/** Test scanner: verdict driven by markers embedded in the uploaded HTML. */
const markerScanner: SecurityScanner = {
  async scan({ data }) {
    const text = new TextDecoder().decode(data);
    if (text.includes("BLOCK_ME")) {
      return {
        verdict: "block",
        findings: [{ ruleId: "test.block", severity: "block", message: "malicious marker" }],
      };
    }
    if (text.includes("WARN_ME")) {
      return {
        verdict: "warn",
        findings: [{ ruleId: "test.warn", severity: "warn", message: "suspicious marker" }],
      };
    }
    return { verdict: "pass", findings: [] };
  },
};

const html = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const enc = new TextEncoder();
const dec = new TextDecoder();

let dataDir: string;
let ctx: LocalContext;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hrb-core-test-"));
  ctx = createLocalContext({ dataDir, scanner: markerScanner });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** create → staged PUT → complete（新モデルでは private で終わる） */
async function upload(
  user: ReturnType<typeof getDevUser>,
  input: { title: string; description?: string },
  content: string,
) {
  const { report, upload } = await ctx.service.create(user, { ...input, kind: "html" });
  await ctx.storage.putStagingObject(upload.key, enc.encode(content));
  return ctx.service.complete(user, report.id, upload.key);
}

/** upload + オーナーによる publish まで通す */
async function uploadPublished(
  user: ReturnType<typeof getDevUser>,
  input: { title: string; description?: string },
  content: string,
) {
  const { report } = await upload(user, input, content);
  return ctx.service.publish(user, report.id);
}

async function expectDomainError(p: Promise<unknown>, code: DomainError["code"]): Promise<void> {
  try {
    await p;
    throw new Error(`expected DomainError(${code}) but nothing was thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
  }
}

describe("report lifecycle", () => {
  test("complete lands private (source stored, nothing public), publish makes it public", async () => {
    const { report, url } = await upload(
      alice,
      { title: "東京オフィス移転計画", description: "2026年秋の移転概要" },
      html("移転計画", "<p>品川への移転スケジュールと概算費用。</p>"),
    );
    expect(report.status).toBe("private");
    expect(report.version).toBe(1);
    expect(report.verdict).toBe("pass");
    expect(report.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(url).toBeUndefined();

    // source is stored; nothing on the public content prefix, no index entry
    expect(await ctx.storage.getContentObject(`sources/${report.id}/current`)).not.toBeNull();
    expect(await ctx.storage.getContentObject(`reports/${report.id}/index.html`)).toBeNull();
    await expectDomainError(ctx.service.get(report.id), "not_found");
    expect((await ctx.service.search("移転計画")).results).toHaveLength(0);

    // owner & admin can still read the meta and the source
    expect((await ctx.service.get(report.id, alice)).report.status).toBe("private");
    expect((await ctx.service.getSource(alice, report.id)).html).toContain("品川");
    expect((await ctx.service.getSource(admin, report.id)).html).toContain("品川");
    await expectDomainError(ctx.service.getSource(bob, report.id), "forbidden");

    // --- publish ---
    const published = await ctx.service.publish(alice, report.id);
    expect(published.report.status).toBe("published");
    expect(published.url).toBe(`http://localhost:3000/r/${report.id}/`);

    const content = await ctx.storage.getContentObject(`reports/${report.id}/index.html`);
    expect(content).not.toBeNull();
    const extracted = await ctx.storage.getContentObject(`reports/${report.id}/.extracted.txt`);
    expect(dec.decode(extracted!)).toContain("品川");

    const { results: hits } = await ctx.service.search("移転計画");
    expect(hits.length).toBe(1);
    expect(hits[0]!.report.id).toBe(report.id);
    expect("ownerSub" in hits[0]!.report).toBe(false);
    expect("verdict" in hits[0]!.report).toBe(false);
  });

  test("unpublish hides content but keeps meta + source; republish restores", async () => {
    const { report } = await uploadPublished(
      alice,
      { title: "四半期レビュー" },
      html("qr", "<p>四半期の実績サマリー。</p>"),
    );

    const back = await ctx.service.unpublish(alice, report.id);
    expect(back.status).toBe("private");
    // hidden from public list/search/content, but source retained
    await expectDomainError(ctx.service.get(report.id), "not_found");
    expect((await ctx.service.search("四半期")).results).toHaveLength(0);
    expect(await ctx.storage.getContentObject(`reports/${report.id}/index.html`)).toBeNull();
    expect(await ctx.storage.getContentObject(`sources/${report.id}/current`)).not.toBeNull();
    // owner still sees it
    expect((await ctx.service.get(report.id, alice)).report.status).toBe("private");
    expect((await ctx.service.getSource(alice, report.id)).html).toContain("四半期");

    // republish from the retained source
    const again = await ctx.service.publish(alice, report.id);
    expect(again.report.status).toBe("published");
    expect((await ctx.service.search("四半期")).results).toHaveLength(1);

    // both operations are idempotent
    expect((await ctx.service.publish(alice, report.id)).report.status).toBe("published");
    await ctx.service.unpublish(alice, report.id);
    expect((await ctx.service.unpublish(alice, report.id)).status).toBe("private");
  });

  test("publish before any upload → conflict", async () => {
    const { report } = await ctx.service.create(alice, { title: "空", kind: "html" });
    await expectDomainError(ctx.service.publish(alice, report.id), "conflict");
  });

  test("overwrite of a published report stays published and swaps index tokens", async () => {
    const { report } = await uploadPublished(
      alice,
      { title: "拠点計画" },
      html("v1", "<p>品川への移転。</p>"),
    );
    const { upload: up2 } = await ctx.service.issueUploadUrl(alice, report.id, "html");
    await ctx.storage.putStagingObject(up2.key, enc.encode(html("大阪支社の開設", "<p>大阪支社を開設します。</p>")));
    const second = await ctx.service.complete(alice, report.id, up2.key);
    expect(second.report.version).toBe(2);
    expect(second.report.status).toBe("published"); // 公開中の上書きは公開のまま
    expect(second.url).toBeDefined();

    expect((await ctx.service.search("品川")).results).toHaveLength(0);
    const { results: osaka } = await ctx.service.search("大阪支社");
    expect(osaka).toHaveLength(1);

    // overwrite of a private report stays private
    await ctx.service.unpublish(alice, report.id);
    const { upload: up3 } = await ctx.service.issueUploadUrl(alice, report.id, "html");
    await ctx.storage.putStagingObject(up3.key, enc.encode(html("v3", "<p>非公開のまま更新。</p>")));
    const third = await ctx.service.complete(alice, report.id, up3.key);
    expect(third.report.status).toBe("private");
    expect(third.url).toBeUndefined();
    expect(await ctx.storage.getContentObject(`reports/${report.id}/index.html`)).toBeNull();
  });

  test("delete removes meta, index, content and source", async () => {
    const { report } = await uploadPublished(alice, { title: "削除対象" }, html("d", "抹消される本文"));
    await ctx.service.delete(alice, report.id);
    expect((await ctx.service.search("抹消")).results).toHaveLength(0);
    expect(await ctx.storage.getContentObject(`reports/${report.id}/index.html`)).toBeNull();
    expect(await ctx.storage.getContentObject(`sources/${report.id}/current`)).toBeNull();
    await expectDomainError(ctx.service.get(report.id), "not_found");
  });

  test("adminDeleteByOwner purges every report of the owner and only theirs", async () => {
    await uploadPublished(alice, { title: "Alice公開" }, html("a1", "アリスの公開本文"));
    const { report: priv } = await upload(alice, { title: "Alice非公開" }, html("a2", "アリスの非公開本文"));
    const { report: kept } = await uploadPublished(bob, { title: "Bob残留" }, html("b", "ボブの本文"));

    const deleted = await ctx.service.adminDeleteByOwner(admin, alice.sub);
    expect(deleted).toBe(2);
    expect((await ctx.service.listMine(alice)).items).toHaveLength(0);
    await expectDomainError(ctx.service.get(priv.id, admin), "not_found");
    expect((await ctx.service.search("アリス")).results).toHaveLength(0);
    expect((await ctx.service.get(kept.id)).report.id).toBe(kept.id);

    await expectDomainError(ctx.service.adminDeleteByOwner(alice, bob.sub), "forbidden");
  });

  test("empty description is auto-filled from meta description at complete", async () => {
    const page = `<!doctype html><html><head><title>t</title><meta name="description" content="自動抽出された説明"></head><body>x</body></html>`;
    const { report } = await upload(alice, { title: "説明なしレポート" }, page);
    expect(report.description).toBe("自動抽出された説明");
  });

  test("complete rejects an unknown or stale upload key", async () => {
    const { report } = await ctx.service.create(alice, { title: "キー検証", kind: "html" });
    await expectDomainError(
      ctx.service.complete(alice, report.id, `staging/${report.id}/forged-key`),
      "bad_request",
    );
  });

  test("complete without an uploaded object → upload_incomplete", async () => {
    const { report, upload: up } = await ctx.service.create(alice, { title: "未アップロード", kind: "html" });
    await expectDomainError(ctx.service.complete(alice, report.id, up.key), "upload_incomplete");
  });

  test("zip complete fails cleanly while no zipExtractor is wired", async () => {
    const { report, upload: up } = await ctx.service.create(alice, { title: "zipレポート", kind: "zip" });
    await ctx.storage.putStagingObject(up.key, enc.encode("PK-fake-zip"));
    await expectDomainError(ctx.service.complete(alice, report.id, up.key), "bad_request");
  });
});

describe("direct HTML edit", () => {
  test("editContent re-scans, bumps version and updates published content in place", async () => {
    const { report } = await uploadPublished(alice, { title: "編集対象" }, html("v1", "初版の本文"));
    const edited = await ctx.service.editContent(
      alice,
      report.id,
      html("v2", "編集後のユニーク本文トークン"),
    );
    expect(edited.report.version).toBe(2);
    expect(edited.report.status).toBe("published");
    expect(edited.url).toBeDefined();
    expect((await ctx.service.search("初版")).results).toHaveLength(0);
    expect((await ctx.service.search("編集後")).results).toHaveLength(1);
    const content = await ctx.storage.getContentObject(`reports/${report.id}/index.html`);
    expect(dec.decode(content!)).toContain("編集後のユニーク本文トークン");
  });

  test("editContent on a private report keeps it private", async () => {
    const { report } = await upload(alice, { title: "非公開編集" }, html("v1", "本文"));
    const edited = await ctx.service.editContent(alice, report.id, html("v2", "更新"));
    expect(edited.report.status).toBe("private");
    expect(edited.url).toBeUndefined();
    expect((await ctx.service.getSource(alice, report.id)).html).toContain("更新");
  });

  test("editContent with blocked content rejects and purges", async () => {
    const { report } = await uploadPublished(alice, { title: "編集で悪性化" }, html("ok", "安全"));
    const edited = await ctx.service.editContent(alice, report.id, html("evil", "BLOCK_ME"));
    expect(edited.report.status).toBe("rejected");
    expect(await ctx.storage.getContentObject(`reports/${report.id}/index.html`)).toBeNull();
    expect(await ctx.storage.getContentObject(`sources/${report.id}/current`)).toBeNull();
    // rejected のままでは公開できない
    await expectDomainError(ctx.service.publish(alice, report.id), "conflict");
    // 良性の内容に編集し直せば private に復帰できる
    const fixed = await ctx.service.editContent(alice, report.id, html("fixed", "修正済み"));
    expect(fixed.report.status).toBe("private");
  });

  test("editContent guards: zip kind, non-owner, quota", async () => {
    const zipCase = await ctx.service.create(alice, { title: "zip編集不可", kind: "zip" });
    await expectDomainError(
      ctx.service.editContent(alice, zipCase.report.id, "<html></html>"),
      "bad_request", // zip は直接編集不可
    );
    const { report } = await upload(alice, { title: "他人編集不可" }, html("a", "b"));
    await expectDomainError(ctx.service.editContent(bob, report.id, "<html>x</html>"), "forbidden");
  });
});

describe("daily upload quota", () => {
  test("blocks the (limit+1)th upload of a day, per user", async () => {
    const limited = createLocalContext({ dataDir, scanner: markerScanner, dailyUploadLimit: 2 });
    await limited.service.create(alice, { title: "1本目", kind: "html" });
    await limited.service.create(alice, { title: "2本目", kind: "html" });
    await expectDomainError(
      limited.service.create(alice, { title: "3本目", kind: "html" }),
      "rate_limited",
    );
    // other users are unaffected
    const ok = await limited.service.create(bob, { title: "bobの1本目", kind: "html" });
    expect(ok.report.status).toBe("private");
  });

  test("getUploadQuota reflects usage and resets at the same UTC date boundary as increments", async () => {
    // 可変クロックで日付境界を跨ぐ（increment と読み取りが同じ dateKey を使うこと）
    let now = new Date("2026-07-12T23:50:00Z");
    const limited = createLocalContext({
      dataDir,
      scanner: markerScanner,
      dailyUploadLimit: 2,
      now: () => now,
    });
    expect(await limited.service.getUploadQuota(alice)).toEqual({
      dailyUploadLimit: 2,
      usedToday: 0,
      remaining: 2,
    });

    await limited.service.create(alice, { title: "1本目", kind: "html" });
    expect(await limited.service.getUploadQuota(alice)).toEqual({
      dailyUploadLimit: 2,
      usedToday: 1,
      remaining: 1,
    });

    // 上限到達 + 超過試行後も remaining は負にならない
    await limited.service.create(alice, { title: "2本目", kind: "html" });
    await expectDomainError(
      limited.service.create(alice, { title: "3本目", kind: "html" }),
      "rate_limited",
    );
    expect(await limited.service.getUploadQuota(alice)).toEqual({
      dailyUploadLimit: 2,
      usedToday: 2,
      remaining: 0,
    });
    // 他ユーザーは独立
    expect((await limited.service.getUploadQuota(bob)).remaining).toBe(2);

    // UTC 日付が変わると残数が戻り、再びアップロードできる
    now = new Date("2026-07-13T00:10:00Z");
    expect(await limited.service.getUploadQuota(alice)).toEqual({
      dailyUploadLimit: 2,
      usedToday: 0,
      remaining: 2,
    });
    const ok = await limited.service.create(alice, { title: "翌日の1本目", kind: "html" });
    expect(ok.report.status).toBe("private");
  });

  test("overwrite upload-url issuance and editContent also consume quota", async () => {
    const limited = createLocalContext({ dataDir, scanner: markerScanner, dailyUploadLimit: 2 });
    const { report, upload: up } = await limited.service.create(alice, { title: "上書き対象", kind: "html" });
    await limited.storage.putStagingObject(up.key, enc.encode(html("t", "b")));
    await limited.service.complete(alice, report.id, up.key);
    await limited.service.issueUploadUrl(alice, report.id, "html"); // 2nd upload
    await expectDomainError(limited.service.issueUploadUrl(alice, report.id, "html"), "rate_limited");
    await expectDomainError(
      limited.service.editContent(alice, report.id, html("t", "c")),
      "rate_limited",
    );
  });
});

describe("verdict branching", () => {
  test("warn → private with findings; owner can still publish (no admin gate)", async () => {
    const { report } = await upload(
      alice,
      { title: "要注意レポート" },
      html("warn", "<p>WARN_ME 外部フォームがあります</p>"),
    );
    expect(report.status).toBe("private");
    expect(report.verdict).toBe("warn");
    expect(report.findings[0]?.ruleId).toBe("test.warn");

    // invisible to the public until the owner publishes
    await expectDomainError(ctx.service.get(report.id), "not_found");
    expect((await ctx.service.listPublished()).items).toHaveLength(0);

    const published = await ctx.service.publish(alice, report.id);
    expect(published.report.status).toBe("published");
    expect(published.report.verdict).toBe("warn"); // scan outcome preserved for audit
    expect((await ctx.service.search("要注意")).results).toHaveLength(1);
  });

  test("block → rejected, sample retained in staging, nothing published", async () => {
    const { report: created, upload: up } = await ctx.service.create(alice, {
      title: "悪性レポート",
      kind: "html",
    });
    // "eval(atob(x))" below is inert fixture text inside an uploaded-HTML string
    // (mimics a malicious sample for the scanner); it is never executed.
    await ctx.storage.putStagingObject(up.key, enc.encode(html("evil", "BLOCK_ME eval(atob(x))")));
    const { report, url } = await ctx.service.complete(alice, created.id, up.key);

    expect(report.status).toBe("rejected");
    expect(report.verdict).toBe("block");
    expect(report.findings[0]?.severity).toBe("block");
    expect(url).toBeUndefined();
    // nothing in the content store, no source, no index entries
    expect(await ctx.storage.getContentObject(`reports/${report.id}/index.html`)).toBeNull();
    expect(await ctx.storage.getContentObject(`sources/${report.id}/current`)).toBeNull();
    expect((await ctx.service.search("悪性")).results).toHaveLength(0);
    // staged sample retained for forensics
    expect(await ctx.storage.getStagingObject(up.key)).not.toBeNull();
  });

  test("blocked overwrite takes previously published content down", async () => {
    const { report } = await uploadPublished(alice, { title: "一旦公開" }, html("ok", "安全な本文"));
    expect(report.status).toBe("published");

    const { upload: up2 } = await ctx.service.issueUploadUrl(alice, report.id, "html");
    await ctx.storage.putStagingObject(up2.key, enc.encode("BLOCK_ME"));
    const second = await ctx.service.complete(alice, report.id, up2.key);

    expect(second.report.status).toBe("rejected");
    expect(await ctx.storage.getContentObject(`reports/${report.id}/index.html`)).toBeNull();
    expect((await ctx.service.search("安全")).results).toHaveLength(0);
    await expectDomainError(ctx.service.get(report.id), "not_found");
  });
});

describe("authorization", () => {
  test("non-owner cannot complete / overwrite / delete / publish; admin can", async () => {
    const { report } = await upload(alice, { title: "アリスの資料" }, html("a", "b"));
    await expectDomainError(ctx.service.issueUploadUrl(bob, report.id, "html"), "forbidden");
    await expectDomainError(ctx.service.delete(bob, report.id), "forbidden");
    await expectDomainError(ctx.service.publish(bob, report.id), "forbidden");
    await expectDomainError(ctx.service.unpublish(bob, report.id), "forbidden");
    await expectDomainError(
      ctx.service.update(bob, report.id, { title: "乗っ取り" }),
      "forbidden",
    );
    await ctx.service.delete(admin, report.id); // admin may delete
    await expectDomainError(ctx.service.get(report.id, admin), "not_found");
  });

  test("adminList / takedown require admin; takedown locks the owner out", async () => {
    const { report } = await uploadPublished(alice, { title: "対象" }, html("a", "b"));
    await expectDomainError(ctx.service.adminList(alice), "forbidden");
    await expectDomainError(ctx.service.adminTakedown(alice, report.id), "forbidden");

    const down = await ctx.service.adminTakedown(admin, report.id);
    expect(down.status).toBe("takedown");
    await expectDomainError(ctx.service.get(report.id), "not_found");
    // owner cannot re-upload / republish / read source over a takedown
    await expectDomainError(ctx.service.issueUploadUrl(alice, report.id, "html"), "forbidden");
    await expectDomainError(ctx.service.publish(alice, report.id), "forbidden");
    await expectDomainError(ctx.service.getSource(alice, report.id), "forbidden");
  });
});

describe("metadata update & reindex", () => {
  test("title change reweights the index", async () => {
    const { report } = await uploadPublished(alice, { title: "旧タイトル" }, html("t", "共通本文キーワード"));
    await ctx.service.update(alice, report.id, { title: "新章突入" });

    expect((await ctx.service.search("旧タイトル")).results).toHaveLength(0);
    const { results: hits } = await ctx.service.search("新章突入");
    expect(hits).toHaveLength(1);
    // body tokens survive a metadata-only update
    expect((await ctx.service.search("共通本文キーワード")).results).toHaveLength(1);
  });
});

describe("search ranking", () => {
  test("title matches outrank body matches; matchedAll outranks partial", async () => {
    const a = await uploadPublished(alice, { title: "監査ログ 設計" }, html("a", "その他の話題"));
    const b = await uploadPublished(bob, { title: "別件レポート" }, html("b", "監査ログ の話を少しだけ"));
    expect(a.report.status).toBe("published");
    expect(b.report.status).toBe("published");

    const { results: hits } = await ctx.service.search("監査ログ");
    expect(hits.map((h) => h.report.id)).toEqual([a.report.id, b.report.id]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);

    // "設計" only exists in A's title → full match ranks A first for combined query
    const { results: combined } = await ctx.service.search("監査ログ 設計");
    expect(combined[0]!.report.id).toBe(a.report.id);
    expect(combined[0]!.matchedAll).toBe(true);
    expect(combined[1]!.matchedAll).toBe(false);
  });
});

describe("search pagination", () => {
  test("offset cursor pages through the full ranking without overlap", async () => {
    // updatedAt の同着で並びが揺れないよう、1秒ずつ進む固定クロックを使う
    let tick = 0;
    ctx = createLocalContext({
      dataDir,
      scanner: markerScanner,
      now: () => new Date(Date.UTC(2026, 6, 12, 0, 0, tick++)),
    });
    const ids: string[] = [];
    for (const title of ["共通語その一", "共通語その二", "共通語その三"]) {
      const { report } = await uploadPublished(alice, { title }, html(title, "本文"));
      ids.push(report.id);
    }

    const first = await ctx.service.search("共通語", { limit: 2 });
    expect(first.results).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();

    const second = await ctx.service.search("共通語", { limit: 2, cursor: first.nextCursor! });
    expect(second.results).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();

    // ページをまたいで重複せず全件をカバーする
    const seen = [...first.results, ...second.results].map((r) => r.report.id);
    expect(new Set(seen).size).toBe(3);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  test("invalid cursor → bad_request; no cursor on the final page", async () => {
    await uploadPublished(alice, { title: "単独ヒット" }, html("t", "本文"));
    await expectDomainError(ctx.service.search("単独ヒット", { cursor: "abc" }), "bad_request");
    const page = await ctx.service.search("単独ヒット", { limit: 20 });
    expect(page.results).toHaveLength(1);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe("flags (通報)", () => {
  test("public flag lands on published reports; admin sees the flagged list and can resolve it", async () => {
    const { report } = await uploadPublished(alice, { title: "通報対象" }, html("a", "b"));
    await ctx.service.flag(report.id, "フィッシングに見えます", { sourceIp: "10.0.0.9" });
    await ctx.service.flag(report.id, "別の通報");

    const flags = await ctx.service.adminListFlags(admin, report.id);
    expect(flags).toHaveLength(2);
    expect(flags[0]!.reason).toBe("フィッシングに見えます");
    await expectDomainError(ctx.service.adminListFlags(alice, report.id), "forbidden");

    // 通報一覧（管理画面のキュー）
    const flagged = await ctx.service.adminListFlagged(admin);
    expect(flagged.items).toHaveLength(1);
    expect(flagged.items[0]!.report.id).toBe(report.id);
    expect(flagged.items[0]!.flags).toHaveLength(2);
    expect(flagged.nextCursor).toBeUndefined();
    await expectDomainError(ctx.service.adminListFlagged(alice), "forbidden");

    // 解決すると一覧から消える
    await ctx.service.adminClearFlags(admin, report.id);
    expect((await ctx.service.adminListFlagged(admin)).items).toHaveLength(0);
    expect(await ctx.service.adminListFlags(admin, report.id)).toHaveLength(0);
    await expectDomainError(ctx.service.adminClearFlags(alice, report.id), "forbidden");
  });

  test("adminListFlagged paginates with a cursor (newest flag first)", async () => {
    // 通報時刻の同着で並びが揺れないよう、1秒ずつ進む固定クロックを使う
    let tick = 0;
    ctx = createLocalContext({
      dataDir,
      scanner: markerScanner,
      now: () => new Date(Date.UTC(2026, 6, 12, 0, 0, tick++)),
    });
    const { report: older } = await uploadPublished(alice, { title: "先に通報" }, html("a", "b"));
    const { report: newer } = await uploadPublished(alice, { title: "後に通報" }, html("a", "b"));
    await ctx.service.flag(older.id, "古い通報");
    await ctx.service.flag(newer.id, "新しい通報");

    const first = await ctx.service.adminListFlagged(admin, { limit: 1 });
    expect(first.items.map((i) => i.report.id)).toEqual([newer.id]);
    expect(first.nextCursor).toBeDefined();

    const second = await ctx.service.adminListFlagged(admin, {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((i) => i.report.id)).toEqual([older.id]);
    expect(second.nextCursor).toBeUndefined();

    await expectDomainError(
      ctx.service.adminListFlagged(admin, { cursor: "not-a-number" }),
      "bad_request",
    );
  });

  test("unpublished reports cannot be flagged", async () => {
    const { report } = await upload(alice, { title: "非公開通報不可" }, html("a", "b"));
    await expectDomainError(ctx.service.flag(report.id, "spam"), "not_found");
  });
});

describe("version history & rollback", () => {
  test("ingest keeps every version's original bytes and grows the history", async () => {
    const { report } = await upload(alice, { title: "履歴対象" }, html("v1", "初版本文"));
    expect(report.versions).toHaveLength(1);
    expect(report.versions[0]).toMatchObject({ version: 1, kind: "html", verdict: "pass" });

    const edited = await ctx.service.editContent(alice, report.id, html("v2", "二版本文"));
    expect(edited.report.version).toBe(2);
    expect(edited.report.versions.map((v) => v.version)).toEqual([1, 2]);

    // 原本が current と v<version> の両方に残る
    expect(await ctx.storage.getContentObject(`sources/${report.id}/current`)).not.toBeNull();
    const v1 = await ctx.storage.getContentObject(`sources/${report.id}/v1`);
    const v2 = await ctx.storage.getContentObject(`sources/${report.id}/v2`);
    expect(dec.decode(v1!)).toContain("初版本文");
    expect(dec.decode(v2!)).toContain("二版本文");

    // listVersions は新しい順
    const listed = await ctx.service.listVersions(alice, report.id);
    expect(listed.map((v) => v.version)).toEqual([2, 1]);
    expect(listed[0]!.sizeBytes).toBe(edited.report.sizeBytes!);
  });

  test("rollback re-ingests the old bytes as a new version with a fresh scan", async () => {
    // 検索の入れ替わりを見るため、両版で語彙が重ならない本文にする（CJK バイグラム対策）
    const { report } = await uploadPublished(alice, { title: "戻す対象" }, html("v1", "りんごケーキ"));
    await ctx.service.editContent(alice, report.id, html("v2", "自動車整備"));

    const rolled = await ctx.service.rollback(alice, report.id, 1);
    expect(rolled.report.version).toBe(3);
    expect(rolled.report.status).toBe("published"); // 公開中のまま差し替わる
    expect(rolled.url).toBeDefined();
    expect(rolled.report.versions.map((v) => v.version)).toEqual([1, 2, 3]);

    // 内容・検索インデックスとも v1 相当に戻る
    expect((await ctx.service.getSource(alice, report.id)).html).toContain("りんごケーキ");
    expect((await ctx.service.search("りんご")).results).toHaveLength(1);
    expect((await ctx.service.search("自動車")).results).toHaveLength(0);

    // 旧版の verdict が warn なら rollback 後も warn として再スキャンされる
    await ctx.service.editContent(alice, report.id, html("warn", "WARN_ME 注意本文"));
    const back = await ctx.service.rollback(alice, report.id, 4);
    expect(back.report.verdict).toBe("warn");
    expect(back.report.findings[0]?.ruleId).toBe("test.warn");
  });

  test("rollback re-runs the scan: content that now blocks lands rejected and purges", async () => {
    // 判定を後から差し替えられるスキャナで「当時 pass、今は block」を再現する
    let blockAll = false;
    const flip = createLocalContext({
      dataDir,
      scanner: {
        async scan() {
          return blockAll
            ? {
                verdict: "block" as const,
                findings: [{ ruleId: "test.block", severity: "block" as const, message: "now blocked" }],
              }
            : { verdict: "pass" as const, findings: [] };
        },
      },
    });
    const { report, upload: up } = await flip.service.create(alice, { title: "後日block", kind: "html" });
    await flip.storage.putStagingObject(up.key, enc.encode(html("v1", "本文")));
    await flip.service.complete(alice, report.id, up.key);
    await flip.service.editContent(alice, report.id, html("v2", "本文2"));

    blockAll = true;
    const rolled = await flip.service.rollback(alice, report.id, 1);
    expect(rolled.report.status).toBe("rejected");
    expect(rolled.report.verdict).toBe("block");
    // sources/ ごと消えるため履歴も空になる
    expect(rolled.report.versions).toEqual([]);
    expect(await flip.storage.getContentObject(`sources/${report.id}/v1`)).toBeNull();
    expect(await flip.storage.getContentObject(`sources/${report.id}/current`)).toBeNull();
  });

  test("zip 版も原本ごと rollback できる（kind は取り込み時点の値で復元）", async () => {
    const zipCtx = createLocalContext({
      dataDir,
      scanner: markerScanner,
      zipExtractor: {
        async extract(data) {
          return [{ path: "index.html", data }];
        },
      },
    });
    const { report, upload: up } = await zipCtx.service.create(alice, { title: "zip履歴", kind: "zip" });
    await zipCtx.storage.putStagingObject(up.key, enc.encode(html("z1", "zip初版")));
    await zipCtx.service.complete(alice, report.id, up.key);

    const { upload: up2 } = await zipCtx.service.issueUploadUrl(alice, report.id, "zip");
    await zipCtx.storage.putStagingObject(up2.key, enc.encode(html("z2", "zip二版")));
    await zipCtx.service.complete(alice, report.id, up2.key);

    const rolled = await zipCtx.service.rollback(alice, report.id, 1);
    expect(rolled.report.version).toBe(3);
    expect(rolled.report.kind).toBe("zip");
    expect(rolled.report.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect((await zipCtx.service.getVersionSource(alice, report.id, 3)).html).toContain("zip初版");
  });

  test("history is capped: the oldest version objects are trimmed beyond the limit", async () => {
    // 上限を意識した回数（22回）取り込み、古い2版がメタ・オブジェクト双方から消えること
    const { report } = await upload(alice, { title: "上限テスト" }, html("v1", "本文1"));
    for (let i = 2; i <= 22; i++) {
      await ctx.service.editContent(alice, report.id, html(`v${i}`, `本文${i}`));
    }
    const listed = await ctx.service.listVersions(alice, report.id);
    expect(listed).toHaveLength(20);
    expect(listed[0]!.version).toBe(22);
    expect(listed[listed.length - 1]!.version).toBe(3);
    expect(await ctx.storage.getContentObject(`sources/${report.id}/v1`)).toBeNull();
    expect(await ctx.storage.getContentObject(`sources/${report.id}/v2`)).toBeNull();
    expect(await ctx.storage.getContentObject(`sources/${report.id}/v3`)).not.toBeNull();
    expect(await ctx.storage.getContentObject(`sources/${report.id}/v22`)).not.toBeNull();
    // 間引かれた版へは rollback できない
    await expectDomainError(ctx.service.rollback(alice, report.id, 1), "not_found");
  });

  test("purge (delete) removes every version object", async () => {
    const { report } = await upload(alice, { title: "全削除" }, html("v1", "本文"));
    await ctx.service.editContent(alice, report.id, html("v2", "本文2"));
    expect(await ctx.storage.getContentObject(`sources/${report.id}/v2`)).not.toBeNull();

    await ctx.service.delete(alice, report.id);
    expect(await ctx.storage.getContentObject(`sources/${report.id}/v1`)).toBeNull();
    expect(await ctx.storage.getContentObject(`sources/${report.id}/v2`)).toBeNull();
    expect(await ctx.storage.getContentObject(`sources/${report.id}/current`)).toBeNull();
  });

  test("authorization: versions APIs are owner/admin only; unknown versions → not_found", async () => {
    const { report } = await upload(alice, { title: "履歴の権限" }, html("v1", "本文"));

    await expectDomainError(ctx.service.listVersions(bob, report.id), "forbidden");
    await expectDomainError(ctx.service.getVersionSource(bob, report.id, 1), "forbidden");
    await expectDomainError(ctx.service.rollback(bob, report.id, 1), "forbidden");

    // admin は閲覧・復元とも可能
    expect(await ctx.service.listVersions(admin, report.id)).toHaveLength(1);
    expect((await ctx.service.getVersionSource(admin, report.id, 1)).html).toContain("本文");

    await expectDomainError(ctx.service.getVersionSource(alice, report.id, 99), "not_found");
    await expectDomainError(ctx.service.rollback(alice, report.id, 99), "not_found");

    // rollback もクォータを消費する（同じ dataDir を上限1で読み直して検証）
    const { report: q } = await upload(alice, { title: "クォータ" }, html("q1", "本文"));
    const limited = createLocalContext({ dataDir, scanner: markerScanner, dailyUploadLimit: 1 });
    await expectDomainError(limited.service.rollback(alice, q.id, 1), "rate_limited");
  });
});

describe("persistence", () => {
  test("state survives a context restart (JSON reload)", async () => {
    const { report } = await uploadPublished(alice, { title: "永続化テスト" }, html("p", "再起動後も残る本文"));
    // fresh context over the same dataDir
    const restarted = createLocalContext({ dataDir, scanner: markerScanner });
    const got = await restarted.service.get(report.id);
    expect(got.report.title).toBe("永続化テスト");
    const { results: hits } = await restarted.service.search("再起動");
    expect(hits).toHaveLength(1);
  });
});

describe("legacy source recovery (sources/ 導入前のデータ)", () => {
  /** sources/ 導入前の公開レポートを再現: 原本オブジェクトだけを消す */
  async function publishLegacy(title: string, body: string) {
    const { report } = await uploadPublished(alice, { title }, html(title, body));
    await ctx.storage.deleteContentPrefix(`sources/${report.id}/`);
    return report;
  }

  test("getSource recovers from the public copy and backfills sources/", async () => {
    const report = await publishLegacy("旧レポート", "レガシー本文");
    const source = await ctx.service.getSource(alice, report.id);
    expect(source.html).toContain("レガシー本文");
    expect(await ctx.storage.getContentObject(`sources/${report.id}/current`)).not.toBeNull();
  });

  test("publish/unpublish keep working: the source is rescued before the public copy is deleted", async () => {
    const report = await publishLegacy("旧公開", "非公開化テスト");
    const hidden = await ctx.service.unpublish(alice, report.id);
    expect(hidden.status).toBe("private");
    expect((await ctx.service.getSource(alice, report.id)).html).toContain("非公開化テスト");
    expect((await ctx.service.publish(alice, report.id)).report.status).toBe("published");
  });

  test("a public copy that does not match META's sha256 is not recovered", async () => {
    const report = await publishLegacy("改ざん検知", "本物の本文");
    await ctx.storage.putContentObject(
      `reports/${report.id}/index.html`,
      enc.encode("<html>tampered</html>"),
      "text/html; charset=utf-8",
    );
    await expectDomainError(ctx.service.getSource(alice, report.id), "not_found");
    expect(await ctx.storage.getContentObject(`sources/${report.id}/current`)).toBeNull();
  });

  test("editContent still works for a report whose source is gone (rewrite from scratch)", async () => {
    const report = await publishLegacy("原本消失", "旧本文");
    // 公開コピーも失われた最悪ケース（旧 private 相当）
    await ctx.storage.deleteContentPrefix(`reports/${report.id}/`);
    await expectDomainError(ctx.service.getSource(alice, report.id), "not_found");
    const edited = await ctx.service.editContent(alice, report.id, html("書き直し", "新本文"));
    expect(edited.report.status).toBe("published");
    expect((await ctx.service.getSource(alice, report.id)).html).toContain("新本文");
  });
});
