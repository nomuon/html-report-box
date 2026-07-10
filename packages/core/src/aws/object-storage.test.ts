import { describe, expect, test } from "bun:test";
import { S3ObjectStorage } from "./object-storage.ts";
import type { PresignPostParams } from "./object-storage.ts";
import { FakeClient, namedError } from "./test-support.ts";

const STAGING = "hrb-staging";
const CONTENT = "hrb-content";

function storage(client: FakeClient, presigned: PresignPostParams[] = []): S3ObjectStorage {
  return new S3ObjectStorage({
    client,
    stagingBucket: STAGING,
    contentBucket: CONTENT,
    presignPost: async (params) => {
      presigned.push(params);
      return { url: `https://${params.Bucket}.s3.example/`, fields: { key: params.Key, policy: "p" } };
    },
  });
}

describe("presigned POST", () => {
  test("enforces content-length-range against the staging bucket", async () => {
    const captured: PresignPostParams[] = [];
    const upload = await storage(new FakeClient(), captured).createPresignedUpload({
      key: "staging/r1/u1",
      maxSizeBytes: 5 * 1024 * 1024,
      expiresInSeconds: 600,
    });

    expect(captured.length).toBe(1);
    const params = captured[0]!;
    expect(params.Bucket).toBe(STAGING);
    expect(params.Key).toBe("staging/r1/u1");
    expect(params.Expires).toBe(600);
    expect(params.Conditions).toContainEqual(["content-length-range", 1, 5 * 1024 * 1024]);

    expect(upload).toEqual({
      url: `https://${STAGING}.s3.example/`,
      fields: { key: "staging/r1/u1", policy: "p" },
      key: "staging/r1/u1",
      expiresInSeconds: 600,
      maxSizeBytes: 5 * 1024 * 1024,
    });
  });

  test("defaults expiry to 900 seconds", async () => {
    const captured: PresignPostParams[] = [];
    const upload = await storage(new FakeClient(), captured).createPresignedUpload({
      key: "staging/r1/u2",
      maxSizeBytes: 100,
    });
    expect(captured[0]!.Expires).toBe(900);
    expect(upload.expiresInSeconds).toBe(900);
  });
});

describe("get / put / delete objects", () => {
  test("getStagingObject reads the staging bucket via transformToByteArray", async () => {
    const data = new TextEncoder().encode("<html></html>");
    const client = new FakeClient().on("GetObjectCommand", () => ({
      Body: { transformToByteArray: async () => data },
    }));
    const got = await storage(client).getStagingObject("staging/r1/u1");
    expect(got).toEqual(data);
    const [input] = client.inputsOf("GetObjectCommand");
    expect(input).toEqual({ Bucket: STAGING, Key: "staging/r1/u1" });
  });

  test("missing objects (NoSuchKey / 404) return null", async () => {
    const noSuchKey = new FakeClient().on("GetObjectCommand", () => {
      throw namedError("NoSuchKey");
    });
    expect(await storage(noSuchKey).getStagingObject("staging/x")).toBeNull();

    const status404 = new FakeClient().on("GetObjectCommand", () => {
      throw Object.assign(new Error("nope"), { $metadata: { httpStatusCode: 404 } });
    });
    expect(await storage(status404).getContentObject("reports/x/index.html")).toBeNull();

    const boom = new FakeClient().on("GetObjectCommand", () => {
      throw namedError("AccessDenied");
    });
    await expect(storage(boom).getContentObject("reports/x/index.html")).rejects.toThrow();
  });

  test("putContentObject writes to the content bucket with the content type", async () => {
    const client = new FakeClient();
    const data = new TextEncoder().encode("body { color: red }");
    await storage(client).putContentObject("reports/r1/assets/app.css", data, "text/css; charset=utf-8");
    const [input] = client.inputsOf("PutObjectCommand");
    expect(input.Bucket).toBe(CONTENT);
    expect(input.Key).toBe("reports/r1/assets/app.css");
    expect(input.ContentType).toBe("text/css; charset=utf-8");
    expect(input.Body).toEqual(data);
  });

  test("deleteStagingObject targets the staging bucket", async () => {
    const client = new FakeClient();
    await storage(client).deleteStagingObject("staging/r1/u1");
    expect(client.inputsOf("DeleteObjectCommand")[0]).toEqual({
      Bucket: STAGING,
      Key: "staging/r1/u1",
    });
  });
});

describe("deleteContentPrefix", () => {
  test("lists all pages under the prefix and batch-deletes every key", async () => {
    const client = new FakeClient().on("ListObjectsV2Command", (input) => {
      if (!input.ContinuationToken) {
        return {
          Contents: [{ Key: "reports/r1/index.html" }, { Key: "reports/r1/.extracted.txt" }],
          NextContinuationToken: "page2",
        };
      }
      return { Contents: [{ Key: "reports/r1/assets/app.css" }] };
    });
    await storage(client).deleteContentPrefix("reports/r1/");

    const lists = client.inputsOf("ListObjectsV2Command");
    expect(lists.length).toBe(2);
    expect(lists[0]).toMatchObject({ Bucket: CONTENT, Prefix: "reports/r1/" });
    expect(lists[1].ContinuationToken).toBe("page2");

    const deletes = client.inputsOf("DeleteObjectsCommand");
    expect(deletes.length).toBe(2);
    expect(deletes[0].Delete.Objects).toEqual([
      { Key: "reports/r1/index.html" },
      { Key: "reports/r1/.extracted.txt" },
    ]);
    expect(deletes[1].Delete.Objects).toEqual([{ Key: "reports/r1/assets/app.css" }]);
    expect(deletes[0].Bucket).toBe(CONTENT);
  });

  test("empty prefix listing deletes nothing", async () => {
    const client = new FakeClient().on("ListObjectsV2Command", () => ({ Contents: [] }));
    await storage(client).deleteContentPrefix("reports/none/");
    expect(client.inputsOf("DeleteObjectsCommand").length).toBe(0);
  });
});
