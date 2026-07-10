/**
 * Opaque pagination cursors for DynamoDB queries: base64url-encoded JSON of
 * the LastEvaluatedKey. Portable (Node 22 / Lambda).
 */
import { Buffer } from "node:buffer";
import { DomainError } from "../errors.ts";

export function encodeKeyCursor(key: Record<string, unknown> | undefined): string | undefined {
  if (!key) return undefined;
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

export function decodeKeyCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new DomainError("bad_request", "invalid cursor");
  }
}
