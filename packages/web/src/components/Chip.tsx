import type { ReportKind, ReportStatus, ScanVerdict } from "@hrb/shared";

export const STATUS_LABELS: Record<ReportStatus, string> = {
  published: "公開中",
  private: "非公開",
  rejected: "拒否",
  takedown: "管理停止",
};

const STATUS_CLASS: Record<ReportStatus, string> = {
  published: "hrb-chip--published",
  private: "hrb-chip--private",
  rejected: "hrb-chip--rejected",
  takedown: "hrb-chip--rejected",
};

export function StatusChip({ status }: { status: ReportStatus }) {
  return (
    <span className={`hrb-chip ${STATUS_CLASS[status]}`}>
      <span className="hrb-chip__dot" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function KindChip({ kind }: { kind: ReportKind }) {
  return <span className="hrb-chip hrb-chip--kind">{kind === "html" ? "HTML" : "ZIP"}</span>;
}

const VERDICT_LABELS: Record<ScanVerdict, string> = {
  pass: "パス",
  warn: "注意",
  block: "拒否",
};

const VERDICT_CLASS: Record<ScanVerdict, string> = {
  pass: "hrb-chip--published",
  warn: "hrb-chip--warn",
  block: "hrb-chip--rejected",
};

/** スキャン判定バッジ（バージョン履歴などオーナー/管理者向け画面用）。 */
export function VerdictChip({ verdict }: { verdict: ScanVerdict }) {
  return (
    <span className={`hrb-chip ${VERDICT_CLASS[verdict]}`}>
      <span className="hrb-chip__dot" aria-hidden="true" />
      {VERDICT_LABELS[verdict]}
    </span>
  );
}
