/**
 * BLOCK: immediate meta refresh to an external origin — the classic
 * "shared report" that instantly bounces the viewer to an attacker page.
 */
import type { Rule } from "./rule.ts";
import { finding } from "./rule.ts";
import { isExternalHttpUrl, snippet } from "../url.ts";

const RULE_ID = "meta-refresh-external";

export const metaRefreshExternalRule: Rule = {
  id: RULE_ID,
  evaluate(ctx, { config }) {
    const out = [];
    for (const refresh of ctx.metaRefresh) {
      if (refresh.delaySeconds > config.immediateRefreshSeconds) continue;
      if (!isExternalHttpUrl(refresh.url)) continue;
      out.push(
        finding(
          RULE_ID,
          "block",
          `immediate meta refresh (${refresh.delaySeconds}s) to an external URL`,
          snippet(refresh.url),
        ),
      );
    }
    return out;
  },
};
