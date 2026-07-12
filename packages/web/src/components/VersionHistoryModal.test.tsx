import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReportVersion } from "@hrb/shared";
import { RollbackConfirmBody, currentVersionOf } from "./VersionHistoryModal.tsx";

const entry = (version: number): ReportVersion => ({
  version,
  createdAt: "2026-07-01T00:00:00.000Z",
  sizeBytes: 1024,
  verdict: "pass",
  kind: "html",
});

describe("currentVersionOf", () => {
  test("並び順に依存せず最大バージョンを現在の版とする", () => {
    expect(currentVersionOf([entry(3), entry(1), entry(2)])).toBe(3);
    expect(currentVersionOf([entry(1), entry(2), entry(3)])).toBe(3);
  });

  test("空一覧では undefined", () => {
    expect(currentVersionOf([])).toBeUndefined();
  });
});

describe("RollbackConfirmBody", () => {
  test("復元対象のバージョンと再スキャンの説明を表示する", () => {
    const html = renderToStaticMarkup(<RollbackConfirmBody version={2} />);
    expect(html).toContain("v2");
    expect(html).toContain("セキュリティスキャンが再実行されます");
  });

  test("block 判定でレポート全体が拒否状態になるリスクを警告する", () => {
    const html = renderToStaticMarkup(<RollbackConfirmBody version={2} />);
    expect(html).toContain("拒否（block）判定");
    expect(html).toContain("閲覧できなくなります");
  });
});
