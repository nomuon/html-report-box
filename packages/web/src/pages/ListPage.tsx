/** 画面①: 一覧 (`/`) / 検索結果 (`/search?q=`) */
import { useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { PublicReport } from "@hrb/shared";
import { useApp } from "../app-context.tsx";
import { Button } from "../components/Button.tsx";
import { KindChip, StatusChip } from "../components/Chip.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Highlight } from "../components/Highlight.tsx";
import { formatDateTime } from "../lib/format.ts";

type ViewMode = "table" | "card";
const VIEW_STORAGE_KEY = "hrb-view";

function getStoredView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "card" ? "card" : "table";
  } catch {
    return "table";
  }
}

function ReportTable({ reports, query }: { reports: PublicReport[]; query?: string }) {
  const navigate = useNavigate();
  return (
    <div className="hrb-table-wrap">
      <table className="hrb-table">
        <thead>
          <tr>
            <th>タイトル</th>
            <th>作成者</th>
            <th>更新日時</th>
            <th>種類</th>
            <th>ステータス</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id} className="hrb-table__row" onClick={() => navigate(`/reports/${r.id}`)}>
              <td>
                <Link
                  to={`/reports/${r.id}`}
                  className="hrb-table__title"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Highlight text={r.title} query={query} />
                </Link>
              </td>
              <td>{r.ownerName}</td>
              <td className="hrb-table__date">{formatDateTime(r.updatedAt)}</td>
              <td>
                <KindChip kind={r.kind} />
              </td>
              <td>
                <StatusChip status={r.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportCards({ reports, query }: { reports: PublicReport[]; query?: string }) {
  const navigate = useNavigate();
  return (
    <div className="hrb-cards">
      {reports.map((r) => (
        <div
          key={r.id}
          className="hrb-card hrb-card--clickable"
          role="link"
          tabIndex={0}
          onClick={() => navigate(`/reports/${r.id}`)}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate(`/reports/${r.id}`);
          }}
        >
          <h3 className="hrb-card__title">
            <Highlight text={r.title} query={query} />
          </h3>
          {r.description && (
            <p className="hrb-card__desc">
              <Highlight text={r.description} query={query} />
            </p>
          )}
          <div className="hrb-card__meta">
            <span>{r.ownerName}</span>
            <span className="hrb-card__date">{formatDateTime(r.updatedAt)}</span>
            <StatusChip status={r.status} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="hrb-view-toggle" role="group" aria-label="表示切替">
      <button
        type="button"
        className={`hrb-icon-btn ${view === "table" ? "hrb-icon-btn--active" : ""}`}
        aria-label="テーブル表示"
        onClick={() => onChange("table")}
      >
        ☰
      </button>
      <button
        type="button"
        className={`hrb-icon-btn ${view === "card" ? "hrb-icon-btn--active" : ""}`}
        aria-label="カード表示"
        onClick={() => onChange("card")}
      >
        ▦
      </button>
    </div>
  );
}

export function ListPage() {
  const { api } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [view, setView] = useState<ViewMode>(getStoredView);

  const isSearch = location.pathname === "/search";
  const q = isSearch ? (params.get("q") ?? "").trim() : "";

  const listQuery = useInfiniteQuery({
    queryKey: ["reports"],
    queryFn: ({ pageParam }) => api.listReports({ cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !isSearch,
  });

  const searchQuery = useQuery({
    queryKey: ["search", q],
    queryFn: () => api.search(q),
    enabled: isSearch && q.length > 0,
  });

  const changeView = (v: ViewMode) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, v);
    } catch {
      // ignore
    }
  };

  const reports: PublicReport[] = isSearch
    ? (searchQuery.data?.results.map((r) => r.report) ?? [])
    : (listQuery.data?.pages.flatMap((p) => p.reports) ?? []);

  const loading = isSearch ? searchQuery.isLoading : listQuery.isLoading;

  return (
    <div className="hrb-page">
      <div className="hrb-page__head">
        <h1 className="hrb-page__title">
          {isSearch ? `「${q}」の検索結果 ${reports.length}件` : "レポート一覧"}
        </h1>
        <ViewToggle view={view} onChange={changeView} />
      </div>

      {loading && <p className="hrb-loading">読み込み中…</p>}

      {!loading && reports.length === 0 && (
        isSearch ? (
          <EmptyState icon="🔍" title={`「${q}」に一致するレポートは見つかりませんでした`} />
        ) : (
          <EmptyState
            icon="📭"
            title="まだレポートがありません"
            action={<Button onClick={() => navigate("/upload")}>最初のレポートをアップロード</Button>}
          />
        )
      )}

      {reports.length > 0 &&
        (view === "table" ? (
          <ReportTable reports={reports} query={isSearch ? q : undefined} />
        ) : (
          <ReportCards reports={reports} query={isSearch ? q : undefined} />
        ))}

      {!isSearch && listQuery.hasNextPage && (
        <div className="hrb-load-more">
          <Button
            variant="secondary"
            loading={listQuery.isFetchingNextPage}
            onClick={() => void listQuery.fetchNextPage()}
          >
            さらに読み込む
          </Button>
        </div>
      )}
    </div>
  );
}
