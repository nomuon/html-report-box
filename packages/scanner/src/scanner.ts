/**
 * createScanner — @hrb/core SecurityScanner port implementation.
 * HTML uploads: one parse5 pass into ScanContext, consumed by every rule.
 * Zip uploads: guarded extraction (fflate), then recursive scanning of
 * html/htm/svg/js/mjs entries + per-entry MIME sniffs. Portable (Node 22).
 */
import type { ScanFinding, ScanVerdict } from "@hrb/shared";
import type {
  DomainReputation,
  ScanInput,
  ScanResult,
  SecurityScanner,
  ZipEntryFile,
  ZipExtractor,
} from "@hrb/core";
import { resolveConfig, type ScannerConfig } from "./config.ts";
import { buildJsContext, buildScanContext, type ScanContext } from "./context.ts";
import { DEFAULT_RULES, type Rule, type RuleServices } from "./rules/index.ts";
import {
  sniffEntryBomMismatch,
  sniffHtmlUploadMismatch,
  sniffZipEntryMismatch,
} from "./rules/mime-mismatch.ts";
import { createZipExtractor } from "./zip/extractor.ts";
import { ZipValidationError, type ZipValidationCode } from "./zip/errors.ts";
import { pathExtension } from "./url.ts";

/** Upper bound on findings persisted to report META. */
const MAX_FINDINGS = 50;

/** ruleIds for block findings synthesized from hostile-archive errors. */
const ZIP_BLOCK_RULE_IDS: Partial<Record<ZipValidationCode, string>> = {
  zip_slip: "zip-slip",
  symlink_entry: "zip-slip",
  encrypted_entry: "zip-encrypted",
  zip_bomb_entries: "zip-bomb",
  zip_bomb_size: "zip-bomb",
  zip_bomb_ratio: "zip-bomb",
  nested_zip: "zip-nested",
  disallowed_extension: "zip-disallowed-extension",
};

export interface CreateScannerOptions {
  domainReputation: DomainReputation;
  config?: ScannerConfig;
  /** Override the rule set (defaults to DEFAULT_RULES). */
  rules?: readonly Rule[];
  /** Override the zip extractor (defaults to createZipExtractor(config)). */
  zipExtractor?: ZipExtractor;
}

function verdictOf(findings: readonly ScanFinding[]): ScanVerdict {
  if (findings.some((f) => f.severity === "block")) return "block";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  return "pass";
}

function toResult(findings: ScanFinding[]): ScanResult {
  return { verdict: verdictOf(findings), findings: findings.slice(0, MAX_FINDINGS) };
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

export function createScanner(options: CreateScannerOptions): SecurityScanner {
  const config = resolveConfig(options.config);
  const rules = options.rules ?? DEFAULT_RULES;
  const services: RuleServices = { domainReputation: options.domainReputation, config };
  const zipExtractor = options.zipExtractor ?? createZipExtractor(options.config);

  async function runRules(ctx: ScanContext): Promise<ScanFinding[]> {
    const findings: ScanFinding[] = [];
    for (const rule of rules) {
      for (const f of await rule.evaluate(ctx, services)) {
        findings.push(
          ctx.entryPath !== undefined && f.entryPath === undefined
            ? { ...f, entryPath: ctx.entryPath }
            : f,
        );
      }
    }
    return findings;
  }

  async function scanHtmlUpload(data: Uint8Array): Promise<ScanResult> {
    const mismatch = sniffHtmlUploadMismatch(data);
    if (mismatch) return toResult([mismatch]);
    const ctx = buildScanContext(utf8.decode(data));
    return toResult(await runRules(ctx));
  }

  function contextForEntry(entry: ZipEntryFile, ext: string): ScanContext | null {
    if (ext === ".html" || ext === ".htm") {
      return buildScanContext(utf8.decode(entry.data), { entryPath: entry.path });
    }
    if (ext === ".svg") {
      return buildScanContext(utf8.decode(entry.data), {
        docType: "svg",
        entryPath: entry.path,
      });
    }
    if (ext === ".js" || ext === ".mjs") {
      return buildJsContext(utf8.decode(entry.data), entry.path);
    }
    return null;
  }

  async function scanZipUpload(data: Uint8Array): Promise<ScanResult> {
    let entries: ZipEntryFile[];
    try {
      entries = await zipExtractor.extract(data);
    } catch (err) {
      if (err instanceof ZipValidationError) {
        const ruleId = ZIP_BLOCK_RULE_IDS[err.zipCode];
        if (ruleId !== undefined) {
          return toResult([
            {
              ruleId,
              severity: "block",
              message: err.message,
              ...(err.entryPath !== undefined ? { entryPath: err.entryPath } : {}),
            },
          ]);
        }
      }
      throw err; // benign validation problems (corrupt zip, missing index.html)
    }

    const findings: ScanFinding[] = [];
    for (const entry of entries) {
      const ext = pathExtension(entry.path);
      const mismatch = sniffZipEntryMismatch({ path: entry.path, data: entry.data, ext });
      if (mismatch) findings.push(mismatch);
      const ctx = contextForEntry(entry, ext);
      if (ctx) {
        // Markup/script entries are decoded as UTF-8; a UTF-16/UTF-32 BOM would
        // make the parse no-op while the browser still executes the source.
        const bom = sniffEntryBomMismatch({ path: entry.path, data: entry.data });
        if (bom) findings.push(bom);
        else findings.push(...(await runRules(ctx)));
      }
    }
    return toResult(findings);
  }

  return {
    async scan(input: ScanInput): Promise<ScanResult> {
      if (input.kind === "zip") return scanZipUpload(input.data);
      return scanHtmlUpload(input.data);
    },
  };
}
