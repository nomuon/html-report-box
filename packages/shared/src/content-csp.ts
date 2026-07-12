/**
 * CSP + security headers for the content distribution (/r/*).
 *
 * Policy (per security plan): allow uploaded reports to run their own JS and
 * pull from the 4 allow-listed CDNs + Google Fonts, but block exfiltration
 * (connect-src 'self'), phishing form posts (form-action 'self'), framing of
 * third parties (frame-src 'none') and plugin content. No 'unsafe-eval'.
 *
 * shared に置く理由: CloudFront（packages/infra）とローカル/VPS サーバー
 * （packages/api/src/local）が同一ポリシーを配信し、scanner の allowlist と
 * CSP がドリフトしないようにするため。
 */
import { ALLOWED_CDN_HOSTS } from "./constants.ts";

const GOOGLE_FONTS_CSS_HOST = "fonts.googleapis.com";
const GOOGLE_FONTS_FONT_HOST = "fonts.gstatic.com";

function https(hosts: readonly string[]): string {
  return hosts.map((h) => `https://${h}`).join(" ");
}

export function buildContentCsp(): string {
  const cdn = https(ALLOWED_CDN_HOSTS);
  return [
    `default-src 'self'`,
    `script-src 'self' 'unsafe-inline' ${cdn}`,
    `style-src 'self' 'unsafe-inline' ${cdn} https://${GOOGLE_FONTS_CSS_HOST}`,
    `font-src 'self' data: ${cdn} https://${GOOGLE_FONTS_FONT_HOST}`,
    `img-src 'self' data: blob:`,
    `connect-src 'self'`,
    `form-action 'self'`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
  ].join("; ");
}

/** X-Robots-Tag value attached to all content responses. */
export const CONTENT_X_ROBOTS_TAG = "noindex";
