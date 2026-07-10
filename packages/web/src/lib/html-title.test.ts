import { describe, expect, test } from "bun:test";
import { extractHtmlTitle, titleFromFilename } from "./html-title.ts";

describe("extractHtmlTitle", () => {
  test("extracts and trims the <title>", () => {
    expect(extractHtmlTitle("<html><head><title>  月次レポート </title></head></html>")).toBe(
      "月次レポート",
    );
  });

  test("decodes basic entities and collapses whitespace", () => {
    expect(extractHtmlTitle("<title>A &amp; B\n  &lt;2026&gt;</title>")).toBe("A & B <2026>");
  });

  test("handles attributes and missing/empty titles", () => {
    expect(extractHtmlTitle('<title data-x="1">ok</title>')).toBe("ok");
    expect(extractHtmlTitle("<p>no title</p>")).toBeNull();
    expect(extractHtmlTitle("<title>   </title>")).toBeNull();
  });
});

describe("titleFromFilename", () => {
  test("drops .html/.htm/.zip extensions", () => {
    expect(titleFromFilename("sales-report.html")).toBe("sales-report");
    expect(titleFromFilename("archive.ZIP")).toBe("archive");
    expect(titleFromFilename("plain")).toBe("plain");
  });
});
