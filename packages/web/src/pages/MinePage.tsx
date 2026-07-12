/** 画面④: マイレポート (`/mine`) — 公開トグル + HTML編集/上書き/メタ編集/削除 */
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { OwnedReport } from "@hrb/shared";
import { scanFindingSummary } from "@hrb/shared";
import { useApp, useSession } from "../app-context.tsx";
import { Button } from "../components/Button.tsx";
import { StatusChip } from "../components/Chip.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Icon } from "../components/Icon.tsx";
import { PublishToggle } from "../components/PublishToggle.tsx";
import {
  DeleteReportModal,
  EditHtmlModal,
  EditReportModal,
  OverwriteReportModal,
} from "../components/report-modals.tsx";
import { formatDateTime } from "../lib/format.ts";

type ModalState =
  | { type: "edit-html"; report: OwnedReport }
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
        <EmptyState icon={<Icon name="lock" size={30} />} title="ログインが必要です" />
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
          icon={<Icon name="file" size={30} />}
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
                <th>公開状態</th>
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
                      {r.status === "published" || r.status === "private" ? (
                        <PublishToggle report={r} />
                      ) : (
                        <StatusChip status={r.status} />
                      )}
                      {r.status === "rejected" && r.findings.length > 0 && (
                        <span
                          className="hrb-tip"
                          data-tip={r.findings.map(scanFindingSummary).join(" / ")}
                          tabIndex={0}
                        >
                          <Icon name="info" size={15} />
                        </span>
                      )}
                      {r.status !== "rejected" && r.verdict === "warn" && (
                        <span
                          className="hrb-tip"
                          data-tip={`スキャン注意項目: ${r.findings.map(scanFindingSummary).join(" / ")}`}
                          tabIndex={0}
                        >
                          <Icon name="info" size={15} />
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
                        data-tip={r.kind === "html" ? "HTMLを編集" : "ZIPは直接編集できません"}
                        aria-label="HTMLを編集"
                        disabled={r.kind !== "html"}
                        onClick={() => setModal({ type: "edit-html", report: r })}
                      >
                        <Icon name="code" size={16} />
                      </button>
                      <button
                        type="button"
                        className="hrb-icon-btn hrb-tip"
                        data-tip="上書きアップロード"
                        aria-label="上書きアップロード"
                        onClick={() => setModal({ type: "overwrite", report: r })}
                      >
                        <Icon name="upload" size={16} />
                      </button>
                      <button
                        type="button"
                        className="hrb-icon-btn hrb-tip"
                        data-tip="タイトル・説明を編集"
                        aria-label="タイトル・説明を編集"
                        onClick={() => setModal({ type: "edit", report: r })}
                      >
                        <Icon name="pencil" size={16} />
                      </button>
                      <button
                        type="button"
                        className="hrb-icon-btn hrb-tip"
                        data-tip="削除"
                        aria-label="削除"
                        onClick={() => setModal({ type: "delete", report: r })}
                      >
                        <Icon name="trash" size={16} />
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

      {modal?.type === "edit-html" && (
        <EditHtmlModal
          key={modal.report.id}
          report={modal.report}
          open
          onClose={() => setModal(null)}
        />
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
