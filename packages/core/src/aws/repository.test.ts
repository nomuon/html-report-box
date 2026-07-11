import { describe, expect, test } from "bun:test";
import type { ReportMeta } from "@hrb/shared";
import { DomainError } from "../errors.ts";
import { decodeKeyCursor } from "./cursor.ts";
import {
  DynamoReportRepository,
  GSI1_NAME,
  GSI1_PUBLISHED_PK,
  GSI2_NAME,
  FLAG_SK_PREFIX,
  SK_META,
  SK_TOKENS,
  SK_UPLOAD,
  itemToMeta,
  metaToItem,
  quotaPk,
  quotaSk,
  reportPk,
} from "./repository.ts";
import { FakeClient, conditionalCheckFailed } from "./test-support.ts";

const TABLE = "hrb-reports";

function sampleMeta(overrides: Partial<ReportMeta> = {}): ReportMeta {
  return {
    id: "abcdefghijklmnopqrstu",
    title: "Q2 sales report",
    description: "",
    ownerSub: "user-1",
    ownerName: "Alice",
    status: "private",
    kind: "html",
    version: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    findings: [],
    ...overrides,
  };
}

function repo(client: FakeClient, dailyUploadLimit?: number): DynamoReportRepository {
  return new DynamoReportRepository({
    client,
    tableName: TABLE,
    ...(dailyUploadLimit !== undefined ? { dailyUploadLimit } : {}),
    newSuffix: () => "sfx",
  });
}

describe("meta item mapping (pk/sk/GSI projections)", () => {
  test("published META carries sparse GSI1 + GSI2 keys", () => {
    const meta = sampleMeta({ status: "published" });
    const item = metaToItem(meta);
    expect(item.pk).toBe(`R#${meta.id}`);
    expect(item.sk).toBe(SK_META);
    expect(item.gsi1pk).toBe(GSI1_PUBLISHED_PK);
    expect(item.gsi1sk).toBe(meta.updatedAt);
    expect(item.gsi2pk).toBe(meta.ownerSub);
    expect(item.gsi2sk).toBe(meta.updatedAt);
  });

  test("non-published META omits GSI1 keys entirely (sparse index)", () => {
    for (const status of ["private", "rejected", "takedown"] as const) {
      const item = metaToItem(sampleMeta({ status }));
      expect("gsi1pk" in item).toBe(false);
      expect("gsi1sk" in item).toBe(false);
      expect(item.gsi2pk).toBe("user-1");
    }
  });

  test("undefined optionals are stripped (DynamoDB rejects undefined)", () => {
    const item = metaToItem(sampleMeta());
    expect("sha256" in item).toBe(false);
    expect("sizeBytes" in item).toBe(false);
    expect("verdict" in item).toBe(false);
  });

  test("itemToMeta round-trips and strips key attributes", () => {
    const meta = sampleMeta({ status: "published", sha256: "a".repeat(64), sizeBytes: 10 });
    const back = itemToMeta(metaToItem(meta));
    expect(back).toEqual(meta);
    expect("pk" in back).toBe(false);
    expect("gsi1pk" in back).toBe(false);
  });
});

