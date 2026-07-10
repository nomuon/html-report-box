/**
 * CloudFrontInvalidator — CdnInvalidator over CreateInvalidation for the
 * content distribution (Distribution B, /r/*).
 *
 * The distribution id is created in HrbCdnStack after the app stack, so it
 * can be provided either statically or through a lazy resolver (e.g. the SSM
 * parameter written at deploy time). While unresolved, invalidation is a
 * best-effort no-op — content correctness never depends on it.
 *
 * Portable (Node 22 / Lambda); no Bun-only APIs.
 */
import { CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import type { CdnInvalidator } from "../ports.ts";
import type { CommandClient } from "./types.ts";

export interface CloudFrontInvalidatorOptions {
  client: CommandClient;
  /** Static distribution id (takes precedence over the resolver). */
  distributionId?: string;
  /** Lazy id lookup; the first non-empty result is cached. */
  resolveDistributionId?: () => Promise<string | undefined>;
  now?: () => Date;
}

export class CloudFrontInvalidator implements CdnInvalidator {
  private readonly client: CommandClient;
  private readonly resolveDistributionId: (() => Promise<string | undefined>) | undefined;
  private readonly now: () => Date;
  private cachedId: string | undefined;
  private sequence = 0;

  constructor(options: CloudFrontInvalidatorOptions) {
    this.client = options.client;
    this.cachedId = options.distributionId;
    this.resolveDistributionId = options.resolveDistributionId;
    this.now = options.now ?? (() => new Date());
  }

  async invalidate(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    const id = await this.distributionId();
    if (!id) return; // distribution not yet resolvable — skip (best effort)
    this.sequence += 1;
    await this.client.send(
      new CreateInvalidationCommand({
        DistributionId: id,
        InvalidationBatch: {
          CallerReference: `hrb-${this.now().getTime()}-${this.sequence}`,
          Paths: { Quantity: paths.length, Items: [...paths] },
        },
      }),
    );
  }

  private async distributionId(): Promise<string | undefined> {
    if (this.cachedId) return this.cachedId;
    if (!this.resolveDistributionId) return undefined;
    try {
      const id = await this.resolveDistributionId();
      if (id) this.cachedId = id;
      return this.cachedId;
    } catch {
      return undefined; // resolver failure — invalidation stays best-effort
    }
  }
}
