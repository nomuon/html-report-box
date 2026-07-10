/**
 * @hrb/core — domain services + ports (ReportRepository / SearchIndex /
 * ObjectStorage / AuthVerifier / CdnInvalidator / UserAdmin / SecurityScanner
 * / DomainReputation / ZipExtractor).
 *
 * This entrypoint is portable (Node 22 / Lambda). Bun-friendly local dev
 * adapters live under "@hrb/core/local" and must NOT be re-exported here.
 * AWS adapters arrive in S6.
 */
import { PACKAGE_NAME as SHARED_PACKAGE_NAME } from "@hrb/shared";

export const PACKAGE_NAME = "@hrb/core";
export const DEPENDS_ON = SHARED_PACKAGE_NAME;

export * from "./ports.ts";
export * from "./errors.ts";
export { generateId } from "./id.ts";
export { contentTypeForPath } from "./content-type.ts";
export { extractHtml, type HtmlExtraction } from "./html/extract.ts";
export { ReportService, type AuditInfo, type ReportServiceDeps } from "./report-service.ts";
