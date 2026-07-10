/**
 * Resolves the prebundled Lambda code produced by scripts/build-lambda.ts
 * (dist/<name>/index.mjs). Falls back to an inline placeholder so `cdk synth`
 * and Template-based tests work before the api/mcp entrypoints are bundled.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aws_lambda as lambda } from "aws-cdk-lib";

const DIST_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

export const PLACEHOLDER_HANDLER_CODE = `exports.handler = async () => ({
  statusCode: 501,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ error: { code: "not_implemented", message: "placeholder bundle - run scripts/build-lambda.ts" } }),
});`;

export function resolveBundledCode(name: "api" | "mcp"): lambda.Code {
  const dir = join(DIST_ROOT, name);
  if (existsSync(join(dir, "index.mjs"))) {
    return lambda.Code.fromAsset(dir);
  }
  return lambda.Code.fromInline(PLACEHOLDER_HANDLER_CODE);
}
