/**
 * TanStack Query キャッシュの楽観的更新ヘルパー（pure — DOM なしで unit テスト可能）。
 * 公開/非公開トグルの onMutate で一覧・詳細キャッシュの status を先行更新する。
 */
import type { ReportStatus } from "@hrb/shared";

/** useInfiniteQuery のキャッシュ形状（pages[n].reports[]）。 */
export interface ReportListPages {
  pages: Array<{ reports: Array<{ id: string; status: ReportStatus }> }>;
}

/** 詳細キャッシュ（GetReportResponse など report を 1 件持つ形状）。 */
export interface ReportDetailData {
  report: { id: string; status: ReportStatus };
}

/**
 * 一覧キャッシュ内の該当 id の status を差し替える。
 * 変更が無ければ同一参照を返す（不要な再レンダーを避ける）。
 */
export function patchReportStatusInPages<D extends ReportListPages>(
  data: D | undefined,
  id: string,
  status: ReportStatus,
): D | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    const idx = page.reports.findIndex((r) => r.id === id && r.status !== status);
    if (idx === -1) return page;
    changed = true;
    const reports = page.reports.slice();
    reports[idx] = { ...reports[idx]!, status };
    return { ...page, reports };
  });
  return changed ? { ...data, pages } : data;
}

/** 詳細キャッシュの status を差し替える（id 不一致・変更なしなら同一参照）。 */
export function patchReportStatusInDetail<D extends ReportDetailData>(
  data: D | undefined,
  id: string,
  status: ReportStatus,
): D | undefined {
  if (!data || data.report.id !== id || data.report.status === status) return data;
  return { ...data, report: { ...data.report, status } };
}
