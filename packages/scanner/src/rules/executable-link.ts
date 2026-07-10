/**
 * BLOCK: links to executable payloads (.exe/.hta/.ps1/.scr/.bat/.cmd/.msi/
 * .vbs/...) — malware download bait inside a "report".
 */
import type { Rule } from "./rule.ts";
import { finding } from "./rule.ts";
import { pathExtension, snippet } from "../url.ts";

const RULE_ID = "executable-link";

export const executableLinkRule: Rule = {
  id: RULE_ID,
  evaluate(ctx, { config }) {
    const executable = new Set(config.executableExtensions);
    const out = [];
    for (const anchor of ctx.anchors) {
      const hrefExt = anchor.href !== undefined ? pathExtension(anchor.href) : "";
      if (hrefExt !== "" && executable.has(hrefExt)) {
        out.push(
          finding(
            RULE_ID,
            "block",
            `link points at an executable payload (${hrefExt})`,
            snippet(anchor.href ?? ""),
          ),
        );
        continue;
      }
      const downloadExt =
        anchor.download !== undefined && anchor.download !== ""
          ? pathExtension(anchor.download)
          : "";
      if (downloadExt !== "" && executable.has(downloadExt)) {
        out.push(
          finding(
            RULE_ID,
            "block",
            `download attribute names an executable file (${downloadExt})`,
            snippet(anchor.download ?? ""),
          ),
        );
      }
    }
    return out;
  },
};
