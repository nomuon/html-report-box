/**
 * WARN: blob download chain — URL.createObjectURL combined with a download
 * trigger (anchor.download assignment or <a download> in the DOM). Used to
 * synthesize file downloads client-side, invisible to network inspection.
 */
import type { Rule } from "./rule.ts";
import { finding } from "./rule.ts";

const RULE_ID = "blob-download-chain";

const CREATE_OBJECT_URL = /\bURL\s*\.\s*createObjectURL\s*\(|\bwebkitURL\s*\.\s*createObjectURL\s*\(/;
const DOWNLOAD_ASSIGNMENT = /\.\s*download\s*=|\bdownload\s*:\s*['"`]|\bmsSaveOrOpenBlob\b|\bmsSaveBlob\b/;

export const blobDownloadChainRule: Rule = {
  id: RULE_ID,
  evaluate(ctx) {
    const code = ctx.codeBlobs.join("\n");
    if (!CREATE_OBJECT_URL.test(code)) return [];
    const domDownloadAnchor = ctx.anchors.some((a) => a.hasDownload);
    if (!DOWNLOAD_ASSIGNMENT.test(code) && !domDownloadAnchor) return [];
    return [
      finding(
        RULE_ID,
        "warn",
        "script synthesizes a file download from a blob (createObjectURL + download trigger)",
      ),
    ];
  },
};
