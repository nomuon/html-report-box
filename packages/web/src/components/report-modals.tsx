/**
 * レポート操作モーダル群（メタ編集 / HTML直接編集 / 削除確認 / 上書きアップロード）。
 * マイレポートと詳細シェルで共用する。
 */
import { useReducer, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OwnedReport, ScanFinding } from "@hrb/shared";
import { useApp } from "../app-context.tsx";
import { isApiError } from "../lib/api.ts";
import { UploadAbortedError, uploadToPresigned } from "../lib/upload.ts";
import { DROPZONE_INITIAL, dropzoneReducer, validateFiles } from "../state/dropzone.ts";
import { Button } from "./Button.tsx";
import { DropZone } from "./DropZone.tsx";
import { FindingsList } from "./FindingsList.tsx";
import { Icon } from "./Icon.tsx";
import { Modal } from "./Modal.tsx";
import { TagInput } from "./TagInput.tsx";
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
  report: Pick<OwnedReport, "id" | "title" | "description" | "tags">;
  open: boolean;
  onClose: () => void;
}) {
  const { api } = useApp();
  const toast = useToast();
  const invalidate = useInvalidateReports();
  const [title, setTitle] = useState(report.title);
  const [description, setDescription] = useState(report.description);
  const [tags, setTags] = useState<string[]>(report.tags);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.updateReport(report.id, { title: title.trim(), description: description.trim(), tags });
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
      title="タイトル・説明・タグを編集"
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
      <div className="hrb-field">
        <span className="hrb-field__label">タグ</span>
        <TagInput tags={tags} onChange={setTags} />
      </div>
    </Modal>
  );
}

// ---- HTML 直接編集 ----

export function EditHtmlModal({
  report,
  open,
  onClose,
}: {
  report: Pick<OwnedReport, "id" | "title" | "kind" | "status">;
  open: boolean;
  onClose: () => void;
}) {
  const { api } = useApp();
  const toast = useToast();
  const invalidate = useInvalidateReports();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectedFindings, setRejectedFindings] = useState<ScanFinding[] | null>(null);

  const source = useQuery({
    queryKey: ["report-source", report.id],
    queryFn: () => api.getReportSource(report.id),
    enabled: open,
    retry: (count, err) => !(isApiError(err) && err.status < 500) && count < 3,
  });
  // 原本が失われたレポート（拒否後など）は空のエディタから書き直せる
  const sourceMissing =
    source.isError && isApiError(source.error) && source.error.code === "not_found";
  const editable = source.isSuccess || sourceMissing;
  const value = draft ?? source.data?.html ?? "";
  const dirty = draft !== null && draft !== (source.data?.html ?? "");

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setRejectedFindings(null);
    try {
      const result = await api.updateReportContent(report.id, value);
      invalidate(report.id);
      void queryClient.invalidateQueries({ queryKey: ["report-source", report.id] });
      if (result.report.status === "rejected") {
        // 編集内容は残したまま検知内容を表示（修正して再保存できる）
        setRejectedFindings(result.report.findings);
      } else {
        toast.push(
          "success",
          result.report.status === "published" || result.report.status === "unlisted"
            ? "保存しました。公開中の内容を更新しました"
            : "保存しました（非公開のまま）",
        );
        if (result.report.verdict === "warn") {
          toast.push("info", "スキャンで注意項目が見つかりました。内容を確認してください");
        }
        setDraft(null);
        onClose();
      }
    } catch (err) {
      toast.push("danger", isApiError(err) ? err.message : "エラーが発生しました。時間をおいて再試行してください");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`「${report.title}」の HTML を編集`}
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnOverlay={false}
      wide
      footer={
        <>
          <span className="hrb-editor-note">保存すると再スキャンが実行されます</span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button loading={busy} disabled={!value.trim() || source.isLoading || !dirty} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      {source.isLoading && <p className="hrb-loading">読み込み中…</p>}
      {source.isError && !sourceMissing && (
        <p className="hrb-editor-error">
          ソースを取得できませんでした。
          {isApiError(source.error) ? ` ${source.error.message}` : ""}
        </p>
      )}
      {sourceMissing && (
        <div className="hrb-editor-notice" role="status">
          <strong>保存済みの原本が見つかりません。</strong>
          新しい HTML を入力して保存すると、この内容でレポートを置き換えます
        </div>
      )}
      {editable && (
        <>
          <textarea
            className="hrb-input hrb-editor"
            value={value}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="HTML ソース"
          />
          {rejectedFindings && (
            <div className="hrb-editor-rejected" role="alert">
              <strong>セキュリティスキャンで拒否されました。</strong>
              修正して保存し直すまでレポートは非公開の「拒否」状態になります
              <FindingsList findings={rejectedFindings} />
            </div>
          )}
        </>
      )}
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
  const abortRef = useRef<AbortController | null>(null);

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
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { upload } = await api.createUploadUrl(report.id, result.file.kind);
      await uploadToPresigned(
        upload,
        fileRef.current!,
        (percent) => dispatch({ type: "PROGRESS", percent }),
        controller.signal,
      );
      dispatch({ type: "UPLOADED" });
      const completed = await api.completeReport(report.id, upload.key);
      dispatch(
        completed.url !== undefined
          ? { type: "COMPLETE", report: completed.report, url: completed.url }
          : { type: "COMPLETE", report: completed.report },
      );
      invalidate(report.id);
      if (completed.report.status !== "rejected") {
        toast.push("success", "レポートを上書きしました");
      }
    } catch (err) {
      if (err instanceof UploadAbortedError) {
        // 上書きのキャンセル: 既存レポートには手を付けず idle に戻すだけ
        dispatch({ type: "RESET" });
        toast.push("info", "アップロードをキャンセルしました");
        return;
      }
      dispatch({ type: "FAIL" });
      if (isApiError(err) && err.code !== "network" && err.code !== "internal") {
        toast.push("danger", err.message);
      } else {
        toast.push("danger", "アップロード処理に失敗しました。時間をおいて再試行してください");
      }
    } finally {
      abortRef.current = null;
    }
  };

  const resultContent =
    state.phase === "done" ? (
      <div className="hrb-upload-result">
        <div className="hrb-upload-result__icon" aria-hidden="true">
          <Icon name="check-circle" size={28} />
        </div>
        <h2 className="hrb-upload-result__title">上書きが完了しました</h2>
        <p className="hrb-upload-result__body">
          {state.report.status === "published" || state.report.status === "unlisted"
            ? "公開中の内容を新しいファイルで更新しました"
            : "このレポートは非公開のままです。公開トグルでいつでも公開できます"}
        </p>
        {state.report.verdict === "warn" && (
          <div className="hrb-upload-result__findings">
            <p className="hrb-upload-result__note">スキャンで注意項目が見つかりました:</p>
            <FindingsList findings={state.report.findings} />
          </div>
        )}
        <div className="hrb-upload-result__actions">
          <Button onClick={close}>閉じる</Button>
        </div>
      </div>
    ) : state.phase === "rejected" ? (
      <div className="hrb-upload-result hrb-upload-result--rejected">
        <div className="hrb-upload-result__icon" aria-hidden="true">
          <Icon name="ban" size={28} />
        </div>
        <h2 className="hrb-upload-result__title hrb-upload-result__title--danger">
          アップロードを拒否しました
        </h2>
        <FindingsList findings={state.findings} />
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
        onCancelUpload={() => abortRef.current?.abort()}
        resultContent={resultContent}
      />
      <p className="hrb-upload-note">上書きすると再スキャンが実行されます</p>
    </Modal>
  );
}
