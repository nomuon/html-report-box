/**
 * @hrb/scanner — AWS-independent static analysis (pass / warn / block).
 * parse5-based ScanContext + pluggable Rule files, plus the guarded
 * ZipExtractor (fflate). Implements the SecurityScanner / ZipExtractor
 * ports from @hrb/core. Portable (Node 22 compatible, no Bun-only APIs).
 */
export const PACKAGE_NAME = "@hrb/scanner";

export { createScanner, type CreateScannerOptions } from "./scanner.ts";
export { createZipExtractor } from "./zip/extractor.ts";
export {
  SECURITY_ZIP_CODES,
  ZipValidationError,
  type ZipValidationCode,
} from "./zip/errors.ts";
export {
  DEFAULT_SCANNER_CONFIG,
  resolveConfig,
  type ResolvedScannerConfig,
  type ScannerConfig,
} from "./config.ts";
export {
  buildJsContext,
  buildScanContext,
  type ScanContext,
  type ScanDocType,
} from "./context.ts";
export { DEFAULT_RULES, finding, type Rule, type RuleServices } from "./rules/index.ts";
export {
  MIME_MISMATCH_RULE_ID,
  sniffHtmlUploadMismatch,
  sniffZipEntryMismatch,
} from "./rules/mime-mismatch.ts";
export {
  escapeDensity,
  evalVocabulary,
  findDecodeExecChain,
  shannonEntropy,
} from "./js-metrics.ts";
