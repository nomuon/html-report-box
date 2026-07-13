import { describe, expect, test } from "bun:test";
import { patchReportStatusInDetail, patchReportStatusInPages } from "./report-cache.ts";
import type { ReportDetailData, ReportListPages } from "./report-cache.ts";

function pages(): ReportListPages & { pageParams: unknown[] } {
  return {
    pages: [
      {
        reports: [
          { id: "a", status: "private" },
          { id: "b", status: "published" },
        ],
        nextCursor: "c1",
      } as ReportListPages["pages"][number],
      { reports: [{ id: "c", status: "private" }] },
    ],
    pageParams: [undefined, "c1"],
  };
}

describe("patchReportStatusInPages", () => {
  test("該当 id の status だけを差し替え、他のレポート・ページは参照を保つ", () => {
    const data = pages();
    const next = patchReportStatusInPages(data, "c", "published");
    expect(next).not.toBe(data);
    expect(next!.pages[1]!.reports[0]).toEqual({ id: "c", status: "published" });
    // 変更のないページ・レポートは同一参照（不要な再レンダー防止）
    expect(next!.pages[0]).toBe(data.pages[0]!);
    expect(next!.pageParams).toBe(data.pageParams);
  });

  test("nextCursor などページの他フィールドを保持する", () => {
    const next = patchReportStatusInPages(pages(), "a", "published");
    expect((next!.pages[0] as { nextCursor?: string }).nextCursor).toBe("c1");
  });

  test("id 不一致・status 変化なし・undefined は同一参照を返す", () => {
    const data = pages();
    expect(patchReportStatusInPages(data, "zzz", "published")).toBe(data);
    expect(patchReportStatusInPages(data, "b", "published")).toBe(data);
    expect(patchReportStatusInPages(undefined, "a", "published")).toBeUndefined();
  });
});

describe("patchReportStatusInDetail", () => {
  const data: ReportDetailData & { url?: string; isOwner?: boolean } = {
    report: { id: "a", status: "published" },
    url: "http://x/r/a/",
    isOwner: true,
  };

  test("status を差し替え、report 以外のフィールドを保持する", () => {
    const next = patchReportStatusInDetail(data, "a", "private");
    expect(next).not.toBe(data);
    expect(next!.report).toEqual({ id: "a", status: "private" });
    expect(next!.url).toBe("http://x/r/a/");
    expect(next!.isOwner).toBe(true);
  });

  test("id 不一致・status 変化なし・undefined は同一参照を返す", () => {
    expect(patchReportStatusInDetail(data, "other", "private")).toBe(data);
    expect(patchReportStatusInDetail(data, "a", "published")).toBe(data);
    expect(patchReportStatusInDetail(undefined, "a", "private")).toBeUndefined();
  });
});
