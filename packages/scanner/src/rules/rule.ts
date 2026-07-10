/**
 * Rule plugin contract — one rule per file, all consuming the shared
 * ScanContext. Services (domain reputation, config) are injected so rules
 * stay pure and unit-testable. Portable (Node 22).
 */
import type { ScanFinding } from "@hrb/shared";
import type { DomainReputation } from "@hrb/core";
import type { ResolvedScannerConfig } from "../config.ts";
import type { ScanContext } from "../context.ts";

export interface RuleServices {
  domainReputation: DomainReputation;
  config: ResolvedScannerConfig;
}

export interface Rule {
  id: string;
  evaluate(ctx: ScanContext, services: RuleServices): ScanFinding[] | Promise<ScanFinding[]>;
}

export function finding(
  ruleId: string,
  severity: "warn" | "block",
  message: string,
  detail?: string,
): ScanFinding {
  return {
    ruleId,
    severity,
    message,
    ...(detail !== undefined ? { detail } : {}),
  };
}
