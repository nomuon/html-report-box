import { describe, expect, test } from "bun:test";
import type { Posting } from "../ports.ts";
import { DynamoSearchIndex } from "./search-index.ts";
import { FakeClient } from "./test-support.ts";

const TABLE = "hrb-search";

function index(client: FakeClient): DynamoSearchIndex {
  return new DynamoSearchIndex({ client, tableName: TABLE });
}

describe("put / remove (posting key design)", () => {
  test("put writes pk=token, sk=reportId, {w,u} and chunks batches at 25", async () => {
    const client = new FakeClient();
    const postings: Posting[] = Array.from({ length: 30 }, (_, i) => ({
      token: `tok${i}`,
      weight: i + 1,
    }));
    await index(client).put("report-1", postings, "2026-07-10T00:00:00.000Z");

    const batches = client.inputsOf("BatchWriteCommand");
    expect(batches.length).toBe(2);
    expect(batches[0].RequestItems[TABLE].length).toBe(25);
    expect(batches[1].RequestItems[TABLE].length).toBe(5);
    expect(batches[0].RequestItems[TABLE][0].PutRequest.Item).toEqual({
      pk: "tok0",
      sk: "report-1",
      w: 1,
      u: "2026-07-10T00:00:00.000Z",
    });
  });

  test("put/remove with nothing to do issue no calls", async () => {
    const client = new FakeClient();
    await index(client).put("r", [], "2026-07-10T00:00:00.000Z");
    await index(client).remove("r", []);
    expect(client.calls.length).toBe(0);
  });

  test("remove deletes one posting per distinct token", async () => {
    const client = new FakeClient();
    await index(client).remove("report-1", ["foo", "bar", "foo"]);
    const [batch] = client.inputsOf("BatchWriteCommand");
    expect(batch.RequestItems[TABLE]).toEqual([
      { DeleteRequest: { Key: { pk: "foo", sk: "report-1" } } },
      { DeleteRequest: { Key: { pk: "bar", sk: "report-1" } } },
    ]);
  });
});

describe("query (token intersection / Σw aggregation)", () => {
  test("aggregates score, matchedTokens and max updatedAt across tokens", async () => {
    const client = new FakeClient().on("QueryCommand", (input) => {
      const token = input.ExpressionAttributeValues[":token"];
      if (token === "foo") {
        return {
          Items: [
            { pk: "foo", sk: "r1", w: 3, u: "2026-01-02T00:00:00.000Z" },
            { pk: "foo", sk: "r2", w: 1, u: "2026-01-01T00:00:00.000Z" },
          ],
        };
      }
      if (token === "bar") {
        // Paginated: page 1 → r1, page 2 → r3.
        if (!input.ExclusiveStartKey) {
          return {
            Items: [{ pk: "bar", sk: "r1", w: 5, u: "2026-01-03T00:00:00.000Z" }],
            LastEvaluatedKey: { pk: "bar", sk: "r1" },
          };
        }
        return { Items: [{ pk: "bar", sk: "r3", w: 2, u: "2026-01-01T00:00:00.000Z" }] };
      }
      return { Items: [] };
    });

    // Duplicate query token must not double-count.
    const hits = await index(client).query(["foo", "bar", "foo", "baz"]);
    const byId = new Map(hits.map((h) => [h.reportId, h]));

    expect(byId.get("r1")).toEqual({
      reportId: "r1",
      score: 8, // 3 + 5
      matchedTokens: 2,
      updatedAt: "2026-01-03T00:00:00.000Z", // max(u)
    });
    expect(byId.get("r2")).toEqual({
      reportId: "r2",
      score: 1,
      matchedTokens: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(byId.get("r3")?.score).toBe(2);
    expect(byId.size).toBe(3);

    // "foo" queried exactly once despite appearing twice; "bar" twice (pagination).
    const tokenCalls = client
      .inputsOf("QueryCommand")
      .map((i) => i.ExpressionAttributeValues[":token"]);
    expect(tokenCalls.filter((t) => t === "foo").length).toBe(1);
    expect(tokenCalls.filter((t) => t === "bar").length).toBe(2);
  });

  test("empty token list short-circuits", async () => {
    const client = new FakeClient();
    expect(await index(client).query([])).toEqual([]);
    expect(client.calls.length).toBe(0);
  });
});
