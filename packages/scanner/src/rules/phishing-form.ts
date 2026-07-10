/**
 * BLOCK: credential phishing form — a password input combined with either an
 * external form action (credentials leave our origin) or login-brand
 * vocabulary in the visible text (impersonation of a known IdP/brand).
 */
import type { Rule } from "./rule.ts";
import { finding } from "./rule.ts";
import { isExternalHttpUrl, snippet } from "../url.ts";

const RULE_ID = "phishing-form";

export const phishingFormRule: Rule = {
  id: RULE_ID,
  evaluate(ctx, { config }) {
    const out = [];
    const haystack = `${ctx.title.toLowerCase()} ${ctx.textLower}`;
    const brand = config.brandVocabulary.find((phrase) => haystack.includes(phrase));

    for (const form of ctx.forms) {
      if (!form.hasPasswordInput) continue;
      const externalAction = form.actions.find((action) => isExternalHttpUrl(action));
      if (externalAction) {
        out.push(
          finding(
            RULE_ID,
            "block",
            "password form submits credentials to an external origin",
            snippet(externalAction),
          ),
        );
      } else if (brand !== undefined) {
        out.push(
          finding(
            RULE_ID,
            "block",
            "password form combined with login-brand vocabulary (credential phishing pattern)",
            `matched phrase: ${brand}`,
          ),
        );
      }
    }

    if (ctx.orphanPasswordInputs > 0 && brand !== undefined) {
      out.push(
        finding(
          RULE_ID,
          "block",
          "standalone password input combined with login-brand vocabulary (credential phishing pattern)",
          `matched phrase: ${brand}`,
        ),
      );
    }
    return out;
  },
};
