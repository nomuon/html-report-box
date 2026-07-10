/** Extract <title> from raw HTML for upload-form autofill. Pure & DOM-free. */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function extractHtmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!m) return null;
  const raw = m[1] ?? "";
  const decoded = raw
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ")
    .trim();
  return decoded.length > 0 ? decoded : null;
}

/** ".html" 拡張子を落としたファイル名（タイトルのフォールバック用）. */
export function titleFromFilename(name: string): string {
  return name.replace(/\.(html?|zip)$/i, "") || name;
}
