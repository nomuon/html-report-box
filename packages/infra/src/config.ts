/**
 * Context-parameter resolution for @hrb/infra.
 *
 * Every parameter has a default so `cdk synth` succeeds with zero context.
 * Override via `cdk synth -c allowedCidrs=203.0.113.0/24,198.51.100.0/24 -c domain=example.com ...`
 * or via cdk.json "context".
 */
import type { App } from "aws-cdk-lib";

export interface HrbInfraConfig {
  /** Target AWS account. Default: CDK_DEFAULT_ACCOUNT or a placeholder (synth-only). */
  account: string;
  /** Main region for Stateful/App/Cdn stacks (Edge/WAF is always us-east-1). */
  region: string;
  /** CIDRs allowed through the WAF IPSet. WAF default action is Block. */
  allowedCidrs: string[];
  /** Root domain, e.g. "example.com" -> app.<domain> / reports.<domain>. Optional. */
  domain?: string;
  appDomain?: string;
  contentDomain?: string;
  /** Google OAuth client id for the Cognito Google IdP. */
  googleClientId: string;
  /** SSM SecureString parameter name holding the Google OAuth client secret. */
  googleClientSecretSsmParam: string;
  /** Cognito hosted-UI domain prefix. */
  cognitoDomainPrefix: string;
  /**
   * Shared secret CloudFront attaches as the `x-origin-verify` header on the
   * API origin; the api Lambda rejects requests without it (blocks direct
   * API Gateway access). Rotate by redeploying with a new context value.
   */
  originVerifySecret: string;
  /** WAF rate-based rule limit (requests / 5 min / IP). */
  wafRateLimit: number;
  /**
   * Base URL for shared report links (content distribution / Distribution B).
   * When `domain` is unset the real CloudFront domain is only known after
   * deploy; HrbCdnStack also publishes it to SSM `/hrb/content-base-url`.
   */
  contentBaseUrl: string;
}

function ctxString(app: App, key: string): string | undefined {
  const v = app.node.tryGetContext(key);
  if (v === undefined || v === null || v === "") return undefined;
  return String(v);
}

function ctxList(app: App, key: string): string[] | undefined {
  const v = app.node.tryGetContext(key);
  if (v === undefined || v === null || v === "") return undefined;
  if (Array.isArray(v)) return v.map(String);
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadConfig(app: App): HrbInfraConfig {
  const domain = ctxString(app, "domain");
  const contentDomain = domain ? `reports.${domain}` : undefined;
  return {
    account: ctxString(app, "account") ?? process.env.CDK_DEFAULT_ACCOUNT ?? "000000000000",
    region: ctxString(app, "region") ?? process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1",
    allowedCidrs: ctxList(app, "allowedCidrs") ?? ["10.0.0.0/8"],
    domain,
    appDomain: domain ? `app.${domain}` : undefined,
    contentDomain,
    googleClientId:
      ctxString(app, "googleClientId") ?? "dummy-google-client-id.apps.googleusercontent.com",
    googleClientSecretSsmParam:
      ctxString(app, "googleClientSecretSsmParam") ?? "/hrb/google-client-secret",
    cognitoDomainPrefix: ctxString(app, "cognitoDomainPrefix") ?? "hrb-report-box",
    originVerifySecret: ctxString(app, "originVerifySecret") ?? "hrb-origin-verify-dev",
    wafRateLimit: Number(ctxString(app, "wafRateLimit") ?? 2000),
    contentBaseUrl:
      ctxString(app, "contentBaseUrl") ??
      (contentDomain ? `https://${contentDomain}` : "https://content.invalid"),
  };
}
