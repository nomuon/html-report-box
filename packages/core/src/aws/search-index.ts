/**
 * DynamoSearchIndex — inverted index on the hrb-search table.
 * Item shape: pk = token, sk = reportId, w = weight, u = updatedAt.
 * Query: fetch each distinct token's postings and aggregate per reportId
 * (score = Σw, matchedTokens = distinct matched query tokens, u = max).
 * Portable (Node 22 / Lambda); no Bun-only APIs.
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Posting, SearchHit, SearchIndex } from "../ports.ts";
import { batchWriteAll } from "./dynamo-util.ts";
import type { WriteRequest } from "./dynamo-util.ts";
import type { CommandClient } from "./types.ts";

interface PostingItem {
  pk: string;
  sk: string;
  w: number;
  u: string;
}

export interface DynamoSearchIndexOptions {
  client: CommandClient;
  tableName: string;
}

export class DynamoSearchIndex implements SearchIndex {
  private readonly client: CommandClient;
  private readonly tableName: string;

  constructor(options: DynamoSearchIndexOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
  }

  async put(reportId: string, postings: readonly Posting[], updatedAt: string): Promise<void> {
    if (postings.length === 0) return;
    const requests: WriteRequest[] = postings.map((posting) => ({
      PutRequest: {
        Item: {
          pk: posting.token,
          sk: reportId,
          w: posting.weight,
          u: updatedAt,
        } satisfies PostingItem,
      },
    }));
    await batchWriteAll(this.client, this.tableName, requests);
  }

  async remove(reportId: string, tokens: readonly string[]): Promise<void> {
    const distinct = [...new Set(tokens)];
    if (distinct.length === 0) return;
    const requests: WriteRequest[] = distinct.map((token) => ({
      DeleteRequest: { Key: { pk: token, sk: reportId } },
    }));
    await batchWriteAll(this.client, this.tableName, requests);
  }

  async query(tokens: readonly string[]): Promise<SearchHit[]> {
    const distinct = [...new Set(tokens)];
    if (distinct.length === 0) return [];

    const hits = new Map<string, SearchHit>();
    await Promise.all(
      distinct.map(async (token) => {
        for await (const item of this.postingsFor(token)) {
          const existing = hits.get(item.sk);
          if (existing) {
            existing.score += item.w;
            existing.matchedTokens += 1;
            if (item.u > existing.updatedAt) existing.updatedAt = item.u;
          } else {
            hits.set(item.sk, {
              reportId: item.sk,
              score: item.w,
              matchedTokens: 1,
              updatedAt: item.u,
            });
          }
        }
      }),
    );
    return [...hits.values()];
  }

  private async *postingsFor(token: string): AsyncGenerator<PostingItem> {
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :token",
          ExpressionAttributeValues: { ":token": token },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      for (const raw of (res?.Items ?? []) as Array<Record<string, unknown>>) {
        if (typeof raw.sk !== "string" || typeof raw.w !== "number") continue;
        yield {
          pk: token,
          sk: raw.sk,
          w: raw.w,
          u: typeof raw.u === "string" ? raw.u : "",
        };
      }
      startKey = res?.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
  }
}
