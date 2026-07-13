/**
 * DynamoApiKeyStore — ApiKeyStore backed by the hrb-reports table.
 *
 * Single-table layout (no GSI required):
 *   pk = "AK#<sha256hex>",  sk = "KEY"        hash → key record (verify path)
 *   pk = "AKO#<ownerSub>",  sk = "K#<keyId>"  owner → key metadata (list path;
 *                                             carries the hash so revoke can
 *                                             delete the AK# item)
 *
 * Only the sha256 hash of a key is persisted — never the plaintext.
 * Portable (Node 22 / Lambda); no Bun-only APIs.
 */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { ApiKey } from "@hrb/shared";
import { apiKeyDisplayPrefix, generateApiKeyPlaintext, hashApiKey } from "../api-keys.ts";
import { DomainError } from "../errors.ts";
import { generateId } from "../id.ts";
import type { ApiKeyOwner, ApiKeyStore, VerifiedApiKey } from "../ports.ts";
import type { CommandClient } from "./types.ts";

// ---- key helpers (exported for tests) ----

export const APIKEY_SK = "KEY";
export const APIKEY_OWNER_SK_PREFIX = "K#";

export function apiKeyHashPk(hash: string): string {
  return `AK#${hash}`;
}

export function apiKeyOwnerPk(ownerSub: string): string {
  return `AKO#${ownerSub}`;
}

interface ApiKeyAttributes {
  keyId: string;
  ownerSub: string;
  ownerName: string;
  name: string;
  prefix: string;
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
}

function toApiKey(item: ApiKeyAttributes): ApiKey {
  return {
    keyId: item.keyId,
    name: item.name,
    prefix: item.prefix,
    createdAt: item.createdAt,
    ...(item.lastUsedAt !== undefined ? { lastUsedAt: item.lastUsedAt } : {}),
  };
}

export interface DynamoApiKeyStoreOptions {
  client: CommandClient;
  tableName: string;
  now?: () => Date;
  newId?: () => string;
}

export class DynamoApiKeyStore implements ApiKeyStore {
  private readonly client: CommandClient;
  private readonly tableName: string;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: DynamoApiKeyStoreOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => generateId());
  }

  async issue(owner: ApiKeyOwner, name: string): Promise<{ key: ApiKey; plaintext: string }> {
    const plaintext = generateApiKeyPlaintext();
    const attrs: ApiKeyAttributes = {
      keyId: this.newId(),
      ownerSub: owner.sub,
      ownerName: owner.name,
      name,
      prefix: apiKeyDisplayPrefix(plaintext),
      hash: hashApiKey(plaintext),
      createdAt: this.now().toISOString(),
    };
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...attrs, pk: apiKeyHashPk(attrs.hash), sk: APIKEY_SK },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...attrs,
          pk: apiKeyOwnerPk(owner.sub),
          sk: `${APIKEY_OWNER_SK_PREFIX}${attrs.keyId}`,
        },
      }),
    );
    return { key: toApiKey(attrs), plaintext };
  }

  async list(ownerSub: string): Promise<ApiKey[]> {
    const keys: ApiKeyAttributes[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :k)",
          ExpressionAttributeValues: {
            ":pk": apiKeyOwnerPk(ownerSub),
            ":k": APIKEY_OWNER_SK_PREFIX,
          },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      for (const item of (res?.Items ?? []) as ApiKeyAttributes[]) keys.push(item);
      startKey = res?.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return keys
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.keyId.localeCompare(b.keyId))
      .map(toApiKey);
  }

  async revoke(ownerSub: string, keyId: string): Promise<void> {
    const ownerKey = { pk: apiKeyOwnerPk(ownerSub), sk: `${APIKEY_OWNER_SK_PREFIX}${keyId}` };
    const res = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: ownerKey }),
    );
    const item = res?.Item as ApiKeyAttributes | undefined;
    if (!item) throw new DomainError("not_found", "api key not found");
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: apiKeyHashPk(item.hash), sk: APIKEY_SK },
      }),
    );
    await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: ownerKey }));
  }

  async verify(plaintext: string): Promise<VerifiedApiKey | null> {
    const hash = hashApiKey(plaintext);
    const res = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: apiKeyHashPk(hash), sk: APIKEY_SK },
      }),
    );
    const item = res?.Item as ApiKeyAttributes | undefined;
    if (!item) return null;
    // lastUsedAt はベストエフォート更新（失敗しても認証結果には影響させない）。
    const lastUsedAt = this.now().toISOString();
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: apiKeyHashPk(hash), sk: APIKEY_SK },
          UpdateExpression: "SET lastUsedAt = :t",
          ExpressionAttributeValues: { ":t": lastUsedAt },
        }),
      );
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: apiKeyOwnerPk(item.ownerSub), sk: `${APIKEY_OWNER_SK_PREFIX}${item.keyId}` },
          UpdateExpression: "SET lastUsedAt = :t",
          ExpressionAttributeValues: { ":t": lastUsedAt },
        }),
      );
    } catch {
      // best effort
    }
    return { ownerSub: item.ownerSub, ownerName: item.ownerName, keyId: item.keyId };
  }
}
