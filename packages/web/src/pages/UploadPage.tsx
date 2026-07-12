/** 画面②: アップロード (`/upload`) — D&D → メタ入力 → 進捗 → 結果 */
import { useReducer, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { UploadAbortedError, uploadToPresigned } from "../lib/upload.ts";
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
  // アップロード完了後に「公開する」を押したときの共有URL
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const fileRef = useRef<File | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 日次アップロード残数（本日あと何件アップロードできるか）
  const quotaQuery = useQuery({
    queryKey: ["my-quota"],
    queryFn: () => api.myQuota(),
    enabled: session !== null,
  });
  const quota = quotaQuery.data;
  const quotaExhausted = quota !== undefined && quota.remaining <= 0;

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
    const controller = new AbortController();
    abortRef.current = controller;
    // キャンセル時の掃除用: create 済みで complete 前の META の id
    let createdId: string | null = null;
    try {
      const created = await api.createReport({
        title: title.trim(),
        description: description.trim(),
        kind: state.file.kind,
      });
      createdId = created.report.id;
      await uploadToPresigned(
        created.upload,
        fileRef.current,
        (percent) => dispatch({ type: "PROGRESS", percent }),
        controller.signal,
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
      if (err instanceof UploadAbortedError) {
        dispatch({ type: "CANCEL_UPLOAD" });
        toast.push("info", "アップロードをキャンセルしました");
        // 未 complete の META は無害だが、消せるなら消す（失敗は無視）
        if (createdId) void api.deleteReport(createdId).catch(() => {});
        return;
      }
      dispatch({ type: "FAIL" });
      if (isApiError(err) && err.code !== "network" && err.code !== "internal") {
        toast.push("danger", err.message);
      } else {
        toast.push("danger", "アップロード処理に失敗しました。時間をおいて再試行してください");
      }
    } finally {
      // quota は create 時点で消費されるため、成否によらず残数を取り直す
      void queryClient.invalidateQueries({ queryKey: ["my-quota"] });
      abortRef.current = null;
      setBusy(false);
    }
  };

  const reset = () => {
    fileRef.current = null;
    setTitle("");
    setDescription("");
    setPublishedUrl(null);
    dispatch({ type: "RESET" });
  };

  const publishNow = async (id: string) => {
    setPublishing(true);
    try {
      await api.publishReport(id);
      setPublishedUrl(`${location.origin}/reports/${id}`);
      toast.push("success", "レポートを公開しました");
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
      void queryClient.invalidateQueries({ queryKey: ["my-reports"] });
    } catch (err) {
      toast.push("danger", isApiError(err) ? err.message : "公開に失敗しました。時間をおいて再試行してください");
    } finally {
      setPublishing(false);
    }
  };

  const resultContent =
    state.phase === "done" ? (
      publishedUrl !== null ? (
        // 公開済み → 共有URLを提示
        <div className="hrb-upload-result">
          <div className="hrb-upload-result__icon" aria-hidden="true">
            <Icon name="check-circle" size={28} />
          </div>
          <h2 className="hrb-upload-result__title">公開しました</h2>
          <p className="hrb-upload-result__body">共有URLで誰でも閲覧できます</p>
          <CopyUrlRow url={publishedUrl} />
          <div className="hrb-upload-result__actions">
            <Button onClick={() => navigate(`/reports/${state.report.id}`)}>詳細を見る</Button>
            <Button variant="secondary" onClick={reset}>
              続けてアップロード
            </Button>
          </div>
        </div>
      ) : (
        // アップロード直後は非公開 — その場で公開できる
        <div className="hrb-upload-result">
          <div className="hrb-upload-result__icon" aria-hidden="true">
            <Icon name="check-circle" size={28} />
          </div>
          <h2 className="hrb-upload-result__title">アップロードが完了しました</h2>
          <p className="hrb-upload-result__body">
            現在は<strong>非公開</strong>です。あなたと管理者だけが内容を確認できます。
            公開すると一覧・検索に表示され、共有URLで誰でも閲覧できるようになります
          </p>
          {state.report.verdict === "warn" && (
            <div className="hrb-upload-result__findings">
              <p className="hrb-upload-result__note">
                スキャンで注意項目が見つかりました。内容を確認のうえ公開してください:
              </p>
              <FindingsList findings={state.report.findings} />
            </div>
          )}
          <div className="hrb-upload-result__actions">
            <Button loading={publishing} onClick={() => void publishNow(state.report.id)}>
              <Icon name="eye" size={16} />
              公開する
            </Button>
            <Button variant="secondary" onClick={() => navigate(`/reports/${state.report.id}`)}>
              詳細を見る
            </Button>
            <Button variant="ghost" onClick={reset}>
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
        <DropZone
          state={state}
          dispatch={dispatch}
          onFiles={(f) => void handleFiles(f)}
          onCancelUpload={() => abortRef.current?.abort()}
          resultContent={resultContent}
          disabledContent={
            quotaExhausted && quota !== undefined ? (
              <>
                <div className="hrb-dropzone__icon" aria-hidden="true">
                  <Icon name="ban" size={28} />
                </div>
                <p className="hrb-dropzone__lead">
                  本日の上限（{quota.dailyUploadLimit}件）に達しました
                </p>
                <p className="hrb-dropzone__note">明日また利用できます</p>
              </>
            ) : undefined
          }
        />
        <p className="hrb-upload-note">
          <Icon name="shield-check" size={14} />
          対応形式: HTML（単一ファイル, 最大 5MB）/ ZIP（index.html 必須, 最大 20MB）· すべてのファイルは公開前にセキュリティスキャンされます
        </p>
        {quota !== undefined && !quotaExhausted && (
          <p className="hrb-upload-note hrb-upload-note--quota">
            本日あと {quota.remaining} 件アップロードできます
          </p>
        )}
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
