/**
 * DynamoReportRepository — ReportRepository backed by the hrb-reports table.
 *
 * Single-table layout (pk = "R#<id>" unless noted):
 *   sk = "META"          report metadata (+ GSI projections, see below)
 *   sk = "TOKENS"        list of tokens registered in the search index
 *   sk = "UPLOAD"        staging key of the latest issued presigned upload
 *   sk = "FLAG#<ts>#<n>" abuse flags
 *   pk = "Q#<ownerSub>", sk = "D#<YYYY-MM-DD>"  daily upload quota counter
 *
 * GSI1 (sparse, published list): gsi1pk = "PUB",     gsi1sk = updatedAt
 * GSI2 (per-owner list):         gsi2pk = ownerSub,  gsi2sk = updatedAt
 *
 * Portable (Node 22 / Lambda); no Bun-only APIs.
 */
import { randomUUID } from "node:crypto";
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { DAILY_UPLOAD_LIMIT } from "@hrb/shared";
import type { ReportMeta, ReportStatus } from "@hrb/shared";
import { DomainError } from "../errors.ts";
import type { Page, PageOptions, PublishedListOptions, ReportFlag, ReportRepository } from "../ports.ts";
import { decodeKeyCursor, encodeKeyCursor } from "./cursor.ts";
import { batchWriteAll, chunk, isConditionalCheckFailed } from "./dynamo-util.ts";
import type { WriteRequest } from "./dynamo-util.ts";
import type { CommandClient } from "./types.ts";

// ---- key helpers (exported for tests) ----

export const SK_META = "META";
export const SK_TOKENS = "TOKENS";
export const SK_UPLOAD = "UPLOAD";
export const FLAG_SK_PREFIX = "FLAG#";
/** Fixed GSI1 partition: only published META items carry it (sparse index). */
export const GSI1_PUBLISHED_PK = "PUB";
export const GSI1_NAME = "GSI1";
export const GSI2_NAME = "GSI2";

export function reportPk(id: string): string {
  return `R#${id}`;
}

export function quotaPk(ownerSub: string): string {
  return `Q#${ownerSub}`;
}

export function quotaSk(dateKey: string): string {
  return `D#${dateKey}`;
}

const DEFAULT_PAGE_LIMIT = 50;
const BATCH_GET_CHUNK = 100;
const MAX_BATCH_GET_ATTEMPTS = 5;
/** Quota counter items are swept by DynamoDB TTL this long after their day. */
const QUOTA_TTL_SECONDS = 3 * 24 * 60 * 60;

const KEY_ATTRIBUTES = ["pk", "sk", "gsi1pk", "gsi1sk", "gsi2pk", "gsi2sk"] as const;

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** META item for a report: meta attributes + table/GSI keys. */
export function metaToItem(meta: ReportMeta): Record<string, unknown> {
  return {
    ...stripUndefined(meta),
    pk: reportPk(meta.id),
    sk: SK_META,
    // GSI1 is sparse: only published reports appear in the public list.
    ...(meta.status === "published"
      ? { gsi1pk: GSI1_PUBLISHED_PK, gsi1sk: meta.updatedAt }
      : {}),
    gsi2pk: meta.ownerSub,
    gsi2sk: meta.updatedAt,
  };
}

export function itemToMeta(item: Record<string, unknown>): ReportMeta {
  const copy: Record<string, unknown> = { ...item };
  for (const attr of KEY_ATTRIBUTES) delete copy[attr];
  return copy as unknown as ReportMeta;
}

export interface DynamoReportRepositoryOptions {
  client: CommandClient;
  tableName: string;
  /** Enforced in the quota counter's condition expression. */
  dailyUploadLimit?: number;
  /** Flag sort-key uniqueness suffix (injectable for tests). */
  newSuffix?: () => string;
}

export class DynamoReportRepository implements ReportRepository {
  private readonly client: CommandClient;
  private readonly tableName: string;
  private readonly dailyUploadLimit: number;
  private readonly newSuffix: () => string;

  constructor(options: DynamoReportRepositoryOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
    this.dailyUploadLimit = options.dailyUploadLimit ?? DAILY_UPLOAD_LIMIT;
    this.newSuffix = options.newSuffix ?? (() => randomUUID());
  }

  // ---- META ----

