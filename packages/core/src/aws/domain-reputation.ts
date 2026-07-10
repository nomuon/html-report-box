/**
 * S3DomainReputation — DomainReputation backed by the JSON blocklist the
 * daily feed Lambda writes to S3 (URLhaus + OpenPhish), cached in memory
 * with a TTL. Accepted document shapes: ["evil.example", ...] or
 * { "domains": ["evil.example", ...] }.
 *
 * Fetch failures keep the previous (possibly empty) set — the scanner rule
 * degrades to "no reputation data" instead of blocking uploads.
 *
 * Portable (Node 22 / Lambda); no Bun-only APIs.
 */
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { DomainReputation } from "../ports.ts";
import type { CommandClient } from "./types.ts";

export const DEFAULT_BLOCKLIST_TTL_MS = 15 * 60 * 1000;

export interface S3DomainReputationOptions {
  client: CommandClient;
  bucket: string;
  key: string;
  ttlMs?: number;
  /** Millisecond clock (injectable for TTL tests). */
  now?: () => number;
}

function parseHostList(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { domains?: unknown } | null)?.domains)
      ? ((parsed as { domains: unknown[] }).domains)
      : [];
  return list.filter((h): h is string => typeof h === "string");
}

export class S3DomainReputation implements DomainReputation {
  private readonly client: CommandClient;
  private readonly bucket: string;
  private readonly key: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private hosts = new Set<string>();
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | undefined;

  constructor(options: S3DomainReputationOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
    this.key = options.key;
    this.ttlMs = options.ttlMs ?? DEFAULT_BLOCKLIST_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async isMalicious(host: string): Promise<boolean> {
    await this.ensureFresh();
    return this.hosts.has(host.toLowerCase());
  }

  private async ensureFresh(): Promise<void> {
    if (this.now() - this.fetchedAt < this.ttlMs) return;
    this.inflight ??= this.reload().finally(() => {
      this.inflight = undefined;
    });
    await this.inflight;
  }

  private async reload(): Promise<void> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key }),
      );
      const body: unknown = res?.Body;
      let bytes: Uint8Array | null = null;
      if (body instanceof Uint8Array) {
        bytes = body;
      } else if (
        typeof (body as { transformToByteArray?: unknown } | null)?.transformToByteArray ===
        "function"
      ) {
        bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> })
          .transformToByteArray();
      }
      if (bytes) {
        this.hosts = new Set(parseHostList(new TextDecoder().decode(bytes)).map((h) => h.toLowerCase()));
      }
    } catch {
      // Feed missing / unreadable — keep the previous set until the next TTL window.
    }
    this.fetchedAt = this.now();
  }
}
