/**
 * 公開/非公開トグル（マイレポート・詳細シェルで共用）。
 * 公開は共有URLが開くため確認モーダルを挟み、公開範囲を選択する:
 *   published — 社内公開（一覧・検索に表示）
 *   unlisted  — リンク限定（一覧・検索に載せず、URLを知る人のみ閲覧可）
 * 公開中は「公開範囲」ボタンで published⇔unlisted を切替できる（publish の
 * 再呼び出し）。非公開化は即時実行（再度トグルすればすぐ公開に戻せる）。
 * rejected / takedown は切替不可。
 * 切替は楽観的更新: onMutate でキャッシュの status を先行更新し、
 * 失敗時はロールバック + エラー toast、onSettled で invalidate する。
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import type { PublishVisibility, ReportStatus } from "@hrb/shared";
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

const VISIBILITY_OPTIONS: Array<{
  value: PublishVisibility;
  label: string;
  detail: string;
}> = [
  {
    value: "published",
    label: "社内公開（一覧・検索に表示）",
    detail: "一覧・検索に表示され、共有URLを知っている人は誰でも閲覧できるようになります",
  },
  {
    value: "unlisted",
    label: "リンク限定（URLを知っている人のみ）",
    detail: "一覧・検索には表示されませんが、共有URLを知っている人は誰でも閲覧できます",
  },
];

type PublishAction = { type: "publish"; visibility: PublishVisibility } | { type: "unpublish" };

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
  const [visibility, setVisibility] = useState<PublishVisibility>("published");

  const isPublic = report.status === "published" || report.status === "unlisted";
  const togglable = isPublic || report.status === "private";
  const switchText =
    report.status === "published" ? "公開中" : report.status === "unlisted" ? "リンク限定" : "非公開";

  const detailKey: QueryKey = ["report", report.id];

  const mutation = useMutation({
    // 戻り値は公開時の共有 URL（非公開化は undefined）
    mutationFn: async (action: PublishAction) => {
      if (action.type === "publish") return (await api.publishReport(report.id, action.visibility)).url;
      await api.unpublishReport(report.id);
      return undefined;
    },
    onMutate: async (action) => {
      const status: ReportStatus = action.type === "publish" ? action.visibility : "private";
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
    onSuccess: (url, action) => {
      if (action.type === "publish" && url !== undefined) {
        toast.push(
          "success",
          action.visibility === "unlisted"
            ? "リンク限定で公開しました。一覧・検索には表示されず、URLを知っている人のみ閲覧できます"
            : "レポートを公開しました。共有URLで誰でも閲覧できます",
        );
        onPublished?.(url);
      } else {
        toast.push("success", "非公開にしました。内容は保持され、あなたと管理者のみ閲覧できます");
      }
    },
    onError: (err, _action, ctx) => {
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

  const openConfirm = () => {
    // 公開中は現在の公開範囲を初期選択にする
    setVisibility(report.status === "unlisted" ? "unlisted" : "published");
    setConfirming(true);
  };

  const confirm = () => {
    setConfirming(false);
    // 公開範囲の変更で現在と同じ選択なら何もしない
    if (report.status === visibility) return;
    mutation.mutate({ type: "publish", visibility });
  };

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={isPublic}
        aria-label={isPublic ? `${switchText} — クリックで非公開にする` : "非公開 — クリックで公開する"}
        className={`hrb-switch ${isPublic ? "hrb-switch--on" : ""}`}
        disabled={!togglable || mutation.isPending}
        title={togglable ? undefined : "このステータスでは公開状態を変更できません"}
        onClick={() => (isPublic ? mutation.mutate({ type: "unpublish" }) : openConfirm())}
      >
        <span className="hrb-switch__track" aria-hidden="true">
          <span className="hrb-switch__thumb" />
        </span>
        <span className="hrb-switch__text">{switchText}</span>
      </button>
      {isPublic && (
        <button
          type="button"
          className="hrb-visibility-edit"
          disabled={mutation.isPending}
          onClick={openConfirm}
        >
          公開範囲
        </button>
      )}

      <Modal
        open={confirming}
        title={isPublic ? "公開範囲を変更しますか？" : "レポートを公開しますか？"}
        onClose={() => setConfirming(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              キャンセル
            </Button>
            <Button onClick={confirm}>{isPublic ? "変更する" : "公開する"}</Button>
          </>
        }
      >
        <p>「{report.title}」の公開範囲を選択してください。いつでも非公開に戻せます</p>
        <div className="hrb-visibility-options" role="radiogroup" aria-label="公開範囲">
          {VISIBILITY_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`hrb-visibility-option ${
                visibility === opt.value ? "hrb-visibility-option--active" : ""
              }`}
            >
              <input
                type="radio"
                name="hrb-publish-visibility"
                value={opt.value}
                checked={visibility === opt.value}
                onChange={() => setVisibility(opt.value)}
              />
              <span className="hrb-visibility-option__body">
                <span className="hrb-visibility-option__label">{opt.label}</span>
                <span className="hrb-visibility-option__detail">{opt.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </Modal>
    </>
  );
}
