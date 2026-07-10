/**
 * URL helpers shared by rules. Uploaded reports are served from our own
 * content origin, so any absolute http(s) URL is treated as external
 * (relative URLs are internal by construction). Portable (Node 22).
 */

/** Fictional base used to resolve relative/protocol-relative URLs. */
const INTERNAL_BASE = "https://content.invalid/";
const INTERNAL_HOST = "content.invalid";

export function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw.trim(), INTERNAL_BASE);
  } catch {
    return null;
  }
}

/** True when the URL points at another http(s) origin (protocol-relative included). */
export function isExternalHttpUrl(raw: string): boolean {
  const url = parseUrl(raw);
  if (!url) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname !== INTERNAL_HOST;
}

/** Hostname of an external http(s) URL, else null. */
export function externalHost(raw: string): string | null {
  const url = parseUrl(raw);
  if (!url) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === INTERNAL_HOST) return null;
  return url.hostname.toLowerCase();
}

/** Lower-cased pathname (works for relative and absolute URLs, drops query/hash). */
export function urlPathname(raw: string): string {
  const url = parseUrl(raw);
  return url ? url.pathname.toLowerCase() : raw.toLowerCase();
}

/** Lower-cased extension (with dot) of a path-like string, or "" when none. */
export function pathExtension(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] ?? path;
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

const CODE_URL_PATTERN = /https?:\/\/[^\s'"`<>\\)]+/gi;

/** Extract absolute http(s) URL literals from JS/CSS/text. */
export function extractUrlsFromCode(code: string): string[] {
  return code.match(CODE_URL_PATTERN) ?? [];
}

/** Truncate evidence snippets embedded in findings. */
export function snippet(value: string, max = 160): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}
