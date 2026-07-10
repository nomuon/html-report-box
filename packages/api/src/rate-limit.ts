/**
 * Minimal fixed-window in-memory rate limiter for the unauthenticated
 * flag endpoint. Per-instance state is acceptable: in AWS each Lambda
 * container keeps its own window (WAF rate rules are the real backstop),
 * and in local dev a single process runs.
 * Portable (Node 22); no Bun-only APIs.
 */

export interface RateLimiter {
  /** Returns true when the caller identified by `key` may proceed. */
  allow(key: string): boolean;
}

export interface MemoryRateLimiterOptions {
  /** Max allowed calls per key within one window. */
  limit: number;
  windowMs: number;
  /** Clock override for tests (ms since epoch). */
  now?: () => number;
}

const PRUNE_THRESHOLD = 10_000;

export function createMemoryRateLimiter(opts: MemoryRateLimiterOptions): RateLimiter {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    allow(key: string): boolean {
      const t = now();
      if (buckets.size > PRUNE_THRESHOLD) {
        for (const [k, b] of buckets) {
          if (b.resetAt <= t) buckets.delete(k);
        }
      }
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= t) {
        buckets.set(key, { count: 1, resetAt: t + opts.windowMs });
        return true;
      }
      if (bucket.count >= opts.limit) return false;
      bucket.count += 1;
      return true;
    },
  };
}
