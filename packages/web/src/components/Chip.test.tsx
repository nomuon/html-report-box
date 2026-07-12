import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExpiryChip } from "./Chip.tsx";

describe("ExpiryChip", () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  test("期限内の公開は「〜まで公開」バッジ", () => {
    const html = renderToStaticMarkup(<ExpiryChip status="published" expiresAt={future} />);
    expect(html).toContain("まで公開");
    expect(html).toContain("hrb-chip--warn");
  });

  test("期限切れは「期限切れ（非公開）」バッジ", () => {
    const html = renderToStaticMarkup(<ExpiryChip status="unlisted" expiresAt={past} />);
    expect(html).toContain("期限切れ（非公開）");
    expect(html).toContain("hrb-chip--rejected");
  });

  test("expiresAt なし・非公開ステータスでは何も描画しない", () => {
    expect(renderToStaticMarkup(<ExpiryChip status="published" />)).toBe("");
    expect(renderToStaticMarkup(<ExpiryChip status="private" expiresAt={future} />)).toBe("");
    expect(renderToStaticMarkup(<ExpiryChip status="rejected" expiresAt={past} />)).toBe("");
  });
});
