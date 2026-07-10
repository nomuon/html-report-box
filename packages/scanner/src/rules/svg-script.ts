/**
 * BLOCK: script inside SVG content — <script> elements, on* handlers or
 * javascript: URLs in SVG (inline or standalone .svg entries). SVG passes casual
 * review as "an image" while executing with full DOM access.
 */
import type { Rule } from "./rule.ts";
import { finding } from "./rule.ts";

const RULE_ID = "svg-script";

export const svgScriptRule: Rule = {
  id: RULE_ID,
  evaluate(ctx) {
    const out = [];
    if (ctx.svgScripts > 0) {
      out.push(
        finding(
          RULE_ID,
          "block",
          `script element inside SVG content (${ctx.svgScripts} occurrence(s))`,
        ),
      );
    }
    if (ctx.svgEventHandlers > 0) {
      out.push(
        finding(
          RULE_ID,
          "block",
          `event handler / javascript: URL inside SVG content (${ctx.svgEventHandlers} occurrence(s))`,
        ),
      );
    }
    return out;
  },
};
