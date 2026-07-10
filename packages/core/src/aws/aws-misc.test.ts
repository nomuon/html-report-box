import { describe, expect, test } from "bun:test";
import { DomainError } from "../errors.ts";
import { ReportService } from "../report-service.ts";
import { CognitoAuthVerifier, regionFromUserPoolId } from "./auth.ts";
import type { CognitoIdTokenPayload } from "./auth.ts";
import { CloudFrontInvalidator } from "./cdn.ts";
import { createAwsContext, UnconfiguredScanner } from "./context.ts";
import type { AwsEnv } from "./context.ts";
import { S3DomainReputation } from "./domain-reputation.ts";
import { FakeClient, namedError } from "./test-support.ts";
import { CognitoUserAdmin } from "./user-admin.ts";

// =====================
// CognitoAuthVerifier
// =====================

function verifier(payloads: Record<string, CognitoIdTokenPayload>): CognitoAuthVerifier {
  return new CognitoAuthVerifier({
    userPoolId: "ap-northeast-1_TestPool",
    clientId: "client-1",
    domain: "https://hrb.auth.ap-northeast-1.amazoncognito.com",
    verifier: {
      verify: async (token) => {
        const payload = payloads[token];
        if (!payload) throw new Error("invalid token");
        return payload;
      },
    },
  });
}

describe("CognitoAuthVerifier", () => {
  test("derives the region from the user pool id", () => {
    expect(regionFromUserPoolId("ap-northeast-1_AbC123")).toBe("ap-northeast-1");
    expect(() => regionFromUserPoolId("nounderscore")).toThrow(DomainError);
  });

  test("verifies a Bearer ID token and maps the admin group", async () => {
    const v = verifier({
      "jwt-admin": { sub: "sub-1", name: "Alice", "cognito:groups": ["admin", "dev"] },
      "jwt-user": { sub: "sub-2", email: "bob@example.com", "cognito:groups": ["dev"] },
      "jwt-bare": { sub: "sub-3" },
    });
    expect(await v.verify({ authorization: "Bearer jwt-admin" })).toEqual({
      sub: "sub-1",
      name: "Alice",
      isAdmin: true,
    });
    // name falls back to email, then sub; non-admin groups don't grant admin.
    expect(await v.verify({ authorization: "Bearer jwt-user" })).toEqual({
      sub: "sub-2",
      name: "bob@example.com",
      isAdmin: false,
    });
    expect(await v.verify({ authorization: "bearer jwt-bare" })).toEqual({
      sub: "sub-3",
      name: "sub-3",
      isAdmin: false,
    });
  });

  test("missing / malformed / invalid credentials yield null (not an error)", async () => {
    const v = verifier({});
    expect(await v.verify({})).toBeNull();
    expect(await v.verify({ authorization: "Basic abc" })).toBeNull();
    expect(await v.verify({ authorization: "Bearer nope" })).toBeNull();
  });

  test("authConfig exposes the cognito bootstrap info", () => {
    expect(verifier({}).authConfig()).toEqual({
      mode: "cognito",
      region: "ap-northeast-1",
      userPoolId: "ap-northeast-1_TestPool",
      clientId: "client-1",
      domain: "https://hrb.auth.ap-northeast-1.amazoncognito.com",
    });
  });
});

// =====================
// CognitoUserAdmin
// =====================

