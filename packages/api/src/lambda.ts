/**
 * Lambda entrypoint — hono/aws-lambda adapter around createApp().
 * The AWS adapter wiring (DynamoDB / S3 / CloudFront / Cognito, built from
 * environment variables) lands in S6; until then createAwsContext() is a stub.
 * Portable (Node 22); no Bun-only APIs.
 */
import { handle } from "hono/aws-lambda";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { createApp } from "./app.ts";
import type { AppContext } from "./app.ts";

/**
 * TODO(S6): build the production AppContext from environment variables:
 *   - REPORTS_TABLE / SEARCH_TABLE  → DynamoDB ReportRepository / SearchIndex
 *   - STAGING_BUCKET / CONTENT_BUCKET → S3 ObjectStorage (presigned POST)
 *   - CONTENT_DISTRIBUTION_ID → CloudFront CdnInvalidator
 *   - COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID → aws-jwt-verify AuthVerifier + Cognito UserAdmin
 *   - CONTENT_BASE_URL → contentBaseUrl
 *   - @hrb/scanner → SecurityScanner / ZipExtractor
 */
export function createAwsContext(): AppContext {
  throw new Error("createAwsContext is wired in S6 (AWS adapters not yet implemented)");
}

let cached: ReturnType<typeof handle> | undefined;

export const handler = (event: LambdaEvent, lambdaContext?: LambdaContext) => {
  cached ??= handle(createApp(createAwsContext()));
  return cached(event, lambdaContext);
};
