/**
 * Rule registry — block rules first (short-circuit-friendly ordering for
 * humans reading findings), then warn rules. One rule per file.
 */
import type { Rule } from "./rule.ts";
import { phishingFormRule } from "./phishing-form.ts";
import { metaRefreshExternalRule } from "./meta-refresh-external.ts";
import { executableLinkRule } from "./executable-link.ts";
import { largeDataUriRule } from "./large-data-uri.ts";
import { decodeExecChainRule } from "./decode-exec-chain.ts";
import { maliciousDomainRule } from "./malicious-domain.ts";
import { hiddenIframeRule } from "./hidden-iframe.ts";
import { minerSignatureRule } from "./miner-signature.ts";
import { svgScriptRule } from "./svg-script.ts";
import { externalFormActionRule } from "./external-form-action.ts";
import { passwordInputRule } from "./password-input.ts";
import { jsRedirectExternalRule } from "./js-redirect-external.ts";
import { blobDownloadChainRule } from "./blob-download-chain.ts";
import { obfuscationRule } from "./obfuscation.ts";
import { externalScriptSrcRule } from "./external-script-src.ts";

export const DEFAULT_RULES: readonly Rule[] = [
  // ---- block ----
  phishingFormRule,
  metaRefreshExternalRule,
  executableLinkRule,
  largeDataUriRule,
  decodeExecChainRule,
  maliciousDomainRule,
  hiddenIframeRule,
  minerSignatureRule,
  svgScriptRule,
  // ---- warn ----
  externalFormActionRule,
  passwordInputRule,
  jsRedirectExternalRule,
  blobDownloadChainRule,
  obfuscationRule,
  externalScriptSrcRule,
];

export type { Rule, RuleServices } from "./rule.ts";
export { finding } from "./rule.ts";
export {
  phishingFormRule,
  metaRefreshExternalRule,
  executableLinkRule,
  largeDataUriRule,
  decodeExecChainRule,
  maliciousDomainRule,
  hiddenIframeRule,
  minerSignatureRule,
  svgScriptRule,
  externalFormActionRule,
  passwordInputRule,
  jsRedirectExternalRule,
  blobDownloadChainRule,
  obfuscationRule,
  externalScriptSrcRule,
};
export {
  MIME_MISMATCH_RULE_ID,
  sniffHtmlUploadMismatch,
  sniffZipEntryMismatch,
} from "./mime-mismatch.ts";
