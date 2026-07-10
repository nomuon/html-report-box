/**
 * Search tokenizer shared by indexing (documents) and querying.
 *
 * Pipeline: NFKC normalize -> lowercase -> segment into
 *   - ASCII word runs ([a-z0-9]+) emitted as-is
 *   - CJK runs emitted as character bigrams (single char if run length is 1)
 * Everything else is a separator.
 *
 * The exact same `tokenize()` is used for both documents and queries so that
 * matching is consistent. Portable (Node 22 / browser); no Bun-only APIs.
 */
import {
  MAX_INDEX_BODY_BYTES,
  MAX_TOKENS_PER_DOCUMENT,
  TOKEN_WEIGHT_BODY,
  TOKEN_WEIGHT_DESCRIPTION,
  TOKEN_WEIGHT_TITLE,
} from "./constants.ts";

function isAsciiWordChar(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x61 && cp <= 0x7a);
}

function isCjkChar(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) || // hiragana + katakana (incl. prolonged sound mark)
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK unified ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0x20000 && cp <= 0x2fa1f) || // CJK ext B..F + compat supplement
    (cp >= 0xac00 && cp <= 0xd7af) || // hangul syllables
    (cp >= 0x1100 && cp <= 0x11ff) || // hangul jamo
    cp === 0x3005 || // 々 (iteration mark)
    cp === 0x3007 // 〇
  );
}

/**
 * Tokenize text into unique tokens (first-appearance order).
 * Used identically for document fields and search queries.
 */
export function tokenize(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const seen = new Set<string>();
  const tokens: string[] = [];
  const push = (token: string): void => {
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  };

  let asciiRun = "";
  let cjkRun: string[] = [];
  const flushAscii = (): void => {
    if (asciiRun.length > 0) {
      push(asciiRun);
      asciiRun = "";
    }
  };
  const flushCjk = (): void => {
    if (cjkRun.length === 1) {
      push(cjkRun[0]!);
    } else {
      for (let i = 0; i + 1 < cjkRun.length; i++) {
        push(cjkRun[i]! + cjkRun[i + 1]!);
      }
    }
    cjkRun = [];
  };

  for (const ch of normalized) {
    const cp = ch.codePointAt(0)!;
    if (isAsciiWordChar(cp)) {
      flushCjk();
      asciiRun += ch;
    } else if (isCjkChar(cp)) {
      flushAscii();
      cjkRun.push(ch);
    } else {
      flushAscii();
      flushCjk();
    }
  }
  flushAscii();
  flushCjk();
  return tokens;
}

/** Alias: query-side tokenization is intentionally the same implementation. */
export const tokenizeQuery: (query: string) => string[] = tokenize;

/**
 * Truncate a string so its UTF-8 encoding is at most `maxBytes` bytes,
 * without splitting a code point.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes));
  // Strip a replacement char produced by cutting a multi-byte sequence.
  while (decoded.endsWith("�")) decoded = decoded.slice(0, -1);
  return decoded;
}

export interface DocumentFields {
  title: string;
  description?: string;
  /** Extracted body text. Truncated to MAX_INDEX_BODY_BYTES (50KB) before tokenizing. */
  body?: string;
}

export interface WeightedToken {
  token: string;
  /** Sum of field weights the token appears in (title=8, description=4, body=1). */
  weight: number;
}

/**
 * Build the weighted token list to index for one document.
 * - Weights are additive across fields (a token in title+body has weight 9).
 * - Body is truncated to 50KB (UTF-8 bytes) first.
 * - At most MAX_TOKENS_PER_DOCUMENT (1500) tokens are kept; when over the cap,
 *   tokens are kept by weight desc, then token asc (deterministic).
 */
export function buildDocumentTokens(fields: DocumentFields): WeightedToken[] {
  const weights = new Map<string, number>();
  const add = (text: string, weight: number): void => {
    for (const token of tokenize(text)) {
      weights.set(token, (weights.get(token) ?? 0) + weight);
    }
  };
  add(fields.title, TOKEN_WEIGHT_TITLE);
  add(fields.description ?? "", TOKEN_WEIGHT_DESCRIPTION);
  add(truncateUtf8Bytes(fields.body ?? "", MAX_INDEX_BODY_BYTES), TOKEN_WEIGHT_BODY);

  let result: WeightedToken[] = [];
  for (const [token, weight] of weights) result.push({ token, weight });
  if (result.length > MAX_TOKENS_PER_DOCUMENT) {
    result.sort((a, b) => b.weight - a.weight || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
    result = result.slice(0, MAX_TOKENS_PER_DOCUMENT);
  }
  return result;
}
