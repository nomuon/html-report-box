/**
 * BLOCK: hidden iframes with a src — invisible embedded content (drive-by
 * loaders, hidden C2/exfil frames, click-fraud). Visibility is derived from
 * inline style, hidden attribute, ~zero dimensions or hidden ancestors.
 */
import type { Rule } from "./rule.ts";
import { finding } from "./rule.ts";
import { snippet } from "../url.ts";

const RULE_ID = "hidden-iframe";

export const hiddenIframeRule: Rule = {
  id: RULE_ID,
  evaluate(ctx) {
    const out = [];
    for (const frame of ctx.iframes) {
      if (!frame.hidden || frame.src === undefined) continue;
      out.push(
        finding(RULE_ID, "block", "hidden iframe loading external content", snippet(frame.src)),
      );
    }
    return out;
  },
};
