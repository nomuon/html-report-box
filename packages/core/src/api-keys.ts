/**
 * Per-user API key helpers shared by the local / AWS ApiKeyStore adapters.
 * Keys look like "hrb_<43 chars base64url>"; only the sha256 hash is ever
 * persisted — the plaintext is returned once from issue() and then gone.
 * Portable (Node 22); no Bun-only APIs.
 */
import { createHash, randomBytes } from "node:crypto";

export const API_KEY_PREFIX = "hrb_";
/** Random secret length in bytes (>= 32 per the security requirement). */
export const API_KEY_SECRET_BYTES = 32;
/** Characters of the plaintext shown in listings ("hrb_" + 8). */
export const API_KEY_DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;

/** New plaintext key: "hrb_" + 32 random bytes, base64url. */
export function generateApiKeyPlaintext(): string {
  return `${API_KEY_PREFIX}${randomBytes(API_KEY_SECRET_BYTES).toString("base64url")}`;
}

/** Hex sha256 of the plaintext — the only stored representation of the key. */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Display prefix for listings (never enough to reconstruct the key). */
export function apiKeyDisplayPrefix(plaintext: string): string {
  return plaintext.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH);
}

/** True when a bearer token claims to be a per-user key (vs. the static MCP key). */
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}
