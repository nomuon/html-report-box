/** 画面③: レポート詳細シェル (`/reports/:id`) — メタバー + sandbox iframe */
import { useState } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useApp, useSession } from "../app-context.tsx";
import { Button } from "../components/Button.tsx";
import { StatusChip } from "../components/Chip.tsx";
import { useCopyUrl } from "../components/CopyUrlRow.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Icon } from "../components/Icon.tsx";
import { Modal } from "../components/Modal.tsx";
import { useToast } from "../components/Toast.tsx";
import { EditReportModal } from "../components/report-modals.tsx";
import { isApiError } from "../lib/api.ts";
import { formatDateTime } from "../lib/format.ts";

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

export function ReportDetailPage() {
  const { id = "" } = useParams();
  const { api } = useApp();
  const session = useSession();
  const copyUrl = useCopyUrl();
  const [flagOpen, setFlagOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const query = useQuery({
    queryKey: ["report", id],
    queryFn: () => api.getReport(id),
    enabled: id.length > 0,
    retry: (count, err) => !(isApiError(err) && err.status === 404) && count < 2,
  });

  // オーナー判定: 自分のレポート一覧に含まれるか（PublicReport は ownerSub を持たない）
  const mine = useQuery({
    queryKey: ["my-reports", "first-page"],
    queryFn: () => api.myReports({ limit: 100 }),
    enabled: session !== null,
  });
  const isOwner = mine.data?.reports.some((r) => r.id === id) ?? false;
  const canEdit = isOwner || (session?.isAdmin ?? false);

  if (query.isLoading) {
    return (
      <div className="hrb-page">
        <p className="hrb-loading">読み込み中…</p>
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="hrb-page">
        <EmptyState icon={<Icon name="ban" size={30} />} title="このレポートは表示できません" />
      </div>
    );
  }

  const { report, url } = query.data;
  const shareUrl = `${location.origin}/reports/${report.id}`;

  return (
    <div className="hrb-detail">
      <div className="hrb-detail__metabar">
        <div className="hrb-detail__info">
          <h1 className="hrb-detail__title">{report.title}</h1>
          <div className="hrb-detail__sub">
            <span>{report.ownerName}</span>
            <span aria-hidden="true">·</span>
            <span>更新 {formatDateTime(report.updatedAt)}</span>
            <span aria-hidden="true">·</span>
            <StatusChip status={report.status} />
          </div>
        </div>
        <div className="hrb-detail__actions">
          {canEdit && (
            <Button variant="secondary" onClick={() => setEditOpen(true)}>
              編集
            </Button>
          )}
          <Button variant="secondary" onClick={() => void copyUrl(shareUrl)}>
            <Icon name="link" size={16} />
            共有URLをコピー
          </Button>
          <Button variant="ghost-danger" onClick={() => setFlagOpen(true)}>
            <Icon name="flag" size={16} />
            通報
          </Button>
        </div>
      </div>

      {url ? (
        <iframe
          className="hrb-detail__frame"
          src={url}
          title={report.title}
          sandbox="allow-scripts allow-forms allow-popups allow-modals"
          referrerPolicy="no-referrer"
        />
      ) : (
        <EmptyState
          icon={<Icon name="clock" size={30} />}
          title="このレポートはまだ公開されていません"
          detail={
            report.status === "pending_review"
              ? "管理者の承認待ちです。承認されると公開されます"
              : report.status === "processing"
                ? "アップロード処理中です"
                : "コンテンツは現在表示できません"
          }
        />
      )}

      <FlagModal id={report.id} open={flagOpen} onClose={() => setFlagOpen(false)} />
      {canEdit && (
        <EditReportModal
          key={`${report.id}-${editOpen}`}
          report={{ id: report.id, title: report.title, description: report.description }}
          open={editOpen}
          onClose={() => setEditOpen(false)}
        />
      )}
    </div>
  );
}