describe("CognitoUserAdmin", () => {
  test("listUsers maps attributes and resolves admin membership per user", async () => {
    const client = new FakeClient()
      .on("ListUsersCommand", () => ({
        Users: [
          {
            Username: "alice",
            Attributes: [
              { Name: "name", Value: "Alice" },
              { Name: "email", Value: "alice@example.com" },
            ],
          },
          { Username: "bob", Attributes: [{ Name: "email", Value: "bob@example.com" }] },
        ],
        PaginationToken: "next-token",
      }))
      .on("AdminListGroupsForUserCommand", (input) => ({
        Groups: input.Username === "alice" ? [{ GroupName: "admin" }] : [],
      }));

    const admin = new CognitoUserAdmin({ client, userPoolId: "pool-1" });
    const page = await admin.listUsers({ limit: 10, cursor: "prev-token" });

    const [listInput] = client.inputsOf("ListUsersCommand");
    expect(listInput).toEqual({ UserPoolId: "pool-1", Limit: 10, PaginationToken: "prev-token" });
    expect(page.items).toEqual([
      { username: "alice", name: "Alice", email: "alice@example.com", isAdmin: true },
      { username: "bob", email: "bob@example.com", isAdmin: false },
    ]);
    expect(page.nextCursor).toBe("next-token");
  });

  test("setAdmin toggles admin group membership", async () => {
    const client = new FakeClient();
    const admin = new CognitoUserAdmin({ client, userPoolId: "pool-1" });
    await admin.setAdmin("alice", true);
    await admin.setAdmin("alice", false);
    expect(client.inputsOf("AdminAddUserToGroupCommand")[0]).toEqual({
      UserPoolId: "pool-1",
      Username: "alice",
      GroupName: "admin",
    });
    expect(client.inputsOf("AdminRemoveUserFromGroupCommand")[0]).toEqual({
      UserPoolId: "pool-1",
      Username: "alice",
      GroupName: "admin",
    });
  });

  test("unknown users map to not_found", async () => {
    const client = new FakeClient().on("AdminAddUserToGroupCommand", () => {
      throw namedError("UserNotFoundException");
    });
    const admin = new CognitoUserAdmin({ client, userPoolId: "pool-1" });
    const err = await admin.setAdmin("ghost", true).catch((e) => e);
    expect((err as DomainError).code).toBe("not_found");
  });
});

// =====================
// CloudFrontInvalidator
// =====================

describe("CloudFrontInvalidator", () => {
  test("creates an invalidation for the given paths", async () => {
    const client = new FakeClient();
    const cdn = new CloudFrontInvalidator({
      client,
      distributionId: "DIST123",
      now: () => new Date("2026-07-10T00:00:00.000Z"),
    });
    await cdn.invalidate(["/r/abc/*"]);
    const [input] = client.inputsOf("CreateInvalidationCommand");
    expect(input.DistributionId).toBe("DIST123");
    expect(input.InvalidationBatch.Paths).toEqual({ Quantity: 1, Items: ["/r/abc/*"] });
    expect(input.InvalidationBatch.CallerReference).toContain("hrb-");
  });

  test("no-ops on empty paths or when no distribution id is resolvable", async () => {
    const client = new FakeClient();
    await new CloudFrontInvalidator({ client, distributionId: "D" }).invalidate([]);
    await new CloudFrontInvalidator({ client }).invalidate(["/r/x/*"]);
    expect(client.calls.length).toBe(0);
  });

  test("lazily resolves and caches the distribution id", async () => {
    const client = new FakeClient();
    let resolves = 0;
    const cdn = new CloudFrontInvalidator({
      client,
      resolveDistributionId: async () => {
        resolves += 1;
        return "DLAZY";
      },
    });
    await cdn.invalidate(["/r/a/*"]);
    await cdn.invalidate(["/r/b/*"]);
    expect(resolves).toBe(1); // cached after first success
    expect(client.inputsOf("CreateInvalidationCommand").length).toBe(2);
  });
});

// =====================
// S3DomainReputation
// =====================

describe("S3DomainReputation", () => {
  function feedClient(hosts: unknown): { client: FakeClient; fetches: () => number } {
    const client = new FakeClient().on("GetObjectCommand", () => ({
      Body: new TextEncoder().encode(JSON.stringify(hosts)),
    }));
    return { client, fetches: () => client.inputsOf("GetObjectCommand").length };
  }

  test("loads the JSON list once and caches within the TTL", async () => {
    const { client, fetches } = feedClient(["Evil.Example", "bad.test"]);
    let clock = 0;
    const rep = new S3DomainReputation({
      client,
      bucket: "hrb-staging",
      key: "feeds/domain-blocklist.json",
      ttlMs: 1000,
      now: () => clock,
    });
    expect(await rep.isMalicious("evil.example")).toBe(true); // case-insensitive
    expect(await rep.isMalicious("good.example")).toBe(false);
    expect(fetches()).toBe(1);
    expect(client.inputsOf("GetObjectCommand")[0]).toEqual({
      Bucket: "hrb-staging",
      Key: "feeds/domain-blocklist.json",
    });

    clock = 1500; // past the TTL → refetch
    expect(await rep.isMalicious("bad.test")).toBe(true);
    expect(fetches()).toBe(2);
  });

  test("accepts the {domains:[...]} shape and survives fetch failures", async () => {
    const { client } = feedClient({ domains: ["evil.example"] });
    const rep = new S3DomainReputation({ client, bucket: "b", key: "k" });
    expect(await rep.isMalicious("evil.example")).toBe(true);

    const failing = new FakeClient().on("GetObjectCommand", () => {
      throw namedError("NoSuchKey");
    });
    const empty = new S3DomainReputation({ client: failing, bucket: "b", key: "k" });
    expect(await empty.isMalicious("evil.example")).toBe(false);
  });
});

