/**
 * マイレポート内「API キー」セクション — MCP（upload_report など）から
 * このアカウントとして操作するための per-user キーの発行・一覧・失効。
 * 平文キーは発行直後のモーダルでのみ表示される（保存されるのはハッシュのみ）。
 */
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiKey } from "@hrb/shared";
import { API_KEY_NAME_MAX, MAX_API_KEYS_PER_USER } from "@hrb/shared";
import { useApp } from "../app-context.tsx";
import { isApiError } from "../lib/api.ts";
import { formatDateTime } from "../lib/format.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { Modal } from "./Modal.tsx";
import { TableSkeleton } from "./Skeleton.tsx";
import { useToast } from "./Toast.tsx";

export function ApiKeysSection() {
  const { api } = useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const query = useQuery({ queryKey: ["api-keys"], queryFn: () => api.listApiKeys() });
  const keys = query.data?.keys ?? [];

  return (
    <section className="hrb-mine-section" aria-label="API キー">
      <div className="hrb-mine-section__head">
        <div>
          <h2 className="hrb-mine-section__title">API キー</h2>
          <p className="hrb-mine-section__desc">
            MCP（upload_report など）からこのアカウントとして操作するためのキーです（最大{" "}
            {MAX_API_KEYS_PER_USER} 本）
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={keys.length >= MAX_API_KEYS_PER_USER}
          onClick={() => setCreateOpen(true)}
        >
          <Icon name="plus" size={16} /> キーを発行
        </Button>
      </div>

      {query.isLoading && <TableSkeleton columns={4} />}

      {!query.isLoading && keys.length === 0 && (
        <p className="hrb-mine-section__empty">API キーはまだありません</p>
      )}

      {keys.length > 0 && (
        <div className="hrb-table-wrap">
          <table className="hrb-table">
            <thead>
              <tr>
                <th>名前</th>
                <th>キー</th>
                <th>作成日</th>
                <th>最終使用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.keyId}>
                  <td>{k.name}</td>
                  <td>
                    <code className="hrb-apikey-prefix">{k.prefix}…</code>
                  </td>
                  <td className="hrb-table__date">{formatDateTime(k.createdAt)}</td>
                  <td className="hrb-table__date">
                    {k.lastUsedAt ? formatDateTime(k.lastUsedAt) : "未使用"}
                  </td>
                  <td>
                    <div className="hrb-row-actions">
                      <button
                        type="button"
                        className="hrb-icon-btn hrb-tip"
                        data-tip="失効"
                        aria-label="失効"
                        onClick={() => setRevoking(k)}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && <CreateApiKeyModal open onClose={() => setCreateOpen(false)} />}
      {revoking && (
        <RevokeApiKeyModal
          key={revoking.keyId}
          apiKey={revoking}
          open
          onClose={() => setRevoking(null)}
        />
      )}
    </section>
  );
}

// ---- 発行（成功後は平文をこの場でのみ表示） ----

function CreateApiKeyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { api } = useApp();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const issue = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const result = await api.createApiKey(name.trim());
      setPlaintext(result.plaintext);
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    } catch (err) {
      toast.push("danger", isApiError(err) ? err.message : "エラーが発生しました。時間をおいて再試行してください");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!plaintext) return;
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
      toast.push("success", "API キーをコピーしました");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      inputRef.current?.select();
      toast.push("danger", "コピーできませんでした。キーを選択してコピーしてください");
    }
  };

  return (
    <Modal
      open={open}
      title="API キーを発行"
      onClose={onClose}
      closeOnOverlay={false}
      footer={
        plaintext === null ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              キャンセル
            </Button>
            <Button loading={busy} disabled={!name.trim()} onClick={() => void issue()}>
              発行
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>閉じる</Button>
        )
      }
    >
      {plaintext === null ? (
        <label className="hrb-field">
          <span className="hrb-field__label">名前（用途のメモ）</span>
          <input
            className="hrb-input"
            value={name}
            maxLength={API_KEY_NAME_MAX}
            placeholder="例: Claude Code (MCP)"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      ) : (
        <>
          <p>発行しました。MCP クライアントに次のキーを設定してください:</p>
          <div className="hrb-copy-row">
            <input
              ref={inputRef}
              className="hrb-copy-row__input hrb-apikey-plaintext"
              readOnly
              value={plaintext}
              aria-label="API キー"
            />
            <Button variant="secondary" onClick={() => void copy()} className={copied ? "hrb-copy-row__done" : ""}>
              {copied ? (
                <>
                  <Icon name="check" size={16} /> コピーしました
                </>
              ) : (
                "コピー"
              )}
            </Button>
          </div>
          <div className="hrb-apikey-warning" role="alert">
            <Icon name="info" size={15} />
            このキーは二度と表示されません。今すぐコピーして安全な場所に保管してください
          </div>
        </>
      )}
    </Modal>
  );
}

// ---- 失効確認 ----

function RevokeApiKeyModal({
  apiKey,
  open,
  onClose,
}: {
  apiKey: ApiKey;
  open: boolean;
  onClose: () => void;
}) {
  const { api } = useApp();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const revoke = async () => {
    setBusy(true);
    try {
      await api.deleteApiKey(apiKey.keyId);
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      toast.push("success", "API キーを失効しました");
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
      title="API キーを失効"
      onClose={onClose}
      closeOnOverlay={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void revoke()}>
            失効
          </Button>
        </>
      }
    >
      <p>
        「{apiKey.name}」（{apiKey.prefix}…）を失効しますか？
        このキーを使う MCP クライアントは接続できなくなります。この操作は取り消せません
      </p>
    </Modal>
  );
}
