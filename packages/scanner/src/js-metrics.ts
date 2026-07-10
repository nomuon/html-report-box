/**
 * Static JS metrics: entropy, escape density, decode/eval vocabulary and
 * decode-execute chain detection. Portable (Node 22).
 *
 * KNOWN LIMITATION (accepted by design): these are regex-based heuristics and
 * are deliberately evadable. Comment insertion between an exec sink and its
 * decode call, bracket-notation identifier assembly (window['ev'+'al'](...))
 * and payloads under minObfuscationCodeLength will not match. This is advisory static
 * layer only — the real runtime boundary is the sandboxed iframe served
 * WITHOUT allow-same-origin plus the Content-Security-Policy (see DESIGN.md),
 * which contains any script the scanner misses. Tightening these patterns must
 * not come at the cost of false positives on ordinary minified libraries.
 */

/** Shannon entropy in bits per character (whitespace excluded). */
export function shannonEntropy(code: string): number {
  const stripped = code.replace(/\s+/g, "");
  if (stripped.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of stripped) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  const len = stripped.length;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const ESCAPE_PATTERN = /\\x[0-9a-f]{2}|\\u\{?[0-9a-f]{4,6}\}?|%[0-9a-f]{2}|\\[0-7]{3}/gi;

/** Fraction of the code occupied by \xNN / \uNNNN / %NN / octal escapes. */
export function escapeDensity(code: string): number {
  if (code.length === 0) return 0;
  let escaped = 0;
  for (const match of code.matchAll(ESCAPE_PATTERN)) escaped += match[0].length;
  return escaped / code.length;
}

const EVAL_VOCAB: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
  ["eval", /\beval\s*\(/],
  ["Function-constructor", /\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`]/],
  ["atob", /\batob\s*\(/],
  ["unescape", /\bunescape\s*\(/],
  ["fromCharCode", /String\.fromCharCode\s*\(/],
  ["decodeURIComponent", /\bdecodeURIComponent\s*\(/],
  ["string-timer", /\bset(?:Timeout|Interval)\s*\(\s*['"`]/],
  ["document.write", /\bdocument\.write(?:ln)?\s*\(/],
];

/** Distinct decode/eval vocabulary entries present in the code. */
export function evalVocabulary(code: string): string[] {
  return EVAL_VOCAB.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
}

/**
 * Decode-execute chains: decoded data flowing directly into an execution
 * sink. Deliberately requires direct nesting or a short assignment chain so
 * that ordinary minified libraries do not match.
 */
const DECODE_EXEC_PATTERNS: readonly RegExp[] = [
  // eval(atob(...)), Function(unescape(...)), eval(decodeURIComponent(...)) ...
  /\b(?:eval|Function)\s*\(\s*(?:window\.|self\.|globalThis\.|top\.)?(?:atob|unescape|decodeURIComponent|String\.fromCharCode)\s*\(/,
  // new Function(... atob(...) ...)
  /\bnew\s+Function\s*\([^)]*\b(?:atob|unescape|String\.fromCharCode)\s*\(/,
  // document.write(atob(...)) / document.write(String.fromCharCode(...)) — a
  // decoded blob written straight into the DOM injects & runs it.
  /\bdocument\.write(?:ln)?\s*\(\s*(?:window\.|self\.|globalThis\.|top\.)?(?:atob|unescape|decodeURIComponent|String\.fromCharCode)\s*\(/,
  // setTimeout(atob(...)) — string timer executing decoded payload
  /\bset(?:Timeout|Interval)\s*\(\s*(?:window\.|self\.|globalThis\.|top\.)?(?:atob|unescape|decodeURIComponent|String\.fromCharCode)\s*\(/,
  // const p = atob(x); ... eval(p)  (short-range dataflow)
  /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:window\.)?atob\s*\([\s\S]{0,300}?\b(?:eval|Function)\s*\(\s*\1\s*[,)]/,
  // location = "javascript:" + atob(...)
  /javascript:\s*['"`]?\s*\+\s*(?:window\.)?atob\s*\(/,
];

export function findDecodeExecChain(code: string): string | null {
  for (const pattern of DECODE_EXEC_PATTERNS) {
    const match = pattern.exec(code);
    if (match) return match[0];
  }
  return null;
}
