/**
 * @hrb/api — Hono HTTP layer. `createApp(ctx)` builds the /api app;
 * ./lambda is the AWS entrypoint, src/local/server.ts the Bun dev server.
 * This entrypoint stays Node 22 portable; Bun-only APIs live under local/.
 */
export const PACKAGE_NAME = "@hrb/api";

export { createApp, FLAG_RATE_LIMIT, FLAG_RATE_WINDOW_MS } from "./app.ts";
export type { AppContext, AppType } from "./app.ts";
export { createMemoryRateLimiter } from "./rate-limit.ts";
export type { MemoryRateLimiterOptions, RateLimiter } from "./rate-limit.ts";
