import { highlightSegments } from "../lib/highlight.ts";

/** クエリ一致部分を <mark> で強調して描画する。 */
export function Highlight({ text, query }: { text: string; query?: string }) {
  if (!query) return <>{text}</>;
  const segments = highlightSegments(text, query);
  return (
    <>
      {segments.map((s, i) =>
        s.hit ? (
          <mark key={i} className="hrb-mark">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
