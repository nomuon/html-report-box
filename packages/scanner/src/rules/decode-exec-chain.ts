/**
 * BLOCK: decode-execute chains — decoded data (atob/unescape/fromCharCode/
 * decodeURIComponent) flowing directly into an execution sink (eval/
 * Function/document.write/string timers). Classic packed-payload dropper.
 */
import type { Rule } from "./rule.ts";
import { finding } from "./rule.ts";
import { findDecodeExecChain } from "../js-metrics.ts";
import { snippet } from "../url.ts";

const RULE_ID = "decode-exec-chain";

export const decodeExecChainRule: Rule = {
  id: RULE_ID,
  evaluate(ctx) {
    const out = [];
    for (const code of ctx.codeBlobs) {
      const match = findDecodeExecChain(code);
      if (match !== null) {
        out.push(
          finding(
            RULE_ID,
            "block",
            "decoded data flows directly into an execution sink (decode-execute chain)",
            snippet(match),
          ),
        );
      }
    }
    return out;
  },
};
