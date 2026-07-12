/**
 * バージョン履歴モーダル（レポート詳細シェル、owner/admin のみ）。
 * 履歴一覧（v / 日時 / サイズ / スキャン判定）と、各版の srcdoc プレビュー
 * （非公開プレビューと同じ sandbox 属性）、確認付きロールバックを提供する。
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OwnedReport, ReportVersion } from "@hrb/shared";
import { useApp } from "../app-context.tsx";
import { isApiError } from "../lib/api.ts";
import { formatBytes, formatDateTime } from "../lib/format.ts";
import { IFRAME_SANDBOX } from "../lib/sandbox.ts";
import { Button } from "./Button.tsx";
import { VerdictChip } from "./Chip.tsx";
import { Icon } from "./Icon.tsx";
import { Modal } from "./Modal.tsx";
import { useToast } from "./Toast.tsx";

type View =
  | { type: "list" }
  | { type: "preview"; entry: ReportVersion }
  | { type: "confirm"; entry: ReportVersion };

export function VersionHistoryModal({
  report,
  open,
  onClose,
}: {
  report: Pick<OwnedReport, "id" | "title">;
  open: boolean;
  onClose: () => void;
}) {
  const { api } = useApp();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>({ type: "list" });
  const [busy, setBusy] = useState(false);

  const versions = useQuery({
    queryKey: ["report-versions", report.id],
    queryFn: () => api.listReportVersions(report.id),
    enabled: open,
    retry: false,
  });
  // API は新しい順で返す。先頭が現在の版（戻す対象にならない）。
  const list = versions.data?.versions ?? [];
  const currentVersion = list[0]?.version;

  const source = useQuery({
    queryKey: ["report-version-source", report.id, view.type === "preview" ? view.entry.version : 0],
    queryFn: () =>
      api.getReportVersionSource(report.id, view.type === "preview" ? view.entry.version : 0),
    enabled: open && view.type === "preview",
    retry: false,
  });

  const close = () => {
    if (busy) return;
    setView({ type: "list" });
    onClose();
  };

  const rollback = async (entry: ReportVersion) => {
    setBusy(true);
    try {
      const result = await api.rollbackReport(report.id, entry.version);
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
      void queryClient.invalidateQueries({ queryKey: ["my-reports"] });
      void queryClient.invalidateQueries({ queryKey: ["admin-reports"] });
      void queryClient.invalidateQueries({ queryKey: ["report", report.id] });
      void queryClient.invalidateQueries({ queryKey: ["report-source", report.id] });
      void queryClient.invalidateQueries({ queryKey: ["report-versions", report.id] });
      if (result.report.status === "rejected") {
        toast.push(
          "danger",
          "復元した内容がセキュリティスキャンで拒否されました。レポートは「拒否」状態になっています",
        );
      } else {
        toast.push("success", `v${entry.version} の内容を v${result.report.version} として復元しました`);
        if (result.report.verdict === "warn") {
          toast.push("info", "スキャンで注意項目が見つかりました。内容を確認してください");
        }
      }
      setView({ type: "list" });
      onClose();
    } catch (err) {
      toast.push("danger", isApiError(err) ? err.message : "エラーが発生しました。時間をおいて再試行してください");
    } finally {
      setBusy(false);
    }
  };

  const footer =
    view.type === "list" ? (
      <Button variant="ghost" onClick={close}>
        閉じる
      </Button>
    ) : view.type === "preview" ? (
      <>
        <Button variant="ghost" onClick={() => setView({ type: "list" })}>
          一覧に戻る
        </Button>
        {view.entry.version !== currentVersion && (
          <Button onClick={() => setView({ type: "confirm", entry: view.entry })}>
            <Icon name="refresh" size={16} />
            この版に戻す
          </Button>
        )}
      </>
    ) : (
      <>
        <Button variant="ghost" disabled={busy} onClick={() => setView({ type: "list" })}>
          キャンセル
        </Button>
        <Button loading={busy} onClick={() => void rollback(view.entry)}>
          復元する
        </Button>
      </>
    );

  return (
    <Modal
      open={open}
      title={`「${report.title}」のバージョン履歴`}
      onClose={close}
      closeOnOverlay={false}
      wide
      footer={footer}
    >
      {view.type === "list" && (
        <>
          {versions.isLoading && <p className="hrb-loading">読み込み中…</p>}
          {versions.isError && (
            <p className="hrb-editor-error">
              履歴を取得できませんでした。
              {isApiError(versions.error) ? ` ${versions.error.message}` : ""}
            </p>
          )}
          {versions.isSuccess && list.length === 0 && (
            <p className="hrb-version-empty">バージョン履歴はまだありません</p>
          )}
          {list.length > 0 && (
            <div className="hrb-table-wrap">
              <table className="hrb-table">
                <thead>
                  <tr>
                    <th>バージョン</th>
                    <th>日時</th>
                    <th>サイズ</th>
                    <th>スキャン</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((v) => (
                    <tr key={v.version}>
                      <td>
                        <span className="hrb-version-label">v{v.version}</span>
                        {v.version === currentVersion && (
                          <span className="hrb-chip hrb-chip--kind">現在の版</span>
                        )}
                      </td>
                      <td className="hrb-table__date">{formatDateTime(v.createdAt)}</td>
                      <td className="hrb-table__date">{formatBytes(v.sizeBytes)}</td>
                      <td>
                        <VerdictChip verdict={v.verdict} />
                      </td>
                      <td>
                        <div className="hrb-row-actions">
                          <button
                            type="button"
                            className="hrb-icon-btn hrb-tip"
                            data-tip="プレビュー"
                            aria-label={`v${v.version} をプレビュー`}
                            onClick={() => setView({ type: "preview", entry: v })}
                          >
                            <Icon name="eye" size={16} />
                          </button>
                          <button
                            type="button"
                            className="hrb-icon-btn hrb-tip"
                            data-tip={v.version === currentVersion ? "現在の版です" : "この版に戻す"}
                            aria-label={`v${v.version} に戻す`}
                            disabled={v.version === currentVersion}
                            onClick={() => setView({ type: "confirm", entry: v })}
                          >
                            <Icon name="refresh" size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {view.type === "preview" && (
        <>
          <div className="hrb-preview-banner" role="status">
            <Icon name="clock" size={16} />
            <span>
              v{view.entry.version}（{formatDateTime(view.entry.createdAt)}）のプレビュー
              {view.entry.kind === "zip" && "（ZIP内の追加アセットはプレビューでは読み込まれません）"}
            </span>
          </div>
          {source.isLoading && <p className="hrb-loading">プレビューを読み込み中…</p>}
          {source.isError && (
            <p className="hrb-editor-error">
              プレビューを取得できませんでした。
              {isApiError(source.error) ? ` ${source.error.message}` : ""}
            </p>
          )}
          {source.isSuccess && (
            <iframe
              className="hrb-version-preview__frame"
              srcDoc={source.data.html}
              title={`${report.title} v${view.entry.version} プレビュー`}
              sandbox={IFRAME_SANDBOX}
              referrerPolicy="no-referrer"
            />
          )}
        </>
      )}

      {view.type === "confirm" && (
        <p>
          現在の内容の上に v{view.entry.version} の内容を新しい版として復元します。
          セキュリティスキャンが再実行されます
        </p>
      )}
    </Modal>
  );
}
