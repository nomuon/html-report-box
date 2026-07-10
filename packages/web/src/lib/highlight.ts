/**
 * Search-hit highlighting: case- and NFKC-insensitive substring match
 * (DESIGN.md §2.2). Pure & DOM-free — components render segments as <mark>.
 *
 * Per-code-point NFKC normalization keeps an offset map back to the original
 * string so highlighted ranges slice the original text exactly.
 */

export interface Segment {
  text: string;
  hit: boolean;
}

function normalizeChar(ch: string): string {
  return ch.normalize("NFKC").toLowerCase();
}

export function normalizeQuery(q: string): string[] {
  return q
    .normalize("NFKC")
    .toLowerCase()
    .split(/\s+/u)
    .filter((t) => t.length > 0);
}

export function highlightSegments(text: string, query: string): Segment[] {
  const terms = normalizeQuery(query);
  if (text.length === 0 || terms.length === 0) return [{ text, hit: false }];

  // Build normalized haystack + map normalized index → original index.
  let normalized = "";
  const originIndex: number[] = [];
  let i = 0;
  for (const ch of text) {
    const n = normalizeChar(ch);
    for (let k = 0; k < n.length; k++) originIndex.push(i);
    normalized += n;
    i += ch.length;
  }
  originIndex.push(text.length); // sentinel

  // Collect matched original ranges.
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    let from = 0;
    while (true) {
      const at = normalized.indexOf(term, from);
      if (at === -1) break;
      const start = originIndex[at]!;
      const endNorm = at + term.length;
      const end = endNorm < originIndex.length ? originIndex[endNorm]! : text.length;
      ranges.push([start, Math.max(end, start + 1)]);
      from = at + 1;
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }];

  // Merge overlapping ranges.
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  const segments: Segment[] = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) segments.push({ text: text.slice(cursor, s), hit: false });
    segments.push({ text: text.slice(s, e), hit: true });
    cursor = e;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}
