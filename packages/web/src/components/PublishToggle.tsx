/**
 * 公開/非公開トグル（マイレポート・詳細シェルで共用）。
 * 公開は共有URLが全社に開くため確認モーダルを挟む。非公開化は即時実行
 * （再度トグルすればすぐ公開に戻せる）。rejected / takedown は切替不可。
 * 切替は楽観的更新: onMutate でキャッシュの status を先行更新し、
 * 失敗時はロールバック + エラー toast、onSettled で invalidate する。
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import type { ReportStatus } from "@hrb/shared";
import { useApp } from "../app-context.tsx";
import { isApiError } from "../lib/api.ts";
import {
  patchReportStatusInDetail,
  patchReportStatusInPages,
  type ReportDetailData,
  type ReportListPages,
} from "../state/report-cache.ts";
import { Button } from "./Button.tsx";
import { Modal } from "./Modal.tsx";
import { useToast } from "./Toast.tsx";

const GENERIC_ERROR = "エラーが発生しました。時間をおいて再試行してください";

/** status を先行更新する一覧キャッシュのキー接頭辞。 */
const LIST_KEY_PREFIXES: QueryKey[] = [["reports"], ["my-reports"], ["admin-reports"]];

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

  const published = report.status === "published";
  const togglable = published || report.status === "private";

  const detailKey: QueryKey = ["report", report.id];

  const mutation = useMutation({
    // 戻り値は公開時の共有 URL（非公開化は undefined）
    mutationFn: async (next: boolean) => {
      if (next) return (await api.publishReport(report.id)).url;
      await api.unpublishReport(report.id);
      return undefined;
    },
    onMutate: async (next) => {
      const status: ReportStatus = next ? "published" : "private";
      await Promise.all(
        [...LIST_KEY_PREFIXES, detailKey].map((queryKey) => qc.cancelQueries({ queryKey })),
      );
      // ロールバック用スナップショット（接頭辞に一致する全キー分）
      const snapshots = [...LIST_KEY_PREFIXES, detailKey].flatMap((queryKey) =>
        qc.getQueriesData({ queryKey }),
      );
      for (const queryKey of LIST_KEY_PREFIXES) {
        qc.setQueriesData({ queryKey }, (old: unknown) =>
          patchReportStatusInPages(old as ReportListPages | undefined, report.id, status),
        );
      }
      qc.setQueryData(detailKey, (old: unknown) =>
        patchReportStatusInDetail(old as ReportDetailData | undefined, report.id, status),
      );
      return { snapshots };
    },
    onSuccess: (url, next) => {
      if (next && url !== undefined) {
        toast.push("success", "レポートを公開しました。共有URLで誰でも閲覧できます");
        onPublished?.(url);
      } else {
        toast.push("success", "非公開にしました。内容は保持され、あなたと管理者のみ閲覧できます");
      }
    },
    onError: (err, _next, ctx) => {
      for (const [queryKey, data] of ctx?.snapshots ?? []) {
        qc.setQueryData(queryKey, data);
      }
      toast.push("danger", isApiError(err) ? err.message : GENERIC_ERROR);
    },
    onSettled: () => {
      for (const queryKey of LIST_KEY_PREFIXES) void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: detailKey });
    },
  });

  const run = (next: boolean) => {
    setConfirming(false);
    mutation.mutate(next);
  };

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={published}
        aria-label={published ? "公開中 — クリックで非公開にする" : "非公開 — クリックで公開する"}
        className={`hrb-switch ${published ? "hrb-switch--on" : ""}`}
        disabled={!togglable || mutation.isPending}
        title={togglable ? undefined : "このステータスでは公開状態を変更できません"}
        onClick={() => (published ? run(false) : setConfirming(true))}
      >
        <span className="hrb-switch__track" aria-hidden="true">
          <span className="hrb-switch__thumb" />
        </span>
        <span className="hrb-switch__text">{published ? "公開中" : "非公開"}</span>
      </button>

      <Modal
        open={confirming}
        title="レポートを公開しますか？"
        onClose={() => setConfirming(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              キャンセル
            </Button>
            <Button onClick={() => run(true)}>公開する</Button>
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
