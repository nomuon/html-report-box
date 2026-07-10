import type { ReportKind, ReportStatus } from "@hrb/shared";

export const STATUS_LABELS: Record<ReportStatus, string> = {
  processing: "処理中",
  published: "公開中",
  pending_review: "承認待ち",
  rejected: "拒否",
  takedown: "非公開",
};

const STATUS_CLASS: Record<ReportStatus, string> = {
  processing: "hrb-chip--processing",
  published: "hrb-chip--published",
  pending_review: "hrb-chip--pending",
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
