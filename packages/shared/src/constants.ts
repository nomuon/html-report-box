/**
 * Shared constants: size limits, allowlists, tokenizer weights.
 * Portable (Node 22 / browser / Lambda). No Bun-only APIs.
 */

// ---- Upload size limits ----
export const MAX_HTML_SIZE_BYTES = 5 * 1024 * 1024; // 5MB single HTML
export const MAX_ZIP_SIZE_BYTES = 20 * 1024 * 1024; // 20MB compressed zip
export const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100MB total after extraction
export const MAX_ZIP_ENTRIES = 200;
export const MAX_ZIP_COMPRESSION_RATIO = 100; // reject > 100:1 (zip bomb)

// ---- Rate limits ----
export const DAILY_UPLOAD_LIMIT = 30; // uploads per user per day

// ---- Version history ----
/** 保持する原本バージョン数の上限。超過分は最古から間引かれる。 */
export const REPORT_VERSION_HISTORY_LIMIT = 20;

// ---- zip entry extension allowlist (lowercase, with leading dot) ----
export const ZIP_ENTRY_ALLOWED_EXTENSIONS = [
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".txt",
  ".md",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".map",
  ".webmanifest",
] as const;
export type ZipEntryAllowedExtension = (typeof ZIP_ENTRY_ALLOWED_EXTENSIONS)[number];

export function isAllowedZipEntryExtension(ext: string): boolean {
  return (ZIP_ENTRY_ALLOWED_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

// ---- CDN allowlist (script/style sources permitted in uploaded reports & CSP) ----
export const ALLOWED_CDN_HOSTS = [
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "cdn.tailwindcss.com",
] as const;
export type AllowedCdnHost = (typeof ALLOWED_CDN_HOSTS)[number];

export const ALLOWED_FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"] as const;
export type AllowedFontHost = (typeof ALLOWED_FONT_HOSTS)[number];

/** script-src allowlist = 4 major CDNs. style/font side additionally allows Google Fonts. */
export const ALLOWED_STYLE_HOSTS = [...ALLOWED_CDN_HOSTS, ...ALLOWED_FONT_HOSTS] as const;

export function isAllowedCdnHost(host: string): boolean {
  return (ALLOWED_CDN_HOSTS as readonly string[]).includes(host.toLowerCase());
}

export function isAllowedStyleHost(host: string): boolean {
  return (ALLOWED_STYLE_HOSTS as readonly string[]).includes(host.toLowerCase());
}

// ---- Search / tokenizer ----
export const TOKEN_WEIGHT_TITLE = 8;
export const TOKEN_WEIGHT_TAG = 6;
export const TOKEN_WEIGHT_DESCRIPTION = 4;
export const TOKEN_WEIGHT_BODY = 1;
/** Max distinct tokens indexed per document. */
export const MAX_TOKENS_PER_DOCUMENT = 1500;
/** Body text is truncated to this many UTF-8 bytes before tokenization. */
export const MAX_INDEX_BODY_BYTES = 50 * 1024;

// ---- Report id (nanoid) ----
export const REPORT_ID_LENGTH = 21;
export const REPORT_ID_PATTERN = /^[A-Za-z0-9_-]{21}$/;
