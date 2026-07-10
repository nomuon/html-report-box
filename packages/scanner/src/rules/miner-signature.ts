/**
 * BLOCK: browser cryptominer signatures (CoinHive/CryptoLoot/... library
 * names, stratum endpoints) in scripts, script URLs or referenced URLs.
 */
import type { Rule } from "./rule.ts";
import { finding } from "./rule.ts";

const RULE_ID = "miner-signature";

export const minerSignatureRule: Rule = {
  id: RULE_ID,
  evaluate(ctx, { config }) {
    const haystackParts = [
      ...ctx.codeBlobs,
      ...ctx.scripts.map((s) => s.src ?? ""),
      ...ctx.urls,
    ];
    const haystack = haystackParts.join("\n").toLowerCase();
    const out = [];
    for (const signature of config.minerSignatures) {
      if (haystack.includes(signature)) {
        out.push(finding(RULE_ID, "block", "cryptominer signature detected", signature));
      }
    }
    return out;
  },
};
