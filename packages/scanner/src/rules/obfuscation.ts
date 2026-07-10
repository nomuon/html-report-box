/**
 * WARN: obfuscation score — composite of Shannon entropy (> threshold),
 * escape-sequence density (> threshold) and decode/eval vocabulary breadth.
 * Two of three signals raise a warn; combined with a decode-execute chain
 * the separate BLOCK rule fires, satisfying "warn alone, block together".
 */
import type { Rule } from "./rule.ts";
import { finding } from "./rule.ts";
import { escapeDensity, evalVocabulary, shannonEntropy } from "../js-metrics.ts";

const RULE_ID = "obfuscation";
const MIN_EVAL_VOCAB = 3;
const MAX_FINDINGS_PER_DOC = 3;

export const obfuscationRule: Rule = {
  id: RULE_ID,
  evaluate(ctx, { config }) {
    const out = [];
    for (const code of ctx.codeBlobs) {
      if (code.length < config.minObfuscationCodeLength) continue;
      const signals: string[] = [];
      const entropy = shannonEntropy(code);
      if (entropy > config.entropyThreshold) signals.push(`entropy=${entropy.toFixed(2)}`);
      const density = escapeDensity(code);
      if (density > config.escapeDensityThreshold) {
        signals.push(`escape-density=${(density * 100).toFixed(1)}%`);
      }
      const vocab = evalVocabulary(code);
      if (vocab.length >= MIN_EVAL_VOCAB) signals.push(`eval-vocab=[${vocab.join(",")}]`);
      if (signals.length >= config.minObfuscationSignals) {
        out.push(
          finding(
            RULE_ID,
            "warn",
            "script exceeds the obfuscation score threshold",
            signals.join(" "),
          ),
        );
        if (out.length >= MAX_FINDINGS_PER_DOC) break;
      }
    }
    return out;
  },
};