// =====================
// createAwsContext
// =====================

const FULL_ENV: AwsEnv = {
  REPORTS_TABLE_NAME: "hrb-reports",
  SEARCH_TABLE_NAME: "hrb-search",
  CONTENT_BUCKET: "hrb-content",
  STAGING_BUCKET: "hrb-staging",
  USER_POOL_ID: "ap-northeast-1_TestPool",
  USER_POOL_CLIENT_ID: "client-1",
  COGNITO_DOMAIN: "https://hrb.auth.ap-northeast-1.amazoncognito.com",
  CONTENT_BASE_URL: "https://content.example.com",
  CONTENT_DISTRIBUTION_ID: "DIST123",
  DOMAIN_BLOCKLIST_BUCKET: "hrb-staging",
  DOMAIN_BLOCKLIST_KEY: "feeds/domain-blocklist.json",
};

function fakeClients() {
  return {
    dynamo: new FakeClient(),
    s3: new FakeClient(),
    cloudfront: new FakeClient(),
    cognito: new FakeClient(),
  };
}

describe("createAwsContext", () => {
  test("builds every adapter and a working ReportService from env", async () => {
    const clients = fakeClients();
    const ctx = createAwsContext(FULL_ENV, { clients });
    expect(ctx.service).toBeInstanceOf(ReportService);
    expect(ctx.contentBaseUrl).toBe("https://content.example.com");
    expect(ctx.service.contentUrl("abc")).toBe("https://content.example.com/r/abc/");
    expect(ctx.auth.authConfig()).toMatchObject({
      mode: "cognito",
      userPoolId: "ap-northeast-1_TestPool",
      region: "ap-northeast-1",
    });

    // The wired repository talks to the reports table through the injected client.
    clients.dynamo.on("GetCommand", () => ({}));
    expect(await ctx.repo.get("nope")).toBeNull();
    expect(clients.dynamo.inputsOf("GetCommand")[0].TableName).toBe("hrb-reports");

    // Blocklist reputation reads the configured S3 object.
    clients.s3.on("GetObjectCommand", () => ({
      Body: new TextEncoder().encode(JSON.stringify(["evil.example"])),
    }));
    expect(await ctx.domainReputation.isMalicious("evil.example")).toBe(true);
  });

  test("missing required env vars fail fast with the variable name", () => {
    const { REPORTS_TABLE_NAME: _omit, ...rest } = FULL_ENV;
    const err = (() => {
      try {
        createAwsContext(rest, { clients: fakeClients() });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(DomainError);
    expect((err as Error).message).toContain("REPORTS_TABLE_NAME");
  });

  test("scanner defaults to fail-closed until @hrb/scanner is wired", async () => {
    const ctx = createAwsContext(FULL_ENV, { clients: fakeClients() });
    expect(ctx.scanner).toBeInstanceOf(UnconfiguredScanner);
    const err = await ctx.scanner
      .scan({ kind: "html", data: new Uint8Array([60]) })
      .catch((e) => e);
    expect((err as DomainError).code).toBe("internal");
  });

  test("distribution id can come from a runtime parameter resolver", async () => {
    const clients = fakeClients();
    const { CONTENT_DISTRIBUTION_ID: _omit, ...env } = FULL_ENV;
    let asked: string | undefined;
    const ctx = createAwsContext(
      { ...env, CONTENT_DISTRIBUTION_ID_PARAM: "/hrb/content-distribution-id" },
      {
        clients,
        resolveParameter: async (name) => {
          asked = name;
          return "DRESOLVED";
        },
      },
    );
    await ctx.cdn.invalidate(["/r/x/*"]);
    expect(asked).toBe("/hrb/content-distribution-id");
    expect(clients.cloudfront.inputsOf("CreateInvalidationCommand")[0].DistributionId).toBe(
      "DRESOLVED",
    );
  });
});
