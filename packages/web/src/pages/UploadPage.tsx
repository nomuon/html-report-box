/** 画面②: アップロード (`/upload`) — D&D → メタ入力 → 進捗 → 結果 */
import { useReducer, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ScanFinding } from "@hrb/shared";
import { useApp, useSession } from "../app-context.tsx";
import { Button } from "../components/Button.tsx";
import { CopyUrlRow } from "../components/CopyUrlRow.tsx";
import { DropZone } from "../components/DropZone.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { LoginModal } from "../components/Header.tsx";
import { Icon } from "../components/Icon.tsx";
import { useToast } from "../components/Toast.tsx";
import { extractHtmlTitle, titleFromFilename } from "../lib/html-title.ts";
import { uploadToPresigned } from "../lib/upload.ts";
import { isApiError } from "../lib/api.ts";
import { DROPZONE_INITIAL, dropzoneReducer, validateFiles } from "../state/dropzone.ts";

export function FindingsList({ findings }: { findings: ScanFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <ul className="hrb-findings">
      {findings.map((f, i) => (
        <li key={i} className="hrb-findings__item">
          {f.message}
        </li>
      ))}
    </ul>
  );
}

export function UploadPage() {
  const { api, config } = useApp();
  const session = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [state, dispatch] = useReducer(dropzoneReducer, DROPZONE_INITIAL);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const fileRef = useRef<File | null>(null);

  if (!session) {
    return (
      <div className="hrb-page">
        <EmptyState
          icon={<Icon name="lock" size={30} />}
          title="ログインが必要です"
          detail="レポートのアップロードには Google アカウントでのログインが必要です"
          action={<Button onClick={() => setLoginOpen(true)}>Google でログイン</Button>}
        />
        <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      </div>
    );
  }

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
    // <title> からタイトル自動補完（編集可）
    let auto = titleFromFilename(result.file.name);
    if (result.file.kind === "html" && fileRef.current) {
      try {
        const text = await fileRef.current.text();
        auto = extractHtmlTitle(text) ?? auto;
      } catch {
        // 読み取り失敗時はファイル名フォールバック
      }
    }
    setTitle((prev) => (prev.trim() ? prev : auto));
  };

  const startUpload = async () => {
    if (state.phase !== "selected" || !fileRef.current || !title.trim()) return;
    setBusy(true);
    dispatch({ type: "UPLOAD_START" });
    try {
      const created = await api.createReport({
        title: title.trim(),
        description: description.trim(),
        kind: state.file.kind,
      });
      await uploadToPresigned(created.upload, fileRef.current, (percent) =>
        dispatch({ type: "PROGRESS", percent }),
      );
      dispatch({ type: "UPLOADED" });
      const completed = await api.completeReport(created.report.id, created.upload.key);
      dispatch(
        completed.url !== undefined
          ? { type: "COMPLETE", report: completed.report, url: completed.url }
          : { type: "COMPLETE", report: completed.report },
      );
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
      void queryClient.invalidateQueries({ queryKey: ["my-reports"] });
    } catch (err) {
      dispatch({ type: "FAIL" });
      if (isApiError(err) && err.code !== "network" && err.code !== "internal") {
        toast.push("danger", err.message);
      } else {
        toast.push("danger", "アップロード処理に失敗しました。時間をおいて再試行してください");
      }
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    fileRef.current = null;
    setTitle("");
    setDescription("");
    dispatch({ type: "RESET" });
  };

  const shareUrl =
    state.phase === "done" ? `${location.origin}/reports/${state.report.id}` : "";

  const resultContent =
    state.phase === "done" ? (
      state.report.status === "pending_review" ? (
        // verdict=warn → 承認待ち表示（§4.4）
        <div className="hrb-upload-result hrb-upload-result--warn">
          <div className="hrb-upload-result__icon" aria-hidden="true">
            <Icon name="clock" size={28} />
          </div>
          <h2 className="hrb-upload-result__title hrb-upload-result__title--pending">
            アップロードを受け付けました — 管理者の承認待ちです
          </h2>
          <p className="hrb-upload-result__body">
            セキュリティスキャンで確認が必要な項目が見つかったため、管理者が内容を確認してから公開されます。
            公開されるまで共有 URL は他のユーザーには表示されません。状況は「マイレポート」で確認できます
          </p>
          <div className="hrb-upload-result__findings">
            <FindingsList findings={state.report.findings} />
          </div>
          <div className="hrb-upload-result__actions">
            <Button onClick={() => navigate("/mine")}>マイレポートへ</Button>
            <Button variant="ghost" onClick={reset}>
              続けてアップロード
            </Button>
          </div>
        </div>
      ) : (
        <div className="hrb-upload-result">
          <div className="hrb-upload-result__icon" aria-hidden="true">
            <Icon name="check-circle" size={28} />
          </div>
          <h2 className="hrb-upload-result__title">アップロードが完了しました</h2>
          <CopyUrlRow url={shareUrl} />
          <div className="hrb-upload-result__actions">
            <Button onClick={() => navigate(`/reports/${state.report.id}`)}>詳細を見る</Button>
            <Button variant="secondary" onClick={reset}>
              続けてアップロード
            </Button>
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
        <FindingsList findings={state.findings} />
        <div className="hrb-upload-result__actions">
          <Button variant="secondary" onClick={reset}>
            別のファイルを試す
          </Button>
        </div>
      </div>
    ) : null;

  return (
    <div className="hrb-page hrb-page--upload">
      <h1 className="hrb-page__title">レポートをアップロード</h1>

      <div className="hrb-upload-zone">
        <DropZone state={state} dispatch={dispatch} onFiles={(f) => void handleFiles(f)} resultContent={resultContent} />
        <p className="hrb-upload-note">
          <Icon name="shield-check" size={14} />
          対応形式: HTML（単一ファイル, 最大 5MB）/ ZIP（index.html 必須, 最大 20MB）· すべてのファイルは公開前にセキュリティスキャンされます
        </p>
      </div>

      {state.phase === "selected" && (
        <form
          className="hrb-upload-form"
          onSubmit={(e) => {
            e.preventDefault();
            void startUpload();
          }}
        >
          <label className="hrb-field">
            <span className="hrb-field__label">タイトル（必須）</span>
            <input
              className="hrb-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
            />
          </label>
          <label className="hrb-field">
            <span className="hrb-field__label">説明（任意）</span>
            <textarea
              className="hrb-input hrb-input--textarea"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          </label>
          <div className="hrb-upload-form__actions">
            <Button type="submit" loading={busy} disabled={!title.trim()}>
              アップロード
            </Button>
            <Button variant="ghost" onClick={reset}>
              キャンセル
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
