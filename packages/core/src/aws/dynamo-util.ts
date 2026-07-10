/**
 * DynamoDB batch helpers shared by the repository and search index adapters.
 * Portable (Node 22 / Lambda).
 */
import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { DomainError } from "../errors.ts";
import type { CommandClient } from "./types.ts";

export const BATCH_WRITE_CHUNK = 25;
const MAX_BATCH_ATTEMPTS = 5;

export type WriteRequest =
  | { PutRequest: { Item: Record<string, unknown> } }
  | { DeleteRequest: { Key: Record<string, unknown> } };

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * BatchWrite all requests in chunks of 25, retrying UnprocessedItems up to
 * MAX_BATCH_ATTEMPTS before giving up with an internal error.
 */
export async function batchWriteAll(
  client: CommandClient,
  tableName: string,
  requests: readonly WriteRequest[],
): Promise<void> {
  for (const batch of chunk(requests, BATCH_WRITE_CHUNK)) {
    let pending: WriteRequest[] = batch;
    let attempts = 0;
    while (pending.length > 0) {
      if (attempts >= MAX_BATCH_ATTEMPTS) {
        throw new DomainError("internal", `dynamodb batch write did not converge for ${tableName}`);
      }
      attempts += 1;
      const response = await client.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: pending } }),
      );
      const unprocessed = response?.UnprocessedItems?.[tableName];
      pending = Array.isArray(unprocessed) ? (unprocessed as WriteRequest[]) : [];
    }
  }
}

export function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ConditionalCheckFailedException"
  );
}
