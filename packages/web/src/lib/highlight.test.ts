import { describe, expect, test } from "bun:test";
import { highlightSegments, normalizeQuery } from "./highlight.ts";

describe("highlightSegments", () => {
  test("marks a simple substring", () => {
    expect(highlightSegments("Sales Report 2026", "report")).toEqual([
      { text: "Sales ", hit: false },
      { text: "Report", hit: true },
      { text: " 2026", hit: false },
    ]);
  });

  test("is case-insensitive and NFKC-insensitive (full-width)", () => {
    // full-width "ＲＥＰＯＲＴ" in text matches half-width query
    const segs = highlightSegments("ＲＥＰＯＲＴ一覧", "report");
    expect(segs[0]).toEqual({ text: "ＲＥＰＯＲＴ", hit: true });
    expect(segs[1]).toEqual({ text: "一覧", hit: false });
    // and the reverse: half-width text, full-width query
    const segs2 = highlightSegments("report一覧", "ＲＥＰＯＲＴ");
    expect(segs2[0]).toEqual({ text: "report", hit: true });
  });

  test("matches CJK substrings", () => {
    expect(highlightSegments("売上レポート月次", "レポート")).toEqual([
      { text: "売上", hit: false },
      { text: "レポート", hit: true },
      { text: "月次", hit: false },
    ]);
  });

  test("highlights each whitespace-separated term and merges overlaps", () => {
    const segs = highlightSegments("abcde", "abc bcd");
    expect(segs).toEqual([
      { text: "abcd", hit: true },
      { text: "e", hit: false },
    ]);
  });

  test("no match / empty query returns single non-hit segment", () => {
    expect(highlightSegments("hello", "zzz")).toEqual([{ text: "hello", hit: false }]);
    expect(highlightSegments("hello", "   ")).toEqual([{ text: "hello", hit: false }]);
  });

  test("normalizeQuery splits and normalizes terms", () => {
    expect(normalizeQuery("  Ｆｏｏ　BAR ")).toEqual(["foo", "bar"]);
  });
});
