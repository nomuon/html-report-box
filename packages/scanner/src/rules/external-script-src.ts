/**
 * WARN: script src outside the CDN allowlist (@hrb/shared ALLOWED_CDN_HOSTS).
 * CSP blocks these at runtime; flagged so admins see the attempt.
 */
import { isAllowedCdnHost } from "@hrb/shared";
import type { Rule } from "./rule.ts";
import { finding } from "./rule.ts";
import { externalHost, snippet } from "../url.ts";

const RULE_ID = "external-script-src";

export const externalScriptSrcRule: Rule = {
  id: RULE_ID,
  evaluate(ctx) {
    const seen = new Set<string>();
    const out = [];
    for (const script of ctx.scripts) {
      if (script.src === undefined) continue;
      const host = externalHost(script.src);
      if (host === null || isAllowedCdnHost(host) || seen.has(host)) continue;
      seen.add(host);
      out.push(
        finding(
          RULE_ID,
          "warn",
          `script loaded from a host outside the CDN allowlist (${host})`,
          snippet(script.src),
        ),
      );
    }
    return out;
  },
};
