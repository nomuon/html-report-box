/** 画面⑤: 管理画面 (`/admin`) — 通報 / 全レポート / ユーザー管理 */
import { useState } from "react";
import { Link } from "react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminReport, AdminUser, ReportStatus } from "@hrb/shared";
import { REPORT_STATUSES } from "@hrb/shared";
import { useApp, useSession } from "../app-context.tsx";
import { Button } from "../components/Button.tsx";
import { KindChip, STATUS_LABELS, StatusChip } from "../components/Chip.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Icon } from "../components/Icon.tsx";
import { Modal } from "../components/Modal.tsx";
import { TableSkeleton } from "../components/Skeleton.tsx";
import { useToast } from "../components/Toast.tsx";
import { isApiError } from "../lib/api.ts";
import { formatDateTime } from "../lib/format.ts";

type Tab = "flagged" | "all" | "users";

type Confirm =
  | { kind: "takedown" | "clear-flags"; report: AdminReport }
  | { kind: "set-admin"; user: AdminUser; isAdmin: boolean }
  | { kind: "delete-user"; user: AdminUser }
  | null;

const GENERIC_ERROR = "エラーが発生しました。時間をおいて再試行してください";
const PAGE_LIMIT = 50;

interface LoadMoreQuery {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
}

/** useInfiniteQuery の次ページ読み込みボタン（次ページが無ければ非表示） */
function LoadMore({ query }: { query: LoadMoreQuery }) {
  if (!query.hasNextPage) return null;
  return (
    <div className="hrb-load-more">
      <Button
        variant="secondary"
        loading={query.isFetchingNextPage}
        onClick={() => void query.fetchNextPage()}
      >
        さらに読み込む
      </Button>
    </div>
  );
}

function useAdminInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["admin-reports"] });
    void qc.invalidateQueries({ queryKey: ["admin-flagged"] });
    void qc.invalidateQueries({ queryKey: ["reports"] });
    void qc.invalidateQueries({ queryKey: ["my-reports"] });
  };
}

// ---- 通報（abuse flags のあるレポート一覧） ----