  async create(meta: ReportMeta): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: metaToItem(meta),
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        throw new DomainError("conflict", `report ${meta.id} already exists`);
      }
      throw err;
    }
  }

  async get(id: string): Promise<ReportMeta | null> {
    const res = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: reportPk(id), sk: SK_META },
      }),
    );
    const item = res?.Item as Record<string, unknown> | undefined;
    return item ? itemToMeta(item) : null;
  }

  async getMany(ids: readonly string[]): Promise<Map<string, ReportMeta>> {
    const out = new Map<string, ReportMeta>();
    const distinct = [...new Set(ids)];
    if (distinct.length === 0) return out;

    for (const idChunk of chunk(distinct, BATCH_GET_CHUNK)) {
      let keys: Array<Record<string, unknown>> = idChunk.map((id) => ({
        pk: reportPk(id),
        sk: SK_META,
      }));
      let attempts = 0;
      while (keys.length > 0) {
        if (attempts >= MAX_BATCH_GET_ATTEMPTS) {
          throw new DomainError("internal", `dynamodb batch get did not converge for ${this.tableName}`);
        }
        attempts += 1;
        const res = await this.client.send(
          new BatchGetCommand({
            RequestItems: { [this.tableName]: { Keys: keys } },
          }),
        );
        const items = (res?.Responses?.[this.tableName] ?? []) as Array<Record<string, unknown>>;
        for (const item of items) {
          const meta = itemToMeta(item);
          out.set(meta.id, meta);
        }
        const unprocessed = res?.UnprocessedKeys?.[this.tableName]?.Keys;
        keys = Array.isArray(unprocessed) ? (unprocessed as Array<Record<string, unknown>>) : [];
      }
    }
    return out;
  }

  async update(meta: ReportMeta): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: metaToItem(meta),
          ConditionExpression: "attribute_exists(pk)",
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        throw new DomainError("not_found", `report ${meta.id} does not exist`);
      }
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    // Collect every item under the report partition (META, TOKENS, UPLOAD,
    // FLAG#...) and batch-delete them.
    const requests: WriteRequest[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": reportPk(id) },
          ProjectionExpression: "pk, sk",
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      for (const item of (res?.Items ?? []) as Array<Record<string, unknown>>) {
        requests.push({ DeleteRequest: { Key: { pk: item.pk, sk: item.sk } } });
      }
      startKey = res?.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    if (requests.length > 0) {
      await batchWriteAll(this.client, this.tableName, requests);
    }
  }

  // ---- Lists ----

  /**
   * GSI1 is keyed on updatedAt, so `order` maps directly to ScanIndexForward.
   * `kind` is not part of any index key — it is applied as a FilterExpression,
   * and DynamoDB evaluates Limit BEFORE the filter, so a filtered page may
   * come back short (even empty) while nextCursor still advances. Callers
   * simply keep paging; the filter itself is exact.
   */
  async listPublished(opts?: PublishedListOptions): Promise<Page<ReportMeta>> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI1_NAME,
        KeyConditionExpression: "gsi1pk = :pub",
        ...(opts?.kind ? { FilterExpression: "#kind = :kind" } : {}),
        ...(opts?.kind ? { ExpressionAttributeNames: { "#kind": "kind" } } : {}),
        ExpressionAttributeValues: {
          ":pub": GSI1_PUBLISHED_PK,
          ...(opts?.kind ? { ":kind": opts.kind } : {}),
        },
        ScanIndexForward: opts?.order === "asc", // updatedAt descending by default
        Limit: opts?.limit ?? DEFAULT_PAGE_LIMIT,
        ...(opts?.cursor ? { ExclusiveStartKey: decodeKeyCursor(opts.cursor) } : {}),
      }),
    );
    return this.toPage(res);
  }

  async listByOwner(ownerSub: string, opts?: PageOptions): Promise<Page<ReportMeta>> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI2_NAME,
        KeyConditionExpression: "gsi2pk = :owner",
        ExpressionAttributeValues: { ":owner": ownerSub },
        ScanIndexForward: false,
        Limit: opts?.limit ?? DEFAULT_PAGE_LIMIT,
        ...(opts?.cursor ? { ExclusiveStartKey: decodeKeyCursor(opts.cursor) } : {}),
      }),
    );
    return this.toPage(res);
  }

  /**
   * Admin listing spans every status, which no GSI covers — a filtered Scan
   * is acceptable at admin volumes. Items are sorted within each page
   * (updatedAt desc); cross-page global ordering is not guaranteed.
   */
  async listAll(opts?: PageOptions & { status?: ReportStatus }): Promise<Page<ReportMeta>> {
    const filter = opts?.status ? "sk = :meta AND #status = :status" : "sk = :meta";
    const res = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: filter,
        ExpressionAttributeValues: {
          ":meta": SK_META,
          ...(opts?.status ? { ":status": opts.status } : {}),
        },
        ...(opts?.status ? { ExpressionAttributeNames: { "#status": "status" } } : {}),
        Limit: opts?.limit ?? DEFAULT_PAGE_LIMIT,
        ...(opts?.cursor ? { ExclusiveStartKey: decodeKeyCursor(opts.cursor) } : {}),
      }),
    );
    const page = this.toPage(res);
    page.items.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
    return page;
  }

  private toPage(res: {
    Items?: unknown[];
    LastEvaluatedKey?: Record<string, unknown>;
  }): Page<ReportMeta> {
    const items = ((res?.Items ?? []) as Array<Record<string, unknown>>).map(itemToMeta);
    const nextCursor = encodeKeyCursor(res?.LastEvaluatedKey);
    return nextCursor ? { items, nextCursor } : { items };
  }

  // ---- TOKENS ----

  async getDocumentTokens(id: string): Promise<string[]> {
    const res = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: reportPk(id), sk: SK_TOKENS },
      }),
    );
    const tokens = (res?.Item as { tokens?: unknown } | undefined)?.tokens;
    return Array.isArray(tokens) ? (tokens as string[]) : [];
  }

  async putDocumentTokens(id: string, tokens: readonly string[]): Promise<void> {
    if (tokens.length === 0) {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: reportPk(id), sk: SK_TOKENS },
        }),
      );
      return;
    }
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { pk: reportPk(id), sk: SK_TOKENS, tokens: [...tokens] },
      }),
    );
  }

  // ---- Pending upload pointer ----

  async setPendingUpload(id: string, stagingKey: string): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { pk: reportPk(id), sk: SK_UPLOAD, stagingKey },
      }),
    );
  }

  async getPendingUpload(id: string): Promise<string | null> {
    const res = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: reportPk(id), sk: SK_UPLOAD },
      }),
    );
    const key = (res?.Item as { stagingKey?: unknown } | undefined)?.stagingKey;
    return typeof key === "string" ? key : null;
  }

  async clearPendingUpload(id: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: reportPk(id), sk: SK_UPLOAD },
      }),
    );
  }

  // ---- Daily upload quota ----

  /**
   * Atomic counter with a condition expression capping the count at the
   * daily limit — a concurrent burst can never exceed it. When the condition
   * fails the caller sees `limit + 1`, which ReportService maps to
   * rate_limited.
   */
  async incrementDailyUploads(ownerSub: string, dateKey: string): Promise<number> {
    const expiresAt = Math.floor(Date.parse(`${dateKey}T00:00:00Z`) / 1000) + QUOTA_TTL_SECONDS;
    try {
      const res = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: quotaPk(ownerSub), sk: quotaSk(dateKey) },
          UpdateExpression: "SET expiresAt = if_not_exists(expiresAt, :ttl) ADD #c :one",
          ConditionExpression: "attribute_not_exists(#c) OR #c < :limit",
          ExpressionAttributeNames: { "#c": "cnt" },
          ExpressionAttributeValues: {
            ":one": 1,
            ":ttl": expiresAt,
            ":limit": this.dailyUploadLimit,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      const cnt = (res?.Attributes as { cnt?: unknown } | undefined)?.cnt;
      return typeof cnt === "number" ? cnt : this.dailyUploadLimit + 1;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return this.dailyUploadLimit + 1;
      throw err;
    }
  }

  async getDailyUploads(ownerSub: string, dateKey: string): Promise<number> {
    const res = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: quotaPk(ownerSub), sk: quotaSk(dateKey) },
      }),
    );
    const cnt = (res?.Item as { cnt?: unknown } | undefined)?.cnt;
    return typeof cnt === "number" ? cnt : 0;
  }

  // ---- Abuse flags ----

  async addFlag(id: string, flag: ReportFlag): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: reportPk(id),
          sk: `${FLAG_SK_PREFIX}${flag.createdAt}#${this.newSuffix()}`,
          ...stripUndefined({ ...flag }),
        },
      }),
    );
  }

  async listFlags(id: string): Promise<ReportFlag[]> {
    const flags: ReportFlag[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :flag)",
          ExpressionAttributeValues: { ":pk": reportPk(id), ":flag": FLAG_SK_PREFIX },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      for (const item of (res?.Items ?? []) as Array<Record<string, unknown>>) {
        const { pk: _pk, sk: _sk, ...rest } = item;
        flags.push(rest as unknown as ReportFlag);
      }
      startKey = res?.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return flags;
  }

  /**
   * Flag items live under their report partition, which no GSI covers — a
   * filtered Scan is acceptable at admin volumes (flags are rare).
   */
  async listFlagged(): Promise<Array<{ id: string; flags: ReportFlag[] }>> {
    const byId = new Map<string, ReportFlag[]>();
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: "begins_with(sk, :flag)",
          ExpressionAttributeValues: { ":flag": FLAG_SK_PREFIX },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      for (const item of (res?.Items ?? []) as Array<Record<string, unknown>>) {
        const { pk, sk: _sk, ...rest } = item;
        const id = String(pk).slice("R#".length);
        const list = byId.get(id) ?? [];
        list.push(rest as unknown as ReportFlag);
        byId.set(id, list);
      }
      startKey = res?.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return [...byId.entries()].map(([id, flags]) => ({ id, flags }));
  }

  async clearFlags(id: string): Promise<void> {
    const requests: WriteRequest[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :flag)",
          ExpressionAttributeValues: { ":pk": reportPk(id), ":flag": FLAG_SK_PREFIX },
          ProjectionExpression: "pk, sk",
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      for (const item of (res?.Items ?? []) as Array<Record<string, unknown>>) {
        requests.push({ DeleteRequest: { Key: { pk: item.pk, sk: item.sk } } });
      }
      startKey = res?.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    if (requests.length > 0) {
      await batchWriteAll(this.client, this.tableName, requests);
    }
  }
}
