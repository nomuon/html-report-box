#!/usr/bin/env bun
/**
 * Bundles the Lambda entrypoints into single-file ESM bundles consumed by
 * HrbAppStack as prebundled assets:
 *
 *   packages/api/src/lambda.ts -> packages/infra/dist/api/index.mjs
 *   packages/mcp/src/lambda.ts -> packages/infra/dist/mcp/index.mjs
 *
 * Uses `bun build --target=node --format=esm` with NO externals (everything
 * inlined; the bundle must run on plain Node 22 in Lambda).
 *
 * Bun-only tooling — infra itself is never shipped to Lambda.
 *
 * If an entrypoint does not exist yet (api/mcp under parallel development) a
 * placeholder bundle is written so `cdk synth` keeps working; a real build
 * failure of an existing entrypoint still fails the script.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const infraRoot = resolve(here, "..");
const repoRoot = resolve(infraRoot, "..", "..");

const TARGETS = [
  { name: "api", entry: join(repoRoot, "packages", "api", "src", "lambda.ts") },
  { name: "mcp", entry: join(repoRoot, "packages", "mcp", "src", "lambda.ts") },
] as const;

const PLACEHOLDER = `// Placeholder bundle written by scripts/build-lambda.ts because the real
// entrypoint did not exist at build time. Re-run the script once
// packages/<pkg>/src/lambda.ts lands.
export const handler = async () => ({
  statusCode: 501,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ error: { code: "not_implemented", message: "placeholder lambda bundle" } }),
});
`;

let failed = false;
for (const target of TARGETS) {
  const outDir = join(infraRoot, "dist", target.name);
  const outFile = join(outDir, "index.mjs");
  mkdirSync(outDir, { recursive: true });

  if (!existsSync(target.entry)) {
    console.warn(
      `[build-lambda] ${target.entry} not found — writing placeholder bundle (entrypoint in progress)`,
    );
    writeFileSync(outFile, PLACEHOLDER);
    continue;
  }

  const proc = Bun.spawnSync(
    ["bun", "build", target.entry, "--target=node", "--format=esm", "--outfile", outFile],
    { cwd: repoRoot, stdout: "inherit", stderr: "inherit" },
  );
  if (proc.exitCode === 0) {
    console.log(`[build-lambda] ${target.name}: bundled -> ${outFile}`);
  } else {
    console.error(`[build-lambda] ${target.name}: bundle FAILED (${target.entry})`);
    failed = true;
  }
}

if (failed) process.exit(1);
