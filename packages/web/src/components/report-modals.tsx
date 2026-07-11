/**
 * レポート操作モーダル群（メタ編集 / 削除確認 / 上書きアップロード）。
 * マイレポートと詳細シェルで共用する。
 */
import { useReducer, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { OwnedReport } from "@hrb/shared";
import { useApp } from "../app-context.tsx";
import { isApiError } from "../lib/api.ts";
import { uploadToPresigned } from "../lib/upload.ts";
import { DROPZONE_INITIAL, dropzoneReducer, validateFiles } from "../state/dropzone.ts";
import { Button } from "./Button.tsx";
import { DropZone } from "./DropZone.tsx";
import { Icon } from "./Icon.tsx";
import { Modal } from "./Modal.tsx";
import { useToast } from "./Toast.tsx";

function useInvalidateReports() {
  const queryClient = useQueryClient();
  return (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: ["reports"] });
    void queryClient.invalidateQueries({ queryKey: ["my-reports"] });
    void queryClient.invalidateQueries({ queryKey: ["admin-reports"] });
    if (id) void queryClient.invalidateQueries({ queryKey: ["report", id] });
  };
}

// ---- メタ編集 ----

export function EditReportModal({
  report,
  open,
  onClose,
}: {
  report: Pick<OwnedReport, "id" | "title" | "description">;
  open: boolean;
  onClose: () => void;
}) {
  const { api } = useApp();
  const toast = useToast();
  const invalidate = useInvalidateReports();
  const [title, setTitle] = useState(report.title);
  const [description, setDescription] = useState(report.description);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.updateReport(report.id, { title: title.trim(), description: description.trim() });
      invalidate(report.id);
      toast.push("success", "変更を保存しました");
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
      title="レポートを編集"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button loading={busy} disabled={!title.trim()} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      <label className="hrb-field">
        <span className="hrb-field__label">タイトル</span>
        <input className="hrb-input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="hrb-field">
        <span className="hrb-field__label">説明</span>
        <textarea
          className="hrb-input hrb-input--textarea"
          rows={3}
          value={description}
          maxLength={2000}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
    </Modal>
  );
}

// ---- 削除確認 ----

export function DeleteReportModal({
  report,
  open,
  onClose,
  onDeleted,
}: {
  report: Pick<OwnedReport, "id" | "title">;
  open: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { api } = useApp();
  const toast = useToast();
  const invalidate = useInvalidateReports();
  const [busy, setBusy] = useState(false);

  const doDelete = async () => {
    setBusy(true);
    try {
      await api.deleteReport(report.id);
      invalidate(report.id);
      toast.push("success", "レポートを削除しました");
      onClose();
      onDeleted?.();
    } catch (err) {
      toast.push("danger", isApiError(err) ? err.message : "エラーが発生しました。時間をおいて再試行してください");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="レポートを削除"
      onClose={onClose}
      closeOnOverlay={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void doDelete()}>
            削除
          </Button>
        </>
      }
    >
      <p>
        「{report.title}」を削除しますか？ 共有 URL は無効になります。この操作は取り消せません
      </p>
    </Modal>
  );
}

// ---- 上書きアップロード ----

export function OverwriteReportModal({
  report,
  open,
  onClose,
}: {
  report: Pick<OwnedReport, "id" | "title">;
  open: boolean;
  onClose: () => void;
}) {
  const { api, config } = useApp();
  const toast = useToast();
  const invalidate = useInvalidateReports();
  const [state, dispatch] = useReducer(dropzoneReducer, DROPZONE_INITIAL);
  const fileRef = useRef<File | null>(null);

  const close = () => {
    dispatch({ type: "RESET" });
    fileRef.current = null;
    onClose();
  };

  // 上書きはメタ入力なし: ファイル確定で即アップロード開始
  const handleFiles = async (files: File[]) => {
    const result = validateFiles(files, {
      maxHtmlSizeBytes: config.limits.maxHtmlSizeBytes,
      maxZipSizeBytes: config.limits.maxZipSizeBytes,
    });
    if (!result.ok) {
      dispatch({ type: "DRAG_LEAVE" });
      toast.push("danger", result.message);
      return;
    }
    fileRef.current = files[0] ?? null;
    dispatch({ type: "FILE_ACCEPTED", file: result.file });
    dispatch({ type: "UPLOAD_START" });
    try {
      const { upload } = await api.createUploadUrl(report.id, result.file.kind);
      await uploadToPresigned(upload, fileRef.current!, (percent) =>
        dispatch({ type: "PROGRESS", percent }),
      );
      dispatch({ type: "UPLOADED" });
      const completed = await api.completeReport(report.id, upload.key);
      dispatch(
        completed.url !== undefined
          ? { type: "COMPLETE", report: completed.report, url: completed.url }
          : { type: "COMPLETE", report: completed.report },
      );
      invalidate(report.id);
      if (completed.report.status === "published") {
        toast.push("success", "レポートを上書きしました");
      }
    } catch (err) {
      dispatch({ type: "FAIL" });
      if (isApiError(err) && err.code !== "network" && err.code !== "internal") {
        toast.push("danger", err.message);
      } else {
        toast.push("danger", "アップロード処理に失敗しました。時間をおいて再試行してください");
      }
    }
  };

  const resultContent =
    state.phase === "done" ? (
      state.report.status === "pending_review" ? (
        <div className="hrb-upload-result hrb-upload-result--warn">
          <div className="hrb-upload-result__icon" aria-hidden="true">
            <Icon name="clock" size={28} />
          </div>
          <h2 className="hrb-upload-result__title hrb-upload-result__title--pending">
            アップロードを受け付けました — 管理者の承認待ちです
          </h2>
          <div className="hrb-upload-result__actions">
            <Button onClick={close}>閉じる</Button>
          </div>
        </div>
      ) : (
        <div className="hrb-upload-result">
          <div className="hrb-upload-result__icon" aria-hidden="true">
            <Icon name="check-circle" size={28} />
          </div>
          <h2 className="hrb-upload-result__title">上書きが完了しました</h2>
          <div className="hrb-upload-result__actions">
            <Button onClick={close}>閉じる</Button>
          </div>
        </div>
      )
    ) : state.phase === "rejected" ? (
      <div className="hrb-upload-result hrb-upload-result--rejected">
        <div className="hrb-upload-result__icon" aria-hidden="true">
          <Icon name="ban" size={28} />
        </div>
        <h2 className="hrb-upload-result__title hrb-upload-result__title--danger">
          アップロードを拒否しました
        </h2>
        <ul className="hrb-findings">
          {state.findings.map((f, i) => (
            <li key={i} className="hrb-findings__item">
              {f.message}
            </li>
          ))}
        </ul>
        <div className="hrb-upload-result__actions">
          <Button variant="secondary" onClick={() => dispatch({ type: "RESET" })}>
            別のファイルを試す
          </Button>
        </div>
      </div>
    ) : null;

  const inFlight = state.phase === "uploading" || state.phase === "scanning";

  return (
    <Modal
      open={open}
      title={`「${report.title}」を上書き`}
      onClose={() => {
        if (!inFlight) close();
      }}
      closeOnOverlay={false}
    >
      <DropZone
        small
        state={state}
        dispatch={dispatch}
        onFiles={(f) => void handleFiles(f)}
        resultContent={resultContent}
      />
      <p className="hrb-upload-note">上書きすると再スキャンが実行されます</p>
    </Modal>
  );
}
