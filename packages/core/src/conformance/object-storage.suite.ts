/**
 * ObjectStorage 共通契約スイート。
 *
 * プロダクションコードから import してはならない。ports.ts の
 * `ObjectStorage` 契約を検証するアダプタ非依存の共通スイートで、
 * 新アダプタの受け入れ基準となる。
 *
 * 許可 import: ../ports.ts の型・@hrb/shared の型・bun:test のみ。
 * 特定アダプタへ依存してはならない。
 *
 * staging の書き込みは port に存在しない（本番は presigned upload 経由）。
 * そのため factory は ObjectStorage 本体に加え、アダプタ固有の staging 投入
 * 手段 `putStaging` を返す harness 形式にしている。
 */
import { describe, expect, test } from "bun:test";
import type { ObjectStorage } from "../ports.ts";

export interface ObjectStorageHarness {
  storage: ObjectStorage;
  /** ports に putStagingObject は無いため、アダプタ固有手段で staging を投入する。 */
  putStaging: (key: string, data: Uint8Array) => void | Promise<void>;
}

export type ObjectStorageFactory = () => ObjectStorageHarness | Promise<ObjectStorageHarness>;

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Uint8Array の中身を配列比較で検証する（インスタンス差異を避ける）。 */
function expectBytes(actual: Uint8Array | null, expected: Uint8Array): void {
  expect(actual).not.toBeNull();
  expect([...(actual ?? [])]).toEqual([...expected]);
}

export function runObjectStorageConformance(name: string, factory: ObjectStorageFactory): void {
  describe(`ObjectStorage conformance: ${name}`, () => {
    test("content objects round-trip; unknown keys read as null", async () => {
      const { storage } = await factory();
      const data = bytes("<h1>report</h1>");
      await storage.putContentObject("reports/x/index.html", data, "text/html");

      expectBytes(await storage.getContentObject("reports/x/index.html"), data);
      expect(await storage.getContentObject("reports/x/missing.html")).toBeNull();
    });

    test("staging objects are readable then deletable; missing/deleted read as null", async () => {
      const { storage, putStaging } = await factory();
      const data = bytes("staged-bytes");
      await putStaging("staging/r1/u1", data);

      expectBytes(await storage.getStagingObject("staging/r1/u1"), data);
      expect(await storage.getStagingObject("staging/r1/absent")).toBeNull();

      await storage.deleteStagingObject("staging/r1/u1");
      expect(await storage.getStagingObject("staging/r1/u1")).toBeNull();
      // 存在しないキーの delete は no-op（throw しない）。
      await storage.deleteStagingObject("staging/r1/u1");
    });

    test("deleteContentPrefix removes only keys under the prefix", async () => {
      const { storage } = await factory();
      await storage.putContentObject("reports/a/index.html", bytes("a-index"), "text/html");
      await storage.putContentObject("reports/a/assets/app.css", bytes("a-css"), "text/css");
      await storage.putContentObject("reports/b/index.html", bytes("b-index"), "text/html");
      // プレフィックス境界: reports/a/ は reports/ab/ を巻き込まないこと。
      await storage.putContentObject("reports/ab/index.html", bytes("ab-index"), "text/html");

      await storage.deleteContentPrefix("reports/a/");

      expect(await storage.getContentObject("reports/a/index.html")).toBeNull();
      expect(await storage.getContentObject("reports/a/assets/app.css")).toBeNull();
      expectBytes(await storage.getContentObject("reports/b/index.html"), bytes("b-index"));
      expectBytes(await storage.getContentObject("reports/ab/index.html"), bytes("ab-index"));
    });

    test("createPresignedUpload returns a PresignedUpload carrying method/url/key/maxSizeBytes", async () => {
      const { storage } = await factory();
      const upload = await storage.createPresignedUpload({
        key: "staging/r1/u1",
        maxSizeBytes: 5 * 1024 * 1024,
        expiresInSeconds: 600,
      });

      expect(["post", "put"]).toContain(upload.method);
      expect(typeof upload.url).toBe("string");
      expect(upload.url.length).toBeGreaterThan(0);
      expect(upload.key).toBe("staging/r1/u1");
      expect(upload.maxSizeBytes).toBe(5 * 1024 * 1024);
      expect(upload.expiresInSeconds).toBeGreaterThan(0);
    });
  });
}
