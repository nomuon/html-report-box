/** 画面④: マイレポート (`/mine`) — テーブル固定 + 編集/上書き/削除 */
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { OwnedReport } from "@hrb/shared";
import { useApp, useSession } from "../app-context.tsx";
import { Button } from "../components/Button.tsx";
import { StatusChip } from "../components/Chip.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import {
  DeleteReportModal,
  EditReportModal,
  OverwriteReportModal,
} from "../components/report-modals.tsx";
import { formatDateTime } from "../lib/format.ts";

type ModalState =
  | { type: "edit"; report: OwnedReport }
  | { type: "overwrite"; report: OwnedReport }
  | { type: "delete"; report: OwnedReport }
  | null;

export function MinePage() {
  const { api } = useApp();
  const session = useSession();
  const navigate = useNavigate();
  const [modal, setModal] = useState<ModalState>(null);

  const query = useInfiniteQuery({
    queryKey: ["my-reports"],
    queryFn: ({ pageParam }) => api.myReports({ cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: session !== null,
  });

  if (!session) {
    return (
      <div className="hrb-page">
        <EmptyState icon="🔒" title="ログインが必要です" />
      </div>
    );
  }

  const reports = query.data?.pages.flatMap((p) => p.reports) ?? [];

  return (
    <div className="hrb-page">
      <div className="hrb-page__head">
        <h1 className="hrb-page__title">マイレポート</h1>
      </div>

      {query.isLoading && <p className="hrb-loading">読み込み中…</p>}

      {!query.isLoading && reports.length === 0 && (
        <EmptyState
          icon="📄"
          title="あなたのレポートはまだありません"
          action={<Button onClick={() => navigate("/upload")}>アップロードする</Button>}
        />
      )}

      {reports.length > 0 && (
        <div className="hrb-table-wrap">
          <table className="hrb-table">
            <thead>
              <tr>
                <th>タイトル</th>
                <th>ステータス</th>
                <th>更新日時</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id} className={r.status === "rejected" ? "hrb-table__row--rejected" : ""}>
                  <td>
                    <Link to={`/reports/${r.id}`} className="hrb-table__title">
                      {r.title}
                    </Link>
                  </td>
                  <td>
                    <span className="hrb-status-cell">
                      <StatusChip status={r.status} />
                      {r.status === "pending_review" && (
                        <span
                          className="hrb-tip"
                          data-tip="管理者の承認待ちです。承認されると公開されます"
                          tabIndex={0}
                        >
                          ℹ️
                        </span>
                      )}
                      {r.status === "rejected" && r.findings.length > 0 && (
                        <span
                          className="hrb-tip"
                          data-tip={r.findings.map((f) => f.message).join(" / ")}
                          tabIndex={0}
                        >
                          ℹ️
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="hrb-table__date">{formatDateTime(r.updatedAt)}</td>
                  <td>
                    <div className="hrb-row-actions">
                      <button
                        type="button"
                        className="hrb-icon-btn hrb-tip"
                        data-tip="メタ編集"
                        aria-label="メタ編集"
                        onClick={() => setModal({ type: "edit", report: r })}
                      >
                        ✏️
                      </button>
                      <button
                        type="button"
                        className="hrb-icon-btn hrb-tip"
                        data-tip="上書きアップロード"
                        aria-label="上書きアップロード"
                        onClick={() => setModal({ type: "overwrite", report: r })}
                      >
                        ⬆️
                      </button>
                      <button
                        type="button"
                        className="hrb-icon-btn hrb-tip"
                        data-tip="削除"
                        aria-label="削除"
                        onClick={() => setModal({ type: "delete", report: r })}
                      >
                        🗑
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {query.hasNextPage && (
        <div className="hrb-load-more">
          <Button
            variant="secondary"
            loading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            さらに読み込む
          </Button>
        </div>
      )}

      {modal?.type === "edit" && (
        <EditReportModal
          key={modal.report.id}
          report={modal.report}
          open
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "overwrite" && (
        <OverwriteReportModal
          key={modal.report.id}
          report={modal.report}
          open
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "delete" && (
        <DeleteReportModal
          key={modal.report.id}
          report={modal.report}
          open
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
