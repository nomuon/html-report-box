import { describe, expect, test } from "bun:test";
import { extractHtml } from "./extract.ts";

describe("extractHtml", () => {
  test("extracts title, meta description and visible text", () => {
    const html = `<!doctype html><html><head>
      <title>月次 レポート</title>
      <meta name="description" content="6月の売上サマリー">
      <style>body { color: red }</style>
    </head><body>
      <h1>概要</h1>
      <p>売上は好調です。</p>
      <script>console.log("secret script text")</script>
    </body></html>`;
    const result = extractHtml(html);
    expect(result.title).toBe("月次 レポート");
    expect(result.description).toBe("6月の売上サマリー");
    expect(result.text).toContain("概要");
    expect(result.text).toContain("売上は好調です。");
    expect(result.text).not.toContain("secret script text");
    expect(result.text).not.toContain("color: red");
    expect(result.text).not.toContain("月次 レポート"); // title is not body text
  });

  test("supports og:description fallback and missing title", () => {
    const html = `<html><head><meta property="og:description" content="OGの説明"></head><body>hi</body></html>`;
    const result = extractHtml(html);
    expect(result.title).toBeUndefined();
    expect(result.description).toBe("OGの説明");
    expect(result.text).toBe("hi");
  });

  test("normalizes whitespace across fragments", () => {
    const result = extractHtml("<p>a\n   b</p><div>  c  </div>");
    expect(result.text).toBe("a b c");
  });

  test("tolerates broken markup (parse5 = browser-equivalent parsing)", () => {
    const result = extractHtml("<title>t</title><p>unclosed <b>bold");
    expect(result.title).toBe("t");
    expect(result.text).toBe("unclosed bold");
  });
});