describe("create / update", () => {
  test("create puts META with attribute_not_exists condition", async () => {
    const client = new FakeClient();
    await repo(client).create(sampleMeta());
    const [input] = client.inputsOf("PutCommand");
    expect(input.TableName).toBe(TABLE);
    expect(input.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(input.Item.pk).toBe(reportPk("abcdefghijklmnopqrstu"));
    expect(input.Item.sk).toBe(SK_META);
  });

  test("create maps conditional failure to conflict", async () => {
    const client = new FakeClient().on("PutCommand", () => {
      throw conditionalCheckFailed();
    });
    const err = await repo(client).create(sampleMeta()).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe("conflict");
  });

  test("update requires the item to exist and maps to not_found", async () => {
    const client = new FakeClient().on("PutCommand", () => {
      throw conditionalCheckFailed();
    });
    const err = await repo(client).update(sampleMeta()).catch((e) => e);
    expect((err as DomainError).code).toBe("not_found");
    const [input] = client.inputsOf("PutCommand");
    expect(input.ConditionExpression).toBe("attribute_exists(pk)");
  });
});

describe("get / getMany", () => {
  test("get returns null without an item, strips keys otherwise", async () => {
    const empty = new FakeClient();
    expect(await repo(empty).get("x")).toBeNull();

    const meta = sampleMeta({ status: "published" });
    const client = new FakeClient().on("GetCommand", () => ({ Item: metaToItem(meta) }));
    const got = await repo(client).get(meta.id);
    expect(got).toEqual(meta);
    const [input] = client.inputsOf("GetCommand");
    expect(input.Key).toEqual({ pk: reportPk(meta.id), sk: SK_META });
  });

  test("getMany chunks at 100 keys and skips the call for no ids", async () => {
    const client = new FakeClient().on("BatchGetCommand", () => ({ Responses: { [TABLE]: [] } }));
    const r = repo(client);
    expect((await r.getMany([])).size).toBe(0);
    expect(client.calls.length).toBe(0);

    const ids = Array.from({ length: 120 }, (_, i) => `id-${i}`);
    await r.getMany(ids);
    const inputs = client.inputsOf("BatchGetCommand");
    expect(inputs.length).toBe(2);
    expect(inputs[0].RequestItems[TABLE].Keys.length).toBe(100);
    expect(inputs[1].RequestItems[TABLE].Keys.length).toBe(20);
  });

  test("getMany retries UnprocessedKeys", async () => {
    const m1 = sampleMeta({ id: "id-one-aaaaaaaaaaaaaa" });
    const m2 = sampleMeta({ id: "id-two-aaaaaaaaaaaaaa" });
    let call = 0;
    const client = new FakeClient().on("BatchGetCommand", () => {
      call += 1;
      if (call === 1) {
        return {
          Responses: { [TABLE]: [metaToItem(m1)] },
          UnprocessedKeys: { [TABLE]: { Keys: [{ pk: reportPk(m2.id), sk: SK_META }] } },
        };
      }
      return { Responses: { [TABLE]: [metaToItem(m2)] } };
    });
    const out = await repo(client).getMany([m1.id, m2.id]);
    expect(out.size).toBe(2);
    expect(out.get(m2.id)?.id).toBe(m2.id);
    expect(client.inputsOf("BatchGetCommand").length).toBe(2);
  });
});

describe("lists", () => {
  test("listPublished queries GSI1 partition PUB, updatedAt descending", async () => {
    const meta = sampleMeta({ status: "published" });
    const lastKey = { pk: reportPk(meta.id), sk: SK_META, gsi1pk: "PUB", gsi1sk: meta.updatedAt };
    const client = new FakeClient().on("QueryCommand", () => ({
      Items: [metaToItem(meta)],
      LastEvaluatedKey: lastKey,
    }));
    const page = await repo(client).listPublished({ limit: 10 });
    const [input] = client.inputsOf("QueryCommand");
    expect(input.IndexName).toBe(GSI1_NAME);
    expect(input.KeyConditionExpression).toBe("gsi1pk = :pub");
    expect(input.ExpressionAttributeValues[":pub"]).toBe(GSI1_PUBLISHED_PK);
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(10);
    expect(page.items[0]).toEqual(meta);
    // Cursor round-trips to the ExclusiveStartKey of the next page.
    expect(decodeKeyCursor(page.nextCursor)).toEqual(lastKey);
    await repo(client).listPublished({ cursor: page.nextCursor! });
    expect(client.inputsOf("QueryCommand")[1].ExclusiveStartKey).toEqual(lastKey);
  });

  test("listByOwner queries GSI2 by ownerSub", async () => {
    const client = new FakeClient().on("QueryCommand", () => ({ Items: [] }));
    const page = await repo(client).listByOwner("user-9");
    const [input] = client.inputsOf("QueryCommand");
    expect(input.IndexName).toBe(GSI2_NAME);
    expect(input.ExpressionAttributeValues[":owner"]).toBe("user-9");
    expect(input.ScanIndexForward).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  test("listAll scans META items with optional status filter, sorted desc", async () => {
    const older = sampleMeta({ id: "older-aaaaaaaaaaaaaaa", updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = sampleMeta({ id: "newer-aaaaaaaaaaaaaaa", updatedAt: "2026-06-01T00:00:00.000Z" });
    const client = new FakeClient().on("ScanCommand", () => ({
      Items: [metaToItem(older), metaToItem(newer)],
    }));
    const page = await repo(client).listAll({ status: "private" });
    const [input] = client.inputsOf("ScanCommand");
    expect(input.FilterExpression).toBe("sk = :meta AND #status = :status");
    expect(input.ExpressionAttributeNames).toEqual({ "#status": "status" });
    expect(input.ExpressionAttributeValues).toEqual({
      ":meta": SK_META,
      ":status": "private",
    });
    expect(page.items.map((m) => m.id)).toEqual([newer.id, older.id]);

    await repo(client).listAll();
    expect(client.inputsOf("ScanCommand")[1].FilterExpression).toBe("sk = :meta");
  });
});

describe("tokens / pending upload", () => {
  test("document tokens live on the TOKENS item", async () => {
    const client = new FakeClient().on("GetCommand", () => ({
      Item: { pk: reportPk("x"), sk: SK_TOKENS, tokens: ["foo", "ba"] },
    }));
    const r = repo(client);
    expect(await r.getDocumentTokens("x")).toEqual(["foo", "ba"]);
    await r.putDocumentTokens("x", ["foo"]);
    const [put] = client.inputsOf("PutCommand");
    expect(put.Item).toEqual({ pk: reportPk("x"), sk: SK_TOKENS, tokens: ["foo"] });
    await r.putDocumentTokens("x", []);
    const [del] = client.inputsOf("DeleteCommand");
    expect(del.Key).toEqual({ pk: reportPk("x"), sk: SK_TOKENS });
  });

  test("pending upload pointer is a separate UPLOAD item (survives META puts)", async () => {
    const client = new FakeClient().on("GetCommand", () => ({
      Item: { pk: reportPk("x"), sk: SK_UPLOAD, stagingKey: "staging/x/k1" },
    }));
    const r = repo(client);
    await r.setPendingUpload("x", "staging/x/k1");
    const [put] = client.inputsOf("PutCommand");
    expect(put.Item).toEqual({ pk: reportPk("x"), sk: SK_UPLOAD, stagingKey: "staging/x/k1" });
    expect(await r.getPendingUpload("x")).toBe("staging/x/k1");
    await r.clearPendingUpload("x");
    expect(client.inputsOf("DeleteCommand")[0].Key).toEqual({ pk: reportPk("x"), sk: SK_UPLOAD });
  });
});

describe("daily upload quota (conditional counter)", () => {
  test("increments atomically with the limit in the condition expression", async () => {
    const client = new FakeClient().on("UpdateCommand", () => ({ Attributes: { cnt: 3 } }));
    const count = await repo(client).incrementDailyUploads("user-1", "2026-07-10");
    expect(count).toBe(3);
    const [input] = client.inputsOf("UpdateCommand");
    expect(input.Key).toEqual({ pk: quotaPk("user-1"), sk: quotaSk("2026-07-10") });
    expect(input.UpdateExpression).toContain("ADD #c :one");
    expect(input.ConditionExpression).toBe("attribute_not_exists(#c) OR #c < :limit");
    expect(input.ExpressionAttributeNames).toEqual({ "#c": "cnt" });
    expect(input.ExpressionAttributeValues[":limit"]).toBe(30); // DAILY_UPLOAD_LIMIT
    expect(input.ExpressionAttributeValues[":one"]).toBe(1);
    expect(typeof input.ExpressionAttributeValues[":ttl"]).toBe("number");
    expect(input.ReturnValues).toBe("ALL_NEW");
  });

  test("conditional failure means the cap was hit → returns limit+1", async () => {
    const client = new FakeClient().on("UpdateCommand", () => {
      throw conditionalCheckFailed();
    });
    expect(await repo(client, 5).incrementDailyUploads("user-1", "2026-07-10")).toBe(6);
    const [input] = client.inputsOf("UpdateCommand");
    expect(input.ExpressionAttributeValues[":limit"]).toBe(5);
  });
});

describe("delete / flags", () => {
  test("delete removes every item in the report partition", async () => {
    const pk = reportPk("gone");
    const client = new FakeClient().on("QueryCommand", () => ({
      Items: [
        { pk, sk: SK_META },
        { pk, sk: SK_TOKENS },
        { pk, sk: SK_UPLOAD },
        { pk, sk: `${FLAG_SK_PREFIX}2026-07-01T00:00:00.000Z#a` },
      ],
    }));
    await repo(client).delete("gone");
    const [query] = client.inputsOf("QueryCommand");
    expect(query.KeyConditionExpression).toBe("pk = :pk");
    expect(query.ExpressionAttributeValues[":pk"]).toBe(pk);
    const [batch] = client.inputsOf("BatchWriteCommand");
    const deletes = batch.RequestItems[TABLE];
    expect(deletes.length).toBe(4);
    expect(deletes.map((d: { DeleteRequest: { Key: { sk: string } } }) => d.DeleteRequest.Key.sk)).toEqual([
      SK_META,
      SK_TOKENS,
      SK_UPLOAD,
      `${FLAG_SK_PREFIX}2026-07-01T00:00:00.000Z#a`,
    ]);
  });

  test("addFlag writes a FLAG# item; listFlags queries the prefix", async () => {
    const client = new FakeClient().on("QueryCommand", () => ({
      Items: [
        {
          pk: reportPk("x"),
          sk: `${FLAG_SK_PREFIX}2026-07-01T00:00:00.000Z#sfx`,
          reason: "phishing",
          createdAt: "2026-07-01T00:00:00.000Z",
          sourceIp: "10.0.0.1",
        },
      ],
    }));
    const r = repo(client);
    await r.addFlag("x", { reason: "phishing", createdAt: "2026-07-01T00:00:00.000Z" });
    const [put] = client.inputsOf("PutCommand");
    expect(put.Item.sk).toBe(`${FLAG_SK_PREFIX}2026-07-01T00:00:00.000Z#sfx`);
    expect("sourceIp" in put.Item).toBe(false); // undefined stripped

    const flags = await r.listFlags("x");
    const [query] = client.inputsOf("QueryCommand");
    expect(query.KeyConditionExpression).toBe("pk = :pk AND begins_with(sk, :flag)");
    expect(query.ExpressionAttributeValues[":flag"]).toBe(FLAG_SK_PREFIX);
    expect(flags).toEqual([
      { reason: "phishing", createdAt: "2026-07-01T00:00:00.000Z", sourceIp: "10.0.0.1" },
    ]);
  });
});
