/** 画面①: 一覧 (`/`) / 検索結果 (`/search?q=`) */
import { useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ListOrder, PublicReport, ReportKind } from "@hrb/shared";
import { useApp } from "../app-context.tsx";
import { Button } from "../components/Button.tsx";
import { KindChip, StatusChip, TagList } from "../components/Chip.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Highlight } from "../components/Highlight.tsx";
import { Icon } from "../components/Icon.tsx";
import { CardsSkeleton, TableSkeleton } from "../components/Skeleton.tsx";
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

function ReportTable({
  reports,
  query,
  onTagClick,
}: {
  reports: PublicReport[];
  query?: string;
  onTagClick: (tag: string) => void;
}) {
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
                <span className="hrb-table__title-cell">
                  <Link
                    to={`/reports/${r.id}`}
                    className="hrb-table__title"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Highlight text={r.title} query={query} />
                  </Link>
                  <TagList tags={r.tags} onTagClick={onTagClick} />
                </span>
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

function ReportCards({
  reports,
  query,
  onTagClick,
}: {
  reports: PublicReport[];
  query?: string;
  onTagClick: (tag: string) => void;
}) {
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
          <TagList tags={r.tags} onTagClick={onTagClick} />
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

/** 種類フィルタチップ（すべて / HTML / ZIP） */
function KindFilter({
  kind,
  onChange,
}: {
  kind: ReportKind | undefined;
  onChange: (k: ReportKind | undefined) => void;
}) {
  const options: Array<{ value: ReportKind | undefined; label: string }> = [
    { value: undefined, label: "すべて" },
    { value: "html", label: "HTML" },
    { value: "zip", label: "ZIP" },
  ];
  return (
    <div className="hrb-filter-chips" role="group" aria-label="種類フィルタ">
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          className={`hrb-filter-chip ${kind === o.value ? "hrb-filter-chip--active" : ""}`}
          aria-pressed={kind === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
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
        <Icon name="rows" size={16} />
      </button>
      <button
        type="button"
        className={`hrb-icon-btn ${view === "card" ? "hrb-icon-btn--active" : ""}`}
        aria-label="カード表示"
        onClick={() => onChange("card")}
      >
        <Icon name="grid" size={16} />
      </button>
    </div>
  );
}

export function ListPage() {
  const { api } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<ViewMode>(getStoredView);

  const isSearch = location.pathname === "/search";
  const q = isSearch ? (params.get("q") ?? "").trim() : "";

  // ソート・種類・タグフィルタは URL クエリ（?order=&kind=&tag=）と同期する
  // （リロード・URL 共有で状態が維持される）。デフォルト値はクエリから省く。
  const order: ListOrder = params.get("order") === "asc" ? "asc" : "desc";
  const kindParam = params.get("kind");
  const kind: ReportKind | undefined =
    kindParam === "html" || kindParam === "zip" ? kindParam : undefined;
  const tagParam = params.get("tag")?.trim();
  const tag: string | undefined = tagParam ? tagParam : undefined;

  const updateListParams = (next: {
    order?: ListOrder;
    kind?: ReportKind | undefined;
    tag?: string | undefined;
  }) => {
    const p = new URLSearchParams(params);
    const nextOrder = "order" in next ? next.order : order;
    const nextKind = "kind" in next ? next.kind : kind;
    const nextTag = "tag" in next ? next.tag : tag;
    if (nextOrder === "asc") p.set("order", "asc");
    else p.delete("order");
    if (nextKind !== undefined) p.set("kind", nextKind);
    else p.delete("kind");
    if (nextTag !== undefined) p.set("tag", nextTag);
    else p.delete("tag");
    setParams(p, { replace: true });
  };

  // タグチップのクリック: 一覧なら ?tag= で絞り込み、検索結果からは一覧へ移動して絞り込む
  const filterByTag = (t: string) => {
    if (isSearch) navigate(`/?tag=${encodeURIComponent(t)}`);
    else updateListParams({ tag: t });
  };

  const listQuery = useInfiniteQuery({
    queryKey: ["reports", order, kind ?? "all", tag ?? ""],
    queryFn: ({ pageParam }) =>
      api.listReports({
        cursor: pageParam,
        ...(order === "asc" ? { order } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(tag !== undefined ? { tag } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !isSearch,
  });

  const searchQuery = useInfiniteQuery({
    queryKey: ["search", q],
    queryFn: ({ pageParam }) => api.search(q, { cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
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
    ? (searchQuery.data?.pages.flatMap((p) => p.results.map((r) => r.report)) ?? [])
    : (listQuery.data?.pages.flatMap((p) => p.reports) ?? []);

  const loading = isSearch ? searchQuery.isLoading : listQuery.isLoading;
  const pager = isSearch ? searchQuery : listQuery;

  return (
    <div className="hrb-page">
      <div className="hrb-page__head">
        <div>
          <h1 className="hrb-page__title">
            {isSearch ? `「${q}」の検索結果 ${reports.length}件` : "レポート一覧"}
          </h1>
          {!isSearch && (
            <p className="hrb-page__sub">
              <Icon name="shield-check" size={14} />
              すべてのレポートは公開前にセキュリティスキャンされています
            </p>
          )}
        </div>
        <ViewToggle view={view} onChange={changeView} />
      </div>

      {!isSearch && (
        <div className="hrb-list-controls">
          <KindFilter kind={kind} onChange={(k) => updateListParams({ kind: k })} />
          {tag !== undefined && (
            <button
              type="button"
              className="hrb-filter-chip hrb-filter-chip--active hrb-filter-chip--tag"
              aria-label={`タグ「${tag}」の絞り込みを解除`}
              onClick={() => updateListParams({ tag: undefined })}
            >
              タグ: {tag}
              <Icon name="x" size={12} />
            </button>
          )}
          <select
            className="hrb-select"
            aria-label="並び順"
            value={order}
            onChange={(e) => updateListParams({ order: e.target.value === "asc" ? "asc" : "desc" })}
          >
            <option value="desc">新しい順</option>
            <option value="asc">古い順</option>
          </select>
        </div>
      )}

      {loading && (view === "table" ? <TableSkeleton columns={5} /> : <CardsSkeleton />)}

      {!loading && reports.length === 0 && (
        isSearch ? (
          <EmptyState
            icon={<Icon name="search" size={30} />}
            title={`「${q}」に一致するレポートは見つかりませんでした`}
          />
        ) : kind !== undefined || tag !== undefined ? (
          <EmptyState
            icon={<Icon name="inbox" size={30} />}
            title="条件に一致するレポートがありません"
          />
        ) : (
          <EmptyState
            icon={<Icon name="inbox" size={30} />}
            title="まだレポートがありません"
            action={<Button onClick={() => navigate("/upload")}>最初のレポートをアップロード</Button>}
          />
        )
      )}

      {reports.length > 0 &&
        (view === "table" ? (
          <ReportTable reports={reports} query={isSearch ? q : undefined} onTagClick={filterByTag} />
        ) : (
          <ReportCards reports={reports} query={isSearch ? q : undefined} onTagClick={filterByTag} />
        ))}

      {pager.hasNextPage && (
        <div className="hrb-load-more">
          <Button
            variant="secondary"
            loading={pager.isFetchingNextPage}
            onClick={() => void pager.fetchNextPage()}
          >
            さらに読み込む
          </Button>
        </div>
      )}
    </div>
  );
}
