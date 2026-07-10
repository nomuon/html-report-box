/**
 * BLOCK: MIME mismatch — content that does not match its claimed type:
 *  - an "HTML" upload whose bytes are actually a binary container/executable
 *  - a zip entry with a media extension (served as image/font) whose bytes
 *    are actually HTML/script/SVG (polyglot smuggling).
 * These are entry/upload-level sniffs invoked by the scanner directly, not
 * ScanContext rules (there is nothing to parse when the type is wrong).
 */
import type { ScanFinding } from "@hrb/shared";
import { finding } from "./rule.ts";

export const MIME_MISMATCH_RULE_ID = "mime-mismatch";

const BINARY_SIGNATURES: ReadonlyArray<readonly [label: string, magic: readonly number[]]> = [
  ["zip archive", [0x50, 0x4b, 0x03, 0x04]],
  ["zip archive (empty)", [0x50, 0x4b, 0x05, 0x06]],
  ["Windows executable (MZ)", [0x4d, 0x5a]],
  ["ELF executable", [0x7f, 0x45, 0x4c, 0x46]],
  ["PDF document", [0x25, 0x50, 0x44, 0x46]],
  ["PNG image", [0x89, 0x50, 0x4e, 0x47]],
  ["GIF image", [0x47, 0x49, 0x46, 0x38]],
  ["JPEG image", [0xff, 0xd8, 0xff]],
];

/**
 * UTF-16 / UTF-32 byte-order marks. The scanner decodes every HTML/SVG/JS
 * source as UTF-8, but browsers give a leading UTF-16/UTF-32 BOM higher
 * precedence than the HTTP charset — a classic filter-bypass: a payload saved
 * as UTF-16 decodes to garbage under UTF-8 (so every DOM rule no-ops) yet the
 * browser renders and executes it. We reject such uploads outright (the UTF-8
 * BOM, 0xEF 0xBB 0xBF, is intentionally NOT listed — it decodes correctly).
 * Order matters: the 4-byte UTF-32 marks must precede the 2-byte UTF-16 marks
 * they share a prefix with.
 */
const BOM_SIGNATURES: ReadonlyArray<readonly [label: string, magic: readonly number[]]> = [
  ["UTF-32 LE encoded text (BOM)", [0xff, 0xfe, 0x00, 0x00]],
  ["UTF-32 BE encoded text (BOM)", [0x00, 0x00, 0xfe, 0xff]],
  ["UTF-16 LE encoded text (BOM)", [0xff, 0xfe]],
  ["UTF-16 BE encoded text (BOM)", [0xfe, 0xff]],
];

function matchSignatures(
  data: Uint8Array,
  signatures: ReadonlyArray<readonly [label: string, magic: readonly number[]]>,
): string | null {
  for (const [label, magic] of signatures) {
    if (data.byteLength < magic.length) continue;
    let matches = true;
    for (let i = 0; i < magic.length; i += 1) {
      if (data[i] !== magic[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return label;
  }
  return null;
}

function matchBinarySignature(data: Uint8Array): string | null {
  return matchSignatures(data, BINARY_SIGNATURES);
}

/** A UTF-16/UTF-32 BOM the browser would honor over the served charset, else null. */
export function matchBomSignature(data: Uint8Array): string | null {
  return matchSignatures(data, BOM_SIGNATURES);
}

/** Extensions delivered with a media/font Content-Type (never text/html). */
const MEDIA_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
]);

const HTML_HEAD_MARKERS = ["<!doctype", "<html", "<script", "<svg", "<iframe", "<?xml"];

function looksLikeMarkup(data: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(data.subarray(0, 512))
    .replace(/^﻿/, "")
    .trimStart()
    .toLowerCase();
  if (HTML_HEAD_MARKERS.some((marker) => head.startsWith(marker))) return true;
  return head.includes("<script");
}

/** kind=html uploads: reject bytes that are really a binary container. */
export function sniffHtmlUploadMismatch(data: Uint8Array): ScanFinding | null {
  const bom = matchBomSignature(data);
  if (bom !== null) {
    return finding(
      MIME_MISMATCH_RULE_ID,
      "block",
      `upload declared as HTML but content is ${bom}; re-save as UTF-8`,
    );
  }
  const label = matchBinarySignature(data);
  if (label === null) return null;
  return finding(
    MIME_MISMATCH_RULE_ID,
    "block",
    `upload declared as HTML but content is a ${label}`,
  );
}

/** zip entries with a markup/script extension: reject UTF-16/UTF-32 BOM sources. */
export function sniffEntryBomMismatch(entry: {
  path: string;
  data: Uint8Array;
}): ScanFinding | null {
  const bom = matchBomSignature(entry.data);
  if (bom === null) return null;
  return {
    ...finding(
      MIME_MISMATCH_RULE_ID,
      "block",
      `zip entry is ${bom}; browsers honor the BOM over the served charset — re-save as UTF-8`,
    ),
    entryPath: entry.path,
  };
}

/** zip entries: a media-typed entry whose content is markup/script. */
export function sniffZipEntryMismatch(entry: {
  path: string;
  data: Uint8Array;
  ext: string;
}): ScanFinding | null {
  if (!MEDIA_EXTENSIONS.has(entry.ext)) return null;
  if (!looksLikeMarkup(entry.data)) return null;
  return {
    ...finding(
      MIME_MISMATCH_RULE_ID,
      "block",
      `zip entry has media extension ${entry.ext} but contains HTML/script content`,
    ),
    entryPath: entry.path,
  };
}
