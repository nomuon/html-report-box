import { expect, test } from "bun:test";
import { SCAN_RULE_GUIDANCE, scanFindingSummary, scanRuleGuidance } from "./scan-guidance.ts";

test("既知の ruleId は title/why/fix をすべて持つ", () => {
  const incomplete = Object.entries(SCAN_RULE_GUIDANCE)
    .filter(([, g]) => g.title.length === 0 || g.why.length === 0 || g.fix.length === 0)
    .map(([ruleId]) => ruleId);
  expect(incomplete).toEqual([]);
});

test("scanRuleGuidance: 未知の ruleId は undefined", () => {
  expect(scanRuleGuidance("phishing-form")?.title).toBe("フィッシングフォームの疑い");
  expect(scanRuleGuidance("no-such-rule")).toBeUndefined();
});

test("scanFindingSummary: 未知の ruleId は元 message にフォールバックする", () => {
  expect(scanFindingSummary({ ruleId: "obfuscation", message: "entropy=5.9" })).toBe(
    "難読化されたスクリプト",
  );
  expect(scanFindingSummary({ ruleId: "no-such-rule", message: "raw english message" })).toBe(
    "raw english message",
  );
});
