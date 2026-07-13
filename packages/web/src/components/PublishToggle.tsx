/**
 * 公開/非公開トグル（マイレポート・詳細シェルで共用）。
 * 公開は共有URLが開くため確認モーダルを挟み、公開範囲を選択する:
 *   published — 社内公開（一覧・検索に表示）
 *   unlisted  — リンク限定（一覧・検索に載せず、URLを知る人のみ閲覧可）
 * あわせて公開期限（無期限 / 1週間 / 1ヶ月 / 日時指定）を選択できる。
 * 期限を過ぎると一覧・検索・閲覧から消える（遅延失効 — 再公開で復活可）。
 * 公開中は「公開範囲」ボタンで published⇔unlisted の切替や期限の再設定が
 * できる（publish の再呼び出し）。非公開化は即時実行（再度トグルすれば
 * すぐ公開に戻せる）。rejected / takedown は切替不可。
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

type PublishAction =
  | { type: "publish"; visibility: PublishVisibility; expiresAt?: string }
  | { type: "unpublish" };

/** 公開期限プリセット。custom は datetime-local 入力で日時を指定する。 */
type ExpiryPreset = "none" | "week" | "month" | "custom";

const EXPIRY_OPTIONS: Array<{ value: ExpiryPreset; label: string }> = [
  { value: "none", label: "無期限" },
  { value: "week", label: "1週間" },
  { value: "month", label: "1ヶ月" },
  { value: "custom", label: "日時指定" },
];

/** Date → input[type=datetime-local] 値（ローカル時刻の "YYYY-MM-DDTHH:mm"）。 */
function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface PublishToggleProps {
  report: { id: string; title: string; status: ReportStatus; expiresAt?: string };
  /** 公開成功時に共有URLなどを受け取りたい画面向け。 */
  onPublished?: (url: string) => void;
}

export function PublishToggle({ report, onPublished }: PublishToggleProps) {
  const { api } = useApp();
  const toast = useToast();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [visibility, setVisibility] = useState<PublishVisibility>("published");
  const [expiryPreset, setExpiryPreset] = useState<ExpiryPreset>("none");
  const [customExpiry, setCustomExpiry] = useState("");
  const [expiryError, setExpiryError] = useState<string | null>(null);

  const isPublic = report.status === "published" || report.status === "unlisted";
  const togglable = isPublic || report.status === "private";
  const switchText =
    report.status === "published" ? "公開中" : report.status === "unlisted" ? "リンク限定" : "非公開";

  const detailKey: QueryKey = ["report", report.id];

  const mutation = useMutation({
    // 戻り値は公開時の共有 URL（非公開化は undefined）
    mutationFn: async (action: PublishAction) => {
      if (action.type === "publish") {
        return (await api.publishReport(report.id, action.visibility, action.expiresAt)).url;
      }
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
    // 公開中は現在の公開範囲・期限を初期選択にする（期限切れの再公開は無期限から）
    setVisibility(report.status === "unlisted" ? "unlisted" : "published");
    const active = report.expiresAt !== undefined && Date.parse(report.expiresAt) > Date.now();
    setExpiryPreset(active ? "custom" : "none");
    setCustomExpiry(active ? toDatetimeLocalValue(new Date(report.expiresAt!)) : "");
    setExpiryError(null);
    setConfirming(true);
  };

  /** プリセットから expiresAt (ISO 8601) を組み立てる。不正な日時指定は null。 */
  const resolveExpiresAt = (): string | undefined | null => {
    if (expiryPreset === "none") return undefined;
    if (expiryPreset === "week") {
      return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    }
    if (expiryPreset === "month") {
      const d = new Date();
      d.setMonth(d.getMonth() + 1);
      return d.toISOString();
    }
    const parsed = customExpiry.length > 0 ? Date.parse(customExpiry) : Number.NaN;
    if (Number.isNaN(parsed)) return null;
    if (parsed <= Date.now()) return null;
    return new Date(parsed).toISOString();
  };

  const confirm = () => {
    const expiresAt = resolveExpiresAt();
    if (expiresAt === null) {
      setExpiryError("未来の日時を指定してください");
      return;
    }
    setConfirming(false);
    // 公開範囲・期限とも現在と同じなら何もしない
    if (report.status === visibility && report.expiresAt === expiresAt) return;
    mutation.mutate({
      type: "publish",
      visibility,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
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
        <div className="hrb-expiry">
          <span className="hrb-expiry__label">公開期限</span>
          <div className="hrb-expiry__options" role="radiogroup" aria-label="公開期限">
            {EXPIRY_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`hrb-expiry-option ${
                  expiryPreset === opt.value ? "hrb-expiry-option--active" : ""
                }`}
              >
                <input
                  type="radio"
                  name="hrb-publish-expiry"
                  value={opt.value}
                  checked={expiryPreset === opt.value}
                  onChange={() => {
                    setExpiryPreset(opt.value);
                    setExpiryError(null);
                  }}
                />
                {opt.label}
              </label>
            ))}
          </div>
          {expiryPreset === "custom" && (
            <input
              type="datetime-local"
              className="hrb-input hrb-expiry__input"
              aria-label="公開期限の日時"
              value={customExpiry}
              min={toDatetimeLocalValue(new Date())}
              onChange={(e) => {
                setCustomExpiry(e.target.value);
                setExpiryError(null);
              }}
            />
          )}
          {expiryError !== null && (
            <p className="hrb-expiry__error" role="alert">
              {expiryError}
            </p>
          )}
          <span className="hrb-expiry__detail">
            期限を過ぎると自動的に一覧・検索・閲覧から外れます（再公開で戻せます）
          </span>
        </div>
      </Modal>
    </>
  );
}
