/**
 * スキャン findings の一覧 — ruleId ごとの日本語ガイダンス（タイトル + なぜ危険か
 * + 対処）を表示し、元の英語 message / detail は折りたたみで証拠として残す。
 * 未知の ruleId は元 message をそのまま表示するフォールバック。
 */
import type { ScanFinding } from "@hrb/shared";
import { scanRuleGuidance } from "@hrb/shared";

export function FindingsList({ findings }: { findings: ScanFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <ul className="hrb-findings">
      {findings.map((f, i) => {
        const guidance = scanRuleGuidance(f.ruleId);
        if (!guidance) {
          return (
            <li key={i} className="hrb-findings__item">
              {f.entryPath !== undefined && (
                <code className="hrb-findings__entry">{f.entryPath}</code>
              )}
              {f.message}
            </li>
          );
        }
        return (
          <li key={i} className="hrb-findings__item">
            <span className="hrb-findings__head">
              <strong className="hrb-findings__title">{guidance.title}</strong>
              {f.entryPath !== undefined && (
                <code className="hrb-findings__entry">{f.entryPath}</code>
              )}
            </span>
            <span className="hrb-findings__why">{guidance.why}</span>
            <span className="hrb-findings__fix">対処: {guidance.fix}</span>
            <details className="hrb-findings__evidence">
              <summary>検出内容（原文）</summary>
              <code>
                {f.message}
                {f.detail !== undefined ? ` — ${f.detail}` : ""}
              </code>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
