import { describe, expect, test } from "bun:test";
import { ApiClient, ApiError, isApiError } from "./api.ts";
import type { FetchLike } from "./api.ts";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function mockFetch(status: number, body: unknown) {
  const calls: Captured[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchFn };
}

describe("ApiClient", () => {
  test("GET /config hits the base path without auth headers", async () => {
    const { calls, fetchFn } = mockFetch(200, { contentBaseUrl: "http://x" });
    const client = new ApiClient({ fetchFn });
    const res = await client.getConfig();
    expect(res.contentBaseUrl).toBe("http://x");
    expect(calls[0]?.url).toBe("/api/config");
    expect(calls[0]?.method).toBe("GET");
  });

  test("attaches getHeaders() to every request (x-dev-user)", async () => {
    const { calls, fetchFn } = mockFetch(200, { reports: [] });
    const client = new ApiClient({ fetchFn, getHeaders: () => ({ "x-dev-user": "alice" }) });
    await client.myReports();
    expect(calls[0]?.headers["x-dev-user"]).toBe("alice");
  });

  test("serializes query params and skips undefined", async () => {
    const { calls, fetchFn } = mockFetch(200, { results: [] });
    const client = new ApiClient({ fetchFn });
    await client.search("日本語 query");
    expect(calls[0]?.url).toBe(`/api/search?${new URLSearchParams({ q: "日本語 query" })}`);
    await client.listReports({ limit: 10, cursor: "abc" });
    expect(calls[1]?.url).toBe("/api/reports?limit=10&cursor=abc");
    await client.listReports();
    expect(calls[2]?.url).toBe("/api/reports");
  });

  test("POST bodies are JSON with content-type", async () => {
    const { calls, fetchFn } = mockFetch(201, { report: {}, upload: {} });
    const client = new ApiClient({ fetchFn });
    await client.createReport({ title: "t", description: "", kind: "html" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ title: "t", description: "", kind: "html" });
  });

  test("report id is URL-encoded in the path", async () => {
    const { calls, fetchFn } = mockFetch(200, { report: {} });
    const client = new ApiClient({ fetchFn });
    await client.getReport("abc/../x");
    expect(calls[0]?.url).toBe(`/api/reports/${encodeURIComponent("abc/../x")}`);
  });

  test("admin list endpoints serialize status/limit/cursor query params", async () => {
    const { calls, fetchFn } = mockFetch(200, { reports: [], items: [], users: [] });
    const client = new ApiClient({ fetchFn });
    await client.adminListReports({ status: "published", limit: 50, cursor: "50" });
    expect(calls[0]?.url).toBe("/api/admin/reports?status=published&limit=50&cursor=50");
    await client.adminListReports();
    expect(calls[1]?.url).toBe("/api/admin/reports");
    await client.adminListFlagged({ limit: 50, cursor: "50" });
    expect(calls[2]?.url).toBe("/api/admin/flagged?limit=50&cursor=50");
    await client.adminListFlagged();
    expect(calls[3]?.url).toBe("/api/admin/flagged");
    await client.adminListUsers({ limit: 50, cursor: "abc" });
    expect(calls[4]?.url).toBe("/api/admin/users?limit=50&cursor=abc");
  });

  test("admin setAdmin uses PUT to grant / DELETE to revoke", async () => {
    const { calls, fetchFn } = mockFetch(200, { ok: true });
    const client = new ApiClient({ fetchFn });
    await client.adminSetAdmin("bob", true);
    await client.adminSetAdmin("bob", false);
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[1]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe("/api/admin/users/bob/admin");
  });

  test("adminDeleteUser targets the account itself (username encoded)", async () => {
    const { calls, fetchFn } = mockFetch(200, { ok: true, deletedReports: 3 });
    const client = new ApiClient({ fetchFn });
    const res = await client.adminDeleteUser("bob@corp");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`/api/admin/users/${encodeURIComponent("bob@corp")}`);
    expect(res.deletedReports).toBe(3);
  });

  test("maps {error:{code,message}} to ApiError with status", async () => {
    const { fetchFn } = mockFetch(403, {
      error: { code: "forbidden", message: "admin privileges required" },
    });
    const client = new ApiClient({ fetchFn });
    try {
      await client.adminListReports();
      throw new Error("should have thrown");
    } catch (err) {
      expect(isApiError(err)).toBe(true);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe("forbidden");
      expect(apiErr.status).toBe(403);
      expect(apiErr.message).toBe("admin privileges required");
    }
  });

  test("non-JSON error body falls back to internal + HTTP status", async () => {
    const fetchFn: FetchLike = async () => new Response("boom", { status: 502 });
    const client = new ApiClient({ fetchFn });
    try {
      await client.getConfig();
      throw new Error("should have thrown");
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe("internal");
      expect(apiErr.status).toBe(502);
    }
  });

  test("network failure surfaces as code=network", async () => {
    const fetchFn: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const client = new ApiClient({ fetchFn });
    try {
      await client.getConfig();
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ApiError).code).toBe("network");
    }
  });
});
