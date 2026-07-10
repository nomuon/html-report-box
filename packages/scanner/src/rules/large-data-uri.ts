/**
 * BLOCK: large non-media data: URI payloads — smuggled binaries/documents
 * embedded directly in the page (bypasses any network-level inspection).
 * Media types (png/jpeg/... but NOT svg) are exempt: Claude-generated
 * reports legitimately embed large chart images as base64.
 */
import type { Rule } from "./rule.ts";
import { finding } from "./rule.ts";

const RULE_ID = "large-data-uri";

/** image/audio/video/font are payload-inert; svg is a scriptable document. */
function isInertMediaMime(mime: string): boolean {
  if (mime === "image/svg+xml") return false;
  return /^(?:image|audio|video|font)\//.test(mime);
}

export function dataUriPayloadBytes(value: string): { mime: string; bytes: number } | null {
  if (!value.toLowerCase().startsWith("data:")) return null;
  const comma = value.indexOf(",");
  if (comma === -1) return null;
  const header = value.slice(5, comma);
  const payload = value.slice(comma + 1);
  const mime = (header.split(";", 1)[0] ?? "").trim().toLowerCase() || "text/plain";
  const isBase64 = /;\s*base64\s*(?:;|$)/i.test(header);
  const bytes = isBase64 ? Math.floor((payload.length * 3) / 4) : payload.length;
  return { mime, bytes };
}

export const largeDataUriRule: Rule = {
  id: RULE_ID,
  evaluate(ctx, { config }) {
    const out = [];
    for (const ref of ctx.dataUris) {
      const parsed = dataUriPayloadBytes(ref.value);
      if (!parsed) continue;
      if (isInertMediaMime(parsed.mime)) continue;
      if (parsed.bytes <= config.largeDataUriBytes) continue;
      out.push(
        finding(
          RULE_ID,
          "block",
          `large embedded data: URI payload (${parsed.mime}, ~${parsed.bytes} bytes) on <${ref.tag} ${ref.attr}>`,
          ref.download ? "payload is offered as a download" : undefined,
        ),
      );
    }
    return out;
  },
};
