/**
 * スケルトンローディング。初回データ取得中に実レイアウトに近いプレースホルダを
 * 表示する（「さらに読み込む」中は Button の loading を使う）。
 * アニメーションは app.css の .hrb-skeleton（prefers-reduced-motion で無効化）。
 */

/** 単一のスケルトンバー。width は "60%" / "8em" など CSS 値。 */
export function Skeleton({ width }: { width?: string }) {
  return <span className="hrb-skeleton" style={width ? { width } : undefined} />;
}

/** セルごとに幅を変えて自然に見せるためのプリセット。 */
const CELL_WIDTHS = ["70%", "45%", "60%", "35%", "50%", "40%"];

function cellWidth(row: number, col: number): string {
  return CELL_WIDTHS[(row + col) % CELL_WIDTHS.length]!;
}

/** テーブル一覧の初回ローディング（hrb-table のレイアウトを模す）。 */
export function TableSkeleton({ columns, rows = 5 }: { columns: number; rows?: number }) {
  return (
    <div className="hrb-table-wrap" role="status" aria-label="読み込み中">
      <table className="hrb-table" aria-hidden="true">
        <thead>
          <tr>
            {Array.from({ length: columns }, (_, c) => (
              <th key={c}>
                <Skeleton width="4em" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {Array.from({ length: columns }, (_, c) => (
                <td key={c}>
                  <Skeleton width={cellWidth(r, c)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** カード一覧の初回ローディング（hrb-cards のグリッドを模す）。 */
export function CardsSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="hrb-cards" role="status" aria-label="読み込み中">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="hrb-card" aria-hidden="true">
          <Skeleton width={cellWidth(i, 0)} />
          <p className="hrb-card__desc">
            <Skeleton width="90%" />
          </p>
          <div className="hrb-card__meta">
            <Skeleton width="6em" />
            <Skeleton width="9em" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** レポート詳細シェルのヘッダ（metabar）初回ローディング。 */
export function DetailHeaderSkeleton() {
  return (
    <div className="hrb-detail__metabar" role="status" aria-label="読み込み中">
      <div className="hrb-detail__info" aria-hidden="true">
        <h1 className="hrb-detail__title">
          <Skeleton width="16em" />
        </h1>
        <div className="hrb-detail__sub">
          <Skeleton width="6em" />
          <Skeleton width="10em" />
        </div>
      </div>
      <div className="hrb-detail__actions" aria-hidden="true">
        <Skeleton width="8em" />
      </div>
    </div>
  );
}
