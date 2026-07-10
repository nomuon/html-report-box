/**
 * Zip validation errors. Extends DomainError (validation_failed / 400) so the
 * HTTP layer maps failures cleanly; `zipCode` lets the scanner convert the
 * security-relevant subset into BLOCK findings instead. Portable (Node 22).
 */
import { DomainError } from "@hrb/core";

export type ZipValidationCode =
  | "zip_slip"
  | "symlink_entry"
  | "encrypted_entry"
  | "zip_bomb_entries"
  | "zip_bomb_size"
  | "zip_bomb_ratio"
  | "nested_zip"
  | "disallowed_extension"
  | "missing_root_index"
  | "invalid_zip";

/** Codes that indicate a hostile archive (scanner turns these into block). */
export const SECURITY_ZIP_CODES: ReadonlySet<ZipValidationCode> = new Set([
  "zip_slip",
  "symlink_entry",
  "encrypted_entry",
  "zip_bomb_entries",
  "zip_bomb_size",
  "zip_bomb_ratio",
  "nested_zip",
  "disallowed_extension",
]);

export class ZipValidationError extends DomainError {
  readonly zipCode: ZipValidationCode;
  readonly entryPath: string | undefined;

  constructor(zipCode: ZipValidationCode, message: string, entryPath?: string) {
    super("validation_failed", message);
    this.name = "ZipValidationError";
    this.zipCode = zipCode;
    this.entryPath = entryPath;
  }

  get securityRelevant(): boolean {
    return SECURITY_ZIP_CODES.has(this.zipCode);
  }
}
