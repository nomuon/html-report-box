/**
 * 画面③: レポート詳細シェル (`/reports/:id`) — メタバー + sandbox iframe。
 * 公開中は共有オリジンの URL を、非公開はオーナー/管理者のみ取得できる
 * ソースを srcdoc で埋め込む（非公開プレビュー）。
 */
import { useState } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { scanFindingSummary } from "@hrb/shared";
import { useApp, useSession } from "../app-context.tsx";
import { Button } from "../components/Button.tsx";
import { StatusChip } from "../components/Chip.tsx";
import { useCopyUrl } from "../components/CopyUrlRow.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Icon } from "../components/Icon.tsx";
import { Modal } from "../components/Modal.tsx";
import { PublishToggle } from "../components/PublishToggle.tsx";
import { DetailHeaderSkeleton } from "../components/Skeleton.tsx";
import { useToast } from "../components/Toast.tsx";
import {
  EditHtmlModal,
  EditReportModal,
  OverwriteReportModal,
} from "../components/report-modals.tsx";
import { VersionHistoryModal } from "../components/VersionHistoryModal.tsx";
import { isApiError } from "../lib/api.ts";
import { formatDateTime } from "../lib/format.ts";
import { IFRAME_SANDBOX } from "../lib/sandbox.ts";

function FlagModal({ id, open, onClose }: { id: string; open: boolean; onClose: () => void }) {
  const { api } = useApp();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.flagReport(id, reason.trim() || "（理由未記入）");
      toast.push("success", "通報を受け付けました。管理者が確認します");
      setReason("");
      onClose();
    } catch (err) {
      toast.push("danger", isApiError(err) ? err.message : "エラーが発生しました。時間をおいて再試行してください");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="このレポートを通報しますか？"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void submit()}>
            通報する
          </Button>
        </>
      }
    >
      <label className="hrb-field">
        <span className="hrb-field__label">理由（任意）</span>
        <textarea
          className="hrb-input hrb-input--textarea"
          rows={3}
          value={reason}
          maxLength={1000}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
    </Modal>
  );
}

type ModalState = "flag" | "edit-html" | "edit-meta" | "overwrite" | "versions" | null;

