/**
 * WARN: JS redirect to an external origin — location assignment /
 * location.assign|replace with an absolute URL literal. CSP cannot stop
 * top-level navigation, so this is flagged for review.
 */
import type { Rule } from "./rule.ts";
import { finding } from "./rule.ts";
import { snippet } from "../url.ts";

const RULE_ID = "js-redirect-external";

// location = "http..." / location.href = ... / location.assign("http...") /
// window.location.replace("//evil") — comparison operators excluded.
const REDIRECT_SINK =
  /(?:\b(?:window|document|top|parent|self)\s*\.\s*)?\blocation\b\s*(?:\.\s*(?:href|assign|replace)\s*)?(?:=(?!=)|\(\s*)\s*(['"`])\s*(?:https?:)?\/\/[^'"`]{3,}\1/i;

export const jsRedirectExternalRule: Rule = {
  id: RULE_ID,
  evaluate(ctx) {
    const out = [];
    for (const code of ctx.codeBlobs) {
      const match = REDIRECT_SINK.exec(code);
      if (match) {
        out.push(
          finding(
            RULE_ID,
            "warn",
            "script redirects the page to an external URL",
            snippet(match[0]),
          ),
        );
      }
    }
    return out;
  },
};
