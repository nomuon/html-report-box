/**
 * Domain error carrying an API error code (see @hrb/shared ERROR_CODES).
 * The HTTP layer maps `httpStatus` / `code` to the `{error:{code,message}}` shape.
 * Portable (Node 22); no Bun-only APIs.
 */
import type { ErrorCode } from "@hrb/shared";

const HTTP_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  upload_incomplete: 400,
  scan_rejected: 422,
  internal: 500,
};

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