export function ReportDetailPage() {
  const { id = "" } = useParams();
  const { api } = useApp();
  const session = useSession();
  const copyUrl = useCopyUrl();
  const [modal, setModal] = useState<ModalState>(null);

  const query = useQuery({
    queryKey: ["report", id],
    queryFn: () => api.getReport(id),
    enabled: id.length > 0,
    retry: (count, err) => !(isApiError(err) && err.status === 404) && count < 2,
  });

  // オーナー判定: API が viewer 文脈で返す isOwner を使う
  const isOwner = query.data?.isOwner ?? false;
  const canEdit = isOwner || (session?.isAdmin ?? false);

  const report = query.data?.report;
  const url = query.data?.url;

  // 非公開プレビュー: オーナー/管理者のみ、コンテンツがある場合のみ
  const wantPreview = !!report && url === undefined && canEdit && report.sha256 !== undefined;
  const source = useQuery({
    queryKey: ["report-source", id],
    queryFn: () => api.getReportSource(id),
    enabled: wantPreview,
    retry: false,
  });

  if (query.isLoading) {
    return (
      <div className="hrb-detail">
        <DetailHeaderSkeleton />
      </div>
    );
  }

  if (query.isError || !report) {
    return (
      <div className="hrb-page">
        <EmptyState icon={<Icon name="ban" size={30} />} title="このレポートは表示できません" />
      </div>
    );
  }

  const shareUrl = `${location.origin}/reports/${report.id}`;
  // published / unlisted — URL を知っていれば誰でも閲覧できる状態
  const published = report.status === "published" || report.status === "unlisted";

  const emptyDetail =
    report.status === "rejected"
      ? "セキュリティスキャンで拒否されたため表示できません。修正版のアップロードで復旧できます"
      : report.status === "takedown"
        ? "管理者によって公開停止されています"
        : canEdit
          ? "コンテンツがまだアップロードされていません"
          : "このレポートは非公開です";

  return (
    <div className="hrb-detail">
      <div className="hrb-detail__metabar">
        <div className="hrb-detail__info">
          <h1 className="hrb-detail__title">{report.title}</h1>
          <div className="hrb-detail__sub">
            <span>{report.ownerName}</span>
            <span aria-hidden="true">·</span>
            <span>更新 {formatDateTime(report.updatedAt)}</span>
            {!canEdit && (
              <>
                <span aria-hidden="true">·</span>
                <StatusChip status={report.status} />
              </>
            )}
          </div>
        </div>
        <div className="hrb-detail__actions">
          {canEdit && (
            <>
              {report.status === "published" || report.status === "unlisted" || report.status === "private" ? (
                <PublishToggle report={report} />
              ) : (
                <StatusChip status={report.status} />
              )}
              {query.data?.verdict === "warn" && (query.data.findings?.length ?? 0) > 0 && (
                <span
                  className="hrb-tip"
                  data-tip={`スキャン注意項目: ${(query.data.findings ?? []).map(scanFindingSummary).join(" / ")}`}
                  tabIndex={0}
                >
                  <Icon name="info" size={15} />
                </span>
              )}
              {report.kind === "html" && (
                <Button variant="secondary" onClick={() => setModal("edit-html")}>
                  <Icon name="code" size={16} />
                  HTMLを編集
                </Button>
              )}
              <Button variant="secondary" onClick={() => setModal("overwrite")}>
                <Icon name="upload" size={16} />
                上書きアップロード
              </Button>
              <Button variant="secondary" onClick={() => setModal("edit-meta")}>
                <Icon name="pencil" size={16} />
                タイトル・説明
              </Button>
              <Button variant="secondary" onClick={() => setModal("versions")}>
                <Icon name="clock" size={16} />
                バージョン履歴
              </Button>
            </>
          )}
          {published && (
            <Button variant="secondary" onClick={() => void copyUrl(shareUrl)}>
              <Icon name="link" size={16} />
              共有URLをコピー
            </Button>
          )}
          {published && !canEdit && (
            <Button variant="ghost-danger" onClick={() => setModal("flag")}>
              <Icon name="flag" size={16} />
              通報
            </Button>
          )}
        </div>
      </div>

      {url ? (
        <iframe
          className="hrb-detail__frame"
          src={url}
          title={report.title}
          sandbox={IFRAME_SANDBOX}
          referrerPolicy="no-referrer"
        />
      ) : wantPreview && source.isSuccess ? (
        <>
          <div className="hrb-preview-banner" role="status">
            <Icon name="eye-off" size={16} />
            <span>
              非公開プレビュー — この内容はあなたと管理者のみ閲覧できます
              {report.kind === "zip" && "（ZIP内の追加アセットはプレビューでは読み込まれません）"}
            </span>
          </div>
          <iframe
            className="hrb-detail__frame hrb-detail__frame--private"
            srcDoc={source.data.html}
            title={`${report.title}（非公開プレビュー）`}
            sandbox={IFRAME_SANDBOX}
            referrerPolicy="no-referrer"
          />
        </>
      ) : wantPreview && source.isLoading ? (
        <p className="hrb-loading">プレビューを読み込み中…</p>
      ) : (
        <EmptyState
          icon={<Icon name="eye-off" size={30} />}
          title={published ? "コンテンツを表示できません" : "このレポートは公開されていません"}
          detail={emptyDetail}
        />
      )}

      <FlagModal id={report.id} open={modal === "flag"} onClose={() => setModal(null)} />
      {canEdit && (
        <>
          <EditHtmlModal
            key={`html-${report.id}-${modal === "edit-html"}`}
            report={report}
            open={modal === "edit-html"}
            onClose={() => setModal(null)}
          />
          <EditReportModal
            key={`meta-${report.id}-${modal === "edit-meta"}`}
            report={{ id: report.id, title: report.title, description: report.description }}
            open={modal === "edit-meta"}
            onClose={() => setModal(null)}
          />
          <OverwriteReportModal
            key={`ow-${report.id}-${modal === "overwrite"}`}
            report={report}
            open={modal === "overwrite"}
            onClose={() => setModal(null)}
          />
          <VersionHistoryModal
            key={`ver-${report.id}-${modal === "versions"}`}
            report={report}
            open={modal === "versions"}
            onClose={() => setModal(null)}
          />
        </>
      )}
    </div>
  );
}
