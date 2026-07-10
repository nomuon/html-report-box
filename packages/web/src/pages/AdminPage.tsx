/** 画面⑤: 管理画面 (`/admin`) — 承認キュー / 全レポート / ユーザー管理 */
import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminReport, AdminUser, ReportStatus } from "@hrb/shared";
import { REPORT_STATUSES } from "@hrb/shared";
import { useApp, useSession } from "../app-context.tsx";
import { Button } from "../components/Button.tsx";
import { KindChip, STATUS_LABELS, StatusChip } from "../components/Chip.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Modal } from "../components/Modal.tsx";
import { useToast } from "../components/Toast.tsx";
import { isApiError } from "../lib/api.ts";
import { formatDateTime } from "../lib/format.ts";

type Tab = "queue" | "all" | "users";

type Confirm =
  | { kind: "approve" | "reject" | "takedown"; report: AdminReport }
  | { kind: "set-admin"; user: AdminUser; isAdmin: boolean }
  | null;

const GENERIC_ERROR = "エラーが発生しました。時間をおいて再試行してください";

function useAdminInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["admin-reports"] });
    void qc.invalidateQueries({ queryKey: ["reports"] });
    void qc.invalidateQueries({ queryKey: ["my-reports"] });
  };
}

// ---- 承認キュー ----

function QueueTab({ onConfirm }: { onConfirm: (c: Confirm) => void }) {
  const { api } = useApp();
  const query = useQuery({
    queryKey: ["admin-reports", "pending_review"],
    queryFn: () => api.adminListReports({ status: "pending_review" }),
  });
  const reports = query.data?.reports ?? [];

  if (query.isLoading) return <p className="hrb-loading">読み込み中…</p>;
  if (reports.length === 0)
    return <EmptyState icon="✅" title="承認待ちのレポートはありません" />;

  return (
    <div className="hrb-table-wrap">
      <table className="hrb-table">
        <thead>
          <tr>
            <th>タイトル</th>
            <th>作成者</th>
            <th>検知内容</th>
            <th>申請日時</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id}>
              <td>
                <span className="hrb-table__title">{r.title}</span>
              </td>
              <td>{r.ownerName}</td>
              <td>
                <div className="hrb-finding-chips">
                  {r.findings.map((f, i) => (
                    <span key={i} className="hrb-finding-chip" title={f.message}>
                      {f.ruleId}
                    </span>
                  ))}
                </div>
              </td>
              <td className="hrb-table__date">{formatDateTime(r.updatedAt)}</td>
              <td>
                <div className="hrb-row-actions">
                  <Link to={`/reports/${r.id}`} target="_blank" rel="noreferrer">
                    <Button variant="secondary">プレビュー</Button>
                  </Link>
                  <Button
                    className="hrb-btn--success"
                    onClick={() => onConfirm({ kind: "approve", report: r })}
                  >
                    承認
                  </Button>
                  <Button variant="danger" onClick={() => onConfirm({ kind: "reject", report: r })}>
                    却下
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  const [statusFilter, setStatusFilter] = useState<Set<ReportStatus>>(new Set());
  const [flagsFor, setFlagsFor] = useState<AdminReport | null>(null);

  const query = useQuery({
    queryKey: ["admin-reports", "all"],
    queryFn: () => api.adminListReports({ limit: 100 }),
  });
  const all = query.data?.reports ?? [];
  const reports =
    statusFilter.size === 0 ? all : all.filter((r) => statusFilter.has(r.status));

  const toggle = (s: ReportStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  return (
    <div>
      <div className="hrb-filter-chips" role="group" aria-label="status フィルタ">
        {REPORT_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={`hrb-filter-chip ${statusFilter.has(s) ? "hrb-filter-chip--active" : ""}`}
            aria-pressed={statusFilter.has(s)}
            onClick={() => toggle(s)}
          >
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {query.isLoading && <p className="hrb-loading">読み込み中…</p>}
      {!query.isLoading && reports.length === 0 && (
        <EmptyState icon="📭" title="レポートがありません" />
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
                      <Button variant="ghost" onClick={() => setFlagsFor(r)}>
                        通報
                      </Button>
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

      {flagsFor && <FlagsModal report={flagsFor} onClose={() => setFlagsFor(null)} />}
    </div>
  );
}

// ---- ユーザー管理 ----

function UsersTab({ onConfirm }: { onConfirm: (c: Confirm) => void }) {
  const { api } = useApp();
  const query = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => api.adminListUsers({ limit: 100 }),
  });
  const users = query.data?.users ?? [];

  if (query.isLoading) return <p className="hrb-loading">読み込み中…</p>;
  if (users.length === 0) return <EmptyState icon="👤" title="ユーザーがいません" />;

  return (
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
                <Button
                  variant={u.isAdmin ? "danger" : "secondary"}
                  onClick={() => onConfirm({ kind: "set-admin", user: u, isAdmin: !u.isAdmin })}
                >
                  {u.isAdmin ? "admin 剥奪" : "admin 付与"}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  const [tab, setTab] = useState<Tab>("queue");
  const [confirm, setConfirm] = useState<Confirm>(null);

  const mutation = useMutation({
    mutationFn: async (c: NonNullable<Confirm>) => {
      switch (c.kind) {
        case "approve":
          await api.adminApprove(c.report.id);
          return "レポートを承認し公開しました";
        case "reject":
          await api.adminReject(c.report.id);
          return "レポートを却下しました";
        case "takedown":
          await api.adminTakedown(c.report.id);
          return "レポートを非公開にしました";
        case "set-admin":
          await api.adminSetAdmin(c.user.username, c.isAdmin);
          return "権限を更新しました";
      }
    },
    onSuccess: (message, c) => {
      toast.push("success", message);
      if (c.kind === "set-admin") void qc.invalidateQueries({ queryKey: ["admin-users"] });
      else invalidate();
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
        <EmptyState icon="🚫" title="権限がありません" />
      </div>
    );
  }

  const confirmText = (c: NonNullable<Confirm>): { title: string; body: string; label: string } => {
    switch (c.kind) {
      case "approve":
        return {
          title: "レポートを承認",
          body: `「${c.report.title}」を承認して公開しますか？`,
          label: "承認する",
        };
      case "reject":
        return {
          title: "レポートを却下",
          body: `「${c.report.title}」を却下しますか？`,
          label: "却下する",
        };
      case "takedown":
        return {
          title: "テイクダウン",
          body: "公開を停止し削除します。よろしいですか？",
          label: "テイクダウン",
        };
      case "set-admin":
        return {
          title: "権限を変更",
          body: `${c.user.name ?? c.user.username} の admin 権限を${c.isAdmin ? "付与" : "剥奪"}しますか？`,
          label: c.isAdmin ? "付与する" : "剥奪する",
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
            ["queue", "承認キュー"],
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

      {tab === "queue" && <QueueTab onConfirm={setConfirm} />}
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
                variant={confirm.kind === "approve" ? "primary" : "danger"}
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
