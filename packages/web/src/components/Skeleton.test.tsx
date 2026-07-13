import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CardsSkeleton, DetailHeaderSkeleton, Skeleton, TableSkeleton } from "./Skeleton.tsx";

describe("Skeleton", () => {
  test("バーは hrb-skeleton クラスと width スタイルを持つ", () => {
    expect(renderToStaticMarkup(<Skeleton width="6em" />)).toBe(
      '<span class="hrb-skeleton" style="width:6em"></span>',
    );
    expect(renderToStaticMarkup(<Skeleton />)).toBe('<span class="hrb-skeleton"></span>');
  });

  test("TableSkeleton は指定した列数・行数のセルを持ち、SR には読み込み中と伝える", () => {
    const html = renderToStaticMarkup(<TableSkeleton columns={4} rows={3} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="読み込み中"');
    // ヘッダ 4 セル + 本文 3 行 × 4 セル
    expect(html.split("<th>").length - 1).toBe(4);
    expect(html.split("<td>").length - 1).toBe(12);
  });

  test("CardsSkeleton は指定枚数のカードを描画する", () => {
    const html = renderToStaticMarkup(<CardsSkeleton count={3} />);
    expect(html.split('class="hrb-card"').length - 1).toBe(3);
  });

  test("DetailHeaderSkeleton は metabar レイアウトを模す", () => {
    const html = renderToStaticMarkup(<DetailHeaderSkeleton />);
    expect(html).toContain("hrb-detail__metabar");
    expect(html).toContain("hrb-detail__title");
  });
});
