/**
 * スキャナに登録されている全ルールの ruleId が @hrb/shared の日本語ガイダンス
 * 辞書（SCAN_RULE_GUIDANCE）に存在することを保証する。ルール追加時に辞書の
 * 追記漏れがあるとここで落ちる。
 */
import { expect, test } from "bun:test";
import { SCAN_RULE_GUIDANCE } from "@hrb/shared";
import { DEFAULT_RULES } from "./rules/index.ts";
import { MIME_MISMATCH_RULE_ID } from "./rules/mime-mismatch.ts";
import { ZIP_ERROR_RULE_IDS } from "./scanner.ts";

test("登録済みの全 ruleId にガイダンス辞書のエントリがある", () => {
  const registered = [
    ...DEFAULT_RULES.map((rule) => rule.id),
    MIME_MISMATCH_RULE_ID,
    ...ZIP_ERROR_RULE_IDS,
  ];
  const missing = registered.filter((ruleId) => SCAN_RULE_GUIDANCE[ruleId] === undefined);
  expect(missing).toEqual([]);
});