function FlaggedTab({ onConfirm }: { onConfirm: (c: Confirm) => void }) {
  const { api } = useApp();
  const [flagsFor, setFlagsFor] = useState<AdminReport | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["admin-flagged"],
    queryFn: ({ pageParam }) => api.adminListFlagged({ limit: PAGE_LIMIT, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  if (query.isLoading) return <TableSkeleton columns={6} />;
  if (items.length === 0)
    return <EmptyState icon={<Icon name="check-circle" size={30} />} title="未対応の通報はありません" />;

  return (
    <div>
      <div className="hrb-table-wrap">
        <table className="hrb-table">
          <thead>
            <tr>
              <th>タイトル</th>
              <th>作成者</th>
              <th>ステータス</th>
              <th>通報</th>
              <th>最終通報日時</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map(({ report: r, flags }) => {
              const latest = flags.reduce((max, f) => (f.createdAt > max ? f.createdAt : max), "");
              return (
                <tr key={r.id}>
                  <td>
                    <Link to={`/reports/${r.id}`} className="hrb-table__title">
                      {r.title}
                    </Link>
                  </td>
                  <td>{r.ownerName}</td>
                  <td>
                    <StatusChip status={r.status} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="hrb-flag-count"
                      title={flags[flags.length - 1]?.reason}
                      onClick={() => setFlagsFor(r)}
                    >
                      <Icon name="flag" size={14} />
                      {flags.length}件
                    </button>
                  </td>
                  <td className="hrb-table__date">{latest ? formatDateTime(latest) : "-"}</td>
                  <td>
                    <div className="hrb-row-actions">
                      <Link to={`/reports/${r.id}`} target="_blank" rel="noreferrer">
                        <Button variant="secondary">プレビュー</Button>
                      </Link>
                      {r.status === "published" && (
                        <Button
                          variant="danger"
                          onClick={() => onConfirm({ kind: "takedown", report: r })}
                        >
                          テイクダウン
                        </Button>
                      )}
                      <Button variant="ghost" onClick={() => onConfirm({ kind: "clear-flags", report: r })}>
                        通報を解決
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <LoadMore query={query} />
      {flagsFor && <FlagsModal report={flagsFor} onClose={() => setFlagsFor(null)} />}
    </div>
  );
}

// ---- 全レポート ----

function FlagsModal({ report, onClose }: { report: AdminReport; onClose: () => void }) {
  const { api } = useApp();
  const query = useQuery({
    queryKey: ["admin-flags", report.id],
    queryFn: () => api.adminListFlags(report.id),
  });
  const flags = query.data?.flags ?? [];
  return (
    <Modal open title={`「${report.title}」の通報一覧`} onClose={onClose}>
      {query.isLoading && <p className="hrb-loading">読み込み中…</p>}
      {!query.isLoading && flags.length === 0 && <p>通報はありません</p>}
      {flags.length > 0 && (
        <ul className="hrb-flag-list">
          {flags.map((f, i) => (
            <li key={i} className="hrb-flag-list__item">
              <div className="hrb-flag-list__date">{formatDateTime(f.createdAt)}</div>
              <div>{f.reason}</div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function AllReportsTab({ onConfirm }: { onConfirm: (c: Confirm) => void }) {
  const { api } = useApp();
  // undefined = すべて（サーバー側 status フィルタ未指定）
  const [status, setStatus] = useState<ReportStatus | undefined>(undefined);

  const query = useInfiniteQuery({
    queryKey: ["admin-reports", status ?? "all"],
    queryFn: ({ pageParam }) =>
      api.adminListReports({ status, limit: PAGE_LIMIT, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
  const reports = query.data?.pages.flatMap((p) => p.reports) ?? [];

  return (
    <div>
      <div className="hrb-filter-chips" role="group" aria-label="status フィルタ">
        <button
          type="button"
          className={`hrb-filter-chip ${status === undefined ? "hrb-filter-chip--active" : ""}`}
          aria-pressed={status === undefined}
          onClick={() => setStatus(undefined)}
        >
          すべて
        </button>
        {REPORT_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={`hrb-filter-chip ${status === s ? "hrb-filter-chip--active" : ""}`}
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
          >
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {query.isLoading && <TableSkeleton columns={6} />}
      {!query.isLoading && reports.length === 0 && (
        <EmptyState icon={<Icon name="inbox" size={30} />} title="レポートがありません" />
      )}

      {reports.length > 0 && (
        <div className="hrb-table-wrap">
          <table className="hrb-table">
            <thead>
              <tr>
                <th>タイトル</th>
                <th>作成者</th>
                <th>種類</th>
                <th>ステータス</th>
                <th>更新日時</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/reports/${r.id}`} className="hrb-table__title">
                      {r.title}
                    </Link>
                  </td>
                  <td>{r.ownerName}</td>
                  <td>
                    <KindChip kind={r.kind} />
                  </td>
                  <td>
                    <StatusChip status={r.status} />
                  </td>
                  <td className="hrb-table__date">{formatDateTime(r.updatedAt)}</td>
                  <td>
                    <div className="hrb-row-actions">
                      {r.status === "published" && (
                        <Button
                          variant="danger"
                          onClick={() => onConfirm({ kind: "takedown", report: r })}
                        >
                          テイクダウン
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <LoadMore query={query} />
    </div>
  );
}

// ---- ユーザー管理 ----

function UsersTab({ onConfirm }: { onConfirm: (c: Confirm) => void }) {
  const { api } = useApp();
  const session = useSession();
  const query = useInfiniteQuery({
    queryKey: ["admin-users"],
    queryFn: ({ pageParam }) => api.adminListUsers({ limit: PAGE_LIMIT, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
  const users = query.data?.pages.flatMap((p) => p.users) ?? [];

  if (query.isLoading) return <TableSkeleton columns={4} />;
  if (users.length === 0)
    return <EmptyState icon={<Icon name="users" size={30} />} title="ユーザーがいません" />;

  return (
    <div>
      <div className="hrb-table-wrap">
        <table className="hrb-table">
          <thead>
            <tr>
              <th>ユーザー名</th>
              <th>メール</th>
              <th>権限</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.username}>
                <td>{u.name ?? u.username}</td>
                <td>{u.email ?? "-"}</td>
                <td>{u.isAdmin ? <span className="hrb-chip hrb-chip--kind">admin</span> : "-"}</td>
                <td>
                  <div className="hrb-row-actions">
                    <Button
                      variant={u.isAdmin ? "danger" : "secondary"}
                      onClick={() => onConfirm({ kind: "set-admin", user: u, isAdmin: !u.isAdmin })}
                    >
                      {u.isAdmin ? "admin 剥奪" : "admin 付与"}
                    </Button>
                    {u.username === session?.username ? (
                      <span className="hrb-tip" data-tip="自分自身のアカウントは削除できません" tabIndex={0}>
                        <Button variant="ghost" disabled>
                          削除
                        </Button>
                      </span>
                    ) : (
                      <Button variant="danger" onClick={() => onConfirm({ kind: "delete-user", user: u })}>
                        削除
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore query={query} />
    </div>
  );
}

// ---- ページ本体 ----

export function AdminPage() {
  const { api } = useApp();
  const session = useSession();
  const toast = useToast();
  const invalidate = useAdminInvalidate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("flagged");
  const [confirm, setConfirm] = useState<Confirm>(null);

  const mutation = useMutation({
    mutationFn: async (c: NonNullable<Confirm>) => {
      switch (c.kind) {
        case "takedown":
          await api.adminTakedown(c.report.id);
          return "レポートを公開停止しました";
        case "clear-flags":
          await api.adminClearFlags(c.report.id);
          return "通報を解決済みにしました";
        case "set-admin":
          await api.adminSetAdmin(c.user.username, c.isAdmin);
          return "権限を更新しました";
        case "delete-user": {
          const res = await api.adminDeleteUser(c.user.username);
          return res.deletedReports > 0
            ? `ユーザーを削除しました（所有レポート ${res.deletedReports} 件も削除）`
            : "ユーザーを削除しました";
        }
      }
    },
    onSuccess: (message, c) => {
      toast.push("success", message);
      void qc.invalidateQueries({ queryKey: ["admin-users"] });
      if (c.kind !== "set-admin") invalidate();
      setConfirm(null);
    },
    onError: (err) => {
      toast.push("danger", isApiError(err) ? err.message : GENERIC_ERROR);
      setConfirm(null);
    },
  });

  if (!session?.isAdmin) {
    return (
      <div className="hrb-page">
        <EmptyState icon={<Icon name="lock" size={30} />} title="権限がありません" />
      </div>
    );
  }

  const confirmText = (c: NonNullable<Confirm>): { title: string; body: string; label: string } => {
    switch (c.kind) {
      case "takedown":
        return {
          title: "テイクダウン",
          body: `「${c.report.title}」の公開を強制停止します。オーナーは再公開できなくなります。よろしいですか？`,
          label: "テイクダウン",
        };
      case "clear-flags":
        return {
          title: "通報を解決",
          body: `「${c.report.title}」への通報をすべて解決済みにして一覧から消します。よろしいですか？`,
          label: "解決済みにする",
        };
      case "set-admin":
        return {
          title: "権限を変更",
          body: `${c.user.name ?? c.user.username} の admin 権限を${c.isAdmin ? "付与" : "剥奪"}しますか？`,
          label: c.isAdmin ? "付与する" : "剥奪する",
        };
      case "delete-user":
        return {
          title: "ユーザーを削除",
          body: `${c.user.name ?? c.user.username}（${c.user.email ?? c.user.username}）のアカウントを削除します。このユーザーが所有するレポートもすべて削除され、共有 URL は無効になります。この操作は取り消せません。よろしいですか？`,
          label: "削除する",
        };
    }
  };

  return (
    <div className="hrb-page">
      <div className="hrb-page__head">
        <h1 className="hrb-page__title">管理画面</h1>
      </div>

      <div className="hrb-tabs" role="tablist">
        {(
          [
            ["flagged", "通報"],
            ["all", "全レポート"],
            ["users", "ユーザー管理"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`hrb-tab ${tab === key ? "hrb-tab--active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "flagged" && <FlaggedTab onConfirm={setConfirm} />}
      {tab === "all" && <AllReportsTab onConfirm={setConfirm} />}
      {tab === "users" && <UsersTab onConfirm={setConfirm} />}

      {confirm && (
        <Modal
          open
          title={confirmText(confirm).title}
          onClose={() => setConfirm(null)}
          closeOnOverlay={false}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                キャンセル
              </Button>
              <Button
                variant={confirm.kind === "clear-flags" ? "primary" : "danger"}
                loading={mutation.isPending}
                onClick={() => mutation.mutate(confirm)}
              >
                {confirmText(confirm).label}
              </Button>
            </>
          }
        >
          <p>{confirmText(confirm).body}</p>
        </Modal>
      )}
    </div>
  );
}
