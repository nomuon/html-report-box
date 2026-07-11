/**
 * 公開/非公開トグル（マイレポート・詳細シェルで共用）。
 * 公開は共有URLが全社に開くため確認モーダルを挟む。非公開化は即時実行
 * （再度トグルすればすぐ公開に戻せる）。rejected / takedown は切替不可。
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReportStatus } from "@hrb/shared";
import { useApp } from "../app-context.tsx";
import { isApiError } from "../lib/api.ts";
import { Button } from "./Button.tsx";
import { Modal } from "./Modal.tsx";
import { useToast } from "./Toast.tsx";

const GENERIC_ERROR = "エラーが発生しました。時間をおいて再試行してください";

export interface PublishToggleProps {
  report: { id: string; title: string; status: ReportStatus };
  /** 公開成功時に共有URLなどを受け取りたい画面向け。 */
  onPublished?: (url: string) => void;
}

export function PublishToggle({ report, onPublished }: PublishToggleProps) {
  const { api } = useApp();
  const toast = useToast();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const published = report.status === "published";
  const togglable = published || report.status === "private";

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["reports"] });
    void qc.invalidateQueries({ queryKey: ["my-reports"] });
    void qc.invalidateQueries({ queryKey: ["admin-reports"] });
    void qc.invalidateQueries({ queryKey: ["report", report.id] });
  };

  const run = async (next: boolean) => {
    setBusy(true);
    try {
      if (next) {
        const { url } = await api.publishReport(report.id);
        toast.push("success", "レポートを公開しました。共有URLで誰でも閲覧できます");
        onPublished?.(url);
      } else {
        await api.unpublishReport(report.id);
        toast.push("success", "非公開にしました。内容は保持され、あなたと管理者のみ閲覧できます");
      }
      invalidate();
    } catch (err) {
      toast.push("danger", isApiError(err) ? err.message : GENERIC_ERROR);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={published}
        aria-label={published ? "公開中 — クリックで非公開にする" : "非公開 — クリックで公開する"}
        className={`hrb-switch ${published ? "hrb-switch--on" : ""}`}
        disabled={!togglable || busy}
        title={togglable ? undefined : "このステータスでは公開状態を変更できません"}
        onClick={() => (published ? void run(false) : setConfirming(true))}
      >
        <span className="hrb-switch__track" aria-hidden="true">
          <span className="hrb-switch__thumb" />
        </span>
        <span className="hrb-switch__text">{published ? "公開中" : "非公開"}</span>
      </button>

      <Modal
        open={confirming}
        title="レポートを公開しますか？"
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              キャンセル
            </Button>
            <Button loading={busy} onClick={() => void run(true)}>
              公開する
            </Button>
          </>
        }
      >
        <p>
          「{report.title}
          」を公開すると、一覧・検索に表示され、共有URLを知っている人は誰でも閲覧できるようになります。いつでも非公開に戻せます
        </p>
      </Modal>
    </>
  );
}
