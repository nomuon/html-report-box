/**
 * WARN: form posting to an external origin — data leaves our content origin
 * (CSP form-action 'self' blocks it at runtime, but flag it for review).
 */
import type { Rule } from "./rule.ts";
import { finding } from "./rule.ts";
import { isExternalHttpUrl, snippet } from "../url.ts";

const RULE_ID = "external-form-action";

export const externalFormActionRule: Rule = {
  id: RULE_ID,
  evaluate(ctx) {
    const seen = new Set<string>();
    const out = [];
    for (const form of ctx.forms) {
      for (const action of form.actions) {
        if (!isExternalHttpUrl(action) || seen.has(action)) continue;
        seen.add(action);
        out.push(
          finding(RULE_ID, "warn", "form submits to an external origin", snippet(action)),
        );
      }
    }
    return out;
  },
};
