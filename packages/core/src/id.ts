/**
 * nanoid-compatible id generator (21 chars, [A-Za-z0-9_-]).
 * Uses WebCrypto (available in Node 22 and Bun); portable.
 */
import { REPORT_ID_LENGTH } from "@hrb/shared";

// nanoid's default url-safe alphabet (64 chars).
const ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

export function generateId(size: number = REPORT_ID_LENGTH): string {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) {
    id += ALPHABET[b & 63];
  }
  return id;
}
