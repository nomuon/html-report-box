/**
 * Lambda entry plumbing for the MCP server (hono/aws-lambda).
 *
 * The concrete handler is assembled at deploy time (S6/S7) by injecting the
 * AWS-backed McpContext:
 *
 *   import { createMcpLambdaHandler } from "@hrb/mcp/lambda"; // or src path
 *   export const handler = createMcpLambdaHandler(awsContext);
 *
 * Auth: static API key via "Authorization: Bearer <MCP_API_KEY>". When the
 * MCP_API_KEY environment variable is unset the check is skipped (local /
 * closed-network deployments rely on WAF IP allow-listing).
 *
 * Portable (Node 22); no Bun-only APIs.
 */
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import type { LambdaEvent, LambdaContext } from "hono/aws-lambda";
import { bearerApiKeyAuth, createMcpApp } from "./index.ts";
import type { McpContext } from "./server.ts";

export interface McpLambdaOptions {
  /** Overrides process.env.MCP_API_KEY (mainly for tests). */
  apiKey?: string;
}

/**
 * Hono app with the API-key gate applied, serving MCP on both "/" and "/mcp"
 * (API Gateway routes the /mcp path through unchanged).
 */
export function createMcpLambdaApp(ctx: McpContext, options: McpLambdaOptions = {}): Hono {
  const apiKey = options.apiKey ?? process.env.MCP_API_KEY;
  const app = new Hono();
  app.use("*", bearerApiKeyAuth(apiKey));
  const mcp = createMcpApp(ctx);
  app.route("/", mcp);
  app.route("/mcp", mcp);
  return app;
}

export function createMcpLambdaHandler(
  ctx: McpContext,
  options: McpLambdaOptions = {},
): (event: LambdaEvent, context?: LambdaContext) => Promise<unknown> {
  return handle(createMcpLambdaApp(ctx, options));
}

/**
 * TODO(S6): build the production McpContext from environment variables:
 *   - REPORTS_TABLE / SEARCH_TABLE → DynamoDB-backed ReportService (read paths)
 *   - CONTENT_BUCKET / STAGING_BUCKET → S3 ObjectStorage
 *   - CONTENT_BASE_URL → report URLs
 */
export function createAwsMcpContext(): McpContext {
  throw new Error("createAwsMcpContext is wired in S6 (AWS adapters not yet implemented)");
}

let cached: ReturnType<typeof createMcpLambdaHandler> | undefined;

/** Default Lambda export (infra configures handler: "index.handler"). */
export const handler = (event: LambdaEvent, lambdaContext?: LambdaContext) => {
  cached ??= createMcpLambdaHandler(createAwsMcpContext());
  return cached(event, lambdaContext);
};
