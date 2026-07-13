/**
 * Local ApiKeyStore — in-memory with JSON persistence under `${dataDir}/api-keys.json`.
 * Persists only the sha256 hash of each key (never the plaintext).
 * Local-only module.
 */
import { join } from "node:path";
import type { ApiKey } from "@hrb/shared";
import {
  apiKeyDisplayPrefix,
  generateApiKeyPlaintext,
  hashApiKey,
} from "../api-keys.ts";
import { DomainError } from "../errors.ts";
import { generateId } from "../id.ts";
import type { ApiKeyOwner, ApiKeyStore, VerifiedApiKey } from "../ports.ts";
import { JsonStore } from "./json-store.ts";

interface StoredApiKey {
  keyId: string;
  ownerSub: string;
  ownerName: string;
  name: string;
  prefix: string;
  /** Hex sha256 of the plaintext key. */
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface ApiKeysDb {
  /** keyId → record */
  keys: Record<string, StoredApiKey>;
}

function toApiKey(record: StoredApiKey): ApiKey {
  return {
    keyId: record.keyId,
    name: record.name,
    prefix: record.prefix,
    createdAt: record.createdAt,
    ...(record.lastUsedAt !== undefined ? { lastUsedAt: record.lastUsedAt } : {}),
  };
}

export class LocalApiKeyStore implements ApiKeyStore {
  private readonly store: JsonStore<ApiKeysDb>;
  private readonly now: () => Date;

  constructor(dataDir: string, options: { now?: () => Date } = {}) {
    this.store = new JsonStore<ApiKeysDb>(join(dataDir, "api-keys.json"), () => ({ keys: {} }));
    this.now = options.now ?? (() => new Date());
  }

  async issue(owner: ApiKeyOwner, name: string): Promise<{ key: ApiKey; plaintext: string }> {
    const plaintext = generateApiKeyPlaintext();
    const record: StoredApiKey = {
      keyId: generateId(),
      ownerSub: owner.sub,
      ownerName: owner.name,
      name,
      prefix: apiKeyDisplayPrefix(plaintext),
      hash: hashApiKey(plaintext),
      createdAt: this.now().toISOString(),
    };
    this.store.mutate((db) => {
      db.keys[record.keyId] = record;
    });
    return { key: toApiKey(record), plaintext };
  }

  async list(ownerSub: string): Promise<ApiKey[]> {
    return Object.values(this.store.get().keys)
      .filter((k) => k.ownerSub === ownerSub)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.keyId.localeCompare(b.keyId))
      .map(toApiKey);
  }

  async revoke(ownerSub: string, keyId: string): Promise<void> {
    this.store.mutate((db) => {
      const record = db.keys[keyId];
      if (!record || record.ownerSub !== ownerSub) {
        throw new DomainError("not_found", "api key not found");
      }
      delete db.keys[keyId];
    });
  }

  async verify(plaintext: string): Promise<VerifiedApiKey | null> {
    const hash = hashApiKey(plaintext);
    const record = Object.values(this.store.get().keys).find((k) => k.hash === hash);
    if (!record) return null;
    // lastUsedAt はベストエフォート更新（失敗しても認証結果には影響させない）。
    try {
      this.store.mutate((db) => {
        const stored = db.keys[record.keyId];
        if (stored) stored.lastUsedAt = this.now().toISOString();
      });
    } catch {
      // best effort
    }
    return { ownerSub: record.ownerSub, ownerName: record.ownerName, keyId: record.keyId };
  }
}
