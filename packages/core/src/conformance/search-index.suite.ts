/**
 * SearchIndex 共通契約スイート。
 *
 * プロダクションコードから import してはならない。ports.ts の
 * `SearchIndex` 契約を検証するアダプタ非依存の共通スイートで、
 * 新アダプタの受け入れ基準となる。
 *
 * 許可 import: ../ports.ts の型・@hrb/shared の型・bun:test のみ。
 * 特定アダプタへ依存してはならない。
 *
 * put の契約について: 本スイートは local 実装を正とし、put を「posting ごとの
 * upsert（マージ）」として扱う。同じ (reportId, token) の重み/updatedAt は
 * 上書きされるが、新しい posting 配列に含まれないトークンの登録は残留する
 * （＝置換ではない）。古いトークンの掃除は呼び出し側が remove() で行う契約。
 */
import { describe, expect, test } from "bun:test";
import type { Posting, SearchHit, SearchIndex } from "../ports.ts";

export type SearchIndexFactory = () => SearchIndex | Promise<SearchIndex>;

function postings(...pairs: Array<[string, number]>): Posting[] {
  return pairs.map(([token, weight]) => ({ token, weight }));
}

/** query 結果を reportId で引きやすい Map にする（順序は未規定のため）。 */
function byReport(hits: SearchHit[]): Map<string, SearchHit> {
  return new Map(hits.map((h) => [h.reportId, h]));
}

export function runSearchIndexConformance(name: string, factory: SearchIndexFactory): void {
  describe(`SearchIndex conformance: ${name}`, () => {
    test("query aggregates matched posting weights and counts distinct query tokens", async () => {
      const index = await factory();
      await index.put("r1", postings(["alpha", 3], ["beta", 1]), "2026-07-01T00:00:00.000Z");
      await index.put("r2", postings(["alpha", 2]), "2026-07-02T00:00:00.000Z");

      const hits = byReport(await index.query(["alpha", "beta"]));
      expect(hits.get("r1")).toMatchObject({ score: 4, matchedTokens: 2 });
      expect(hits.get("r2")).toMatchObject({ score: 2, matchedTokens: 1 });
    });

    test("query de-duplicates repeated query tokens", async () => {
      const index = await factory();
      await index.put("r1", postings(["alpha", 3]), "2026-07-01T00:00:00.000Z");

      const hits = byReport(await index.query(["alpha", "alpha"]));
      expect(hits.get("r1")).toMatchObject({ score: 3, matchedTokens: 1 });
    });

    test("query hit carries the most recent updatedAt across matched postings", async () => {
      const index = await factory();
      await index.put("r1", postings(["alpha", 1]), "2026-07-01T00:00:00.000Z");
      await index.put("r1", postings(["beta", 1]), "2026-07-05T00:00:00.000Z");

      const hit = byReport(await index.query(["alpha", "beta"])).get("r1");
      expect(hit?.updatedAt).toBe("2026-07-05T00:00:00.000Z");
    });

    test("query returns no hits for unknown tokens", async () => {
      const index = await factory();
      await index.put("r1", postings(["alpha", 1]), "2026-07-01T00:00:00.000Z");
      expect(await index.query(["missing"])).toEqual([]);
    });

    test("remove deletes the given tokens' postings for a document, leaving others", async () => {
      const index = await factory();
      await index.put("r1", postings(["alpha", 3], ["beta", 1]), "2026-07-01T00:00:00.000Z");

      await index.remove("r1", ["alpha"]);
      expect(await index.query(["alpha"])).toEqual([]);
      expect(byReport(await index.query(["beta"])).get("r1")).toMatchObject({ score: 1 });
    });

    test("put upserts per token: weight/updatedAt update, untouched tokens remain (merge, not replace)", async () => {
      const index = await factory();
      await index.put("r1", postings(["alpha", 3], ["beta", 1]), "2026-07-01T00:00:00.000Z");
      await index.put("r1", postings(["beta", 5], ["gamma", 2]), "2026-07-08T00:00:00.000Z");

      // alpha は 2 回目の put に含まれないが残留する（置換ではないため）。
      expect(byReport(await index.query(["alpha"])).get("r1")).toMatchObject({ score: 3 });
      // beta は重みと updatedAt が更新される。
      expect(byReport(await index.query(["beta"])).get("r1")).toMatchObject({
        score: 5,
        updatedAt: "2026-07-08T00:00:00.000Z",
      });
      // gamma は新規追加。
      expect(byReport(await index.query(["gamma"])).get("r1")).toMatchObject({ score: 2 });
    });
  });
}
