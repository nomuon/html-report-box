/**
 * BLOCK: references to known-malicious domains (URLhaus/OpenPhish feed via
 * the injected DomainReputation service; allowlist-only stub in local dev).
 */
import type { ScanFinding } from "@hrb/shared";
import type { Rule } from "./rule.ts";
import { finding } from "./rule.ts";
import { externalHost } from "../url.ts";

const RULE_ID = "malicious-domain";

export const maliciousDomainRule: Rule = {
  id: RULE_ID,
  async evaluate(ctx, { domainReputation }) {
    const hosts = new Set<string>();
    for (const url of ctx.urls) {
      const host = externalHost(url);
      if (host !== null) hosts.add(host);
    }
    const out: ScanFinding[] = [];
    for (const host of hosts) {
      if (await domainReputation.isMalicious(host)) {
        out.push(finding(RULE_ID, "block", "document references a known-malicious domain", host));
      }
    }
    return out;
  },
};
