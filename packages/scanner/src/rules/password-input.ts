/**
 * WARN: any password input — a "report" should not collect credentials.
 * Held for admin review (the phishing-form BLOCK rule covers the clearly
 * malicious combinations).
 */
import type { Rule } from "./rule.ts";
import { finding } from "./rule.ts";

const RULE_ID = "password-input";

export const passwordInputRule: Rule = {
  id: RULE_ID,
  evaluate(ctx) {
    const count =
      ctx.forms.filter((form) => form.hasPasswordInput).length + ctx.orphanPasswordInputs;
    if (count === 0) return [];
    return [
      finding(
        RULE_ID,
        "warn",
        `document contains ${count} password input(s)`,
      ),
    ];
  },
};
