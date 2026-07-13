import { describe, expect, test } from "bun:test";
import {
  AdminListReportsQuerySchema,
  ALLOWED_CDN_HOSTS,
  ALLOWED_FONT_HOSTS,
  CompleteReportRequestSchema,
  CreateReportRequestSchema,
  ErrorResponseSchema,
  FlagReportRequestSchema,
  GetConfigResponseSchema,
  GetQuotaResponseSchema,
  ListReportsQuerySchema,
  isAllowedCdnHost,
  isAllowedZipEntryExtension,
  makeError,
  MAX_HTML_SIZE_BYTES,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_SIZE_BYTES,
  MAX_ZIP_UNCOMPRESSED_BYTES,
  OwnedReportSchema,
  PresignedUploadSchema,
  PublicReportSchema,
  REPORT_TAG_MAX,
  REPORT_TAGS_MAX,
  ReportIdSchema,
  ReportMetaSchema,
  ReportTagsSchema,
  ScanVerdictSchema,
  SearchQuerySchema,
  toOwnedReport,
  toPublicReport,
  UpdateReportRequestSchema,
  type ReportMeta,
} from "./index.ts";

const validMeta: ReportMeta = {
  id: "V1StGXR8_Z5jdHi6B-myT",
  title: "月次売上レポート",
  description: "2026年6月の売上サマリ",
  tags: ["売上", "月次"],
  ownerSub: "google_1234567890",
  ownerName: "Alice",
  status: "published",
  kind: "html",
  version: 2,
  sha256: "a".repeat(64),
  sizeBytes: 12345,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-10T12:34:56.000Z",
  verdict: "pass",
  findings: [],
  versions: [],
  sourceIp: "10.0.0.1",
  userAgent: "Mozilla/5.0",
};

describe("ReportMetaSchema", () => {
  test("accepts a full valid record", () => {
    const parsed = ReportMetaSchema.parse(validMeta);
    expect(parsed.id).toBe(validMeta.id);
    expect(parsed.status).toBe("published");
  });

  test("findings and description default when omitted", () => {
    const { findings: _f, description: _d, ...rest } = validMeta;
    const parsed = ReportMetaSchema.parse(rest);
    expect(parsed.findings).toEqual([]);
    expect(parsed.description).toBe("");
  });

  test("sha256/sizeBytes/verdict are optional (pre-upload private state)", () => {
    const { sha256: _s, sizeBytes: _b, verdict: _v, ...rest } = validMeta;
    expect(ReportMetaSchema.parse({ ...rest, status: "private" }).verdict).toBeUndefined();
  });

  test("rejects unknown status", () => {
    expect(ReportMetaSchema.safeParse({ ...validMeta, status: "draft" }).success).toBe(false);
  });

  test("rejects invalid sha256", () => {
    expect(ReportMetaSchema.safeParse({ ...validMeta, sha256: "xyz" }).success).toBe(false);
  });

  test("rejects version 0 and empty title", () => {
    expect(ReportMetaSchema.safeParse({ ...validMeta, version: 0 }).success).toBe(false);
    expect(ReportMetaSchema.safeParse({ ...validMeta, title: "  " }).success).toBe(false);
  });

  test("all five statuses are accepted", () => {
    for (const status of ["private", "published", "unlisted", "rejected", "takedown"]) {
      expect(ReportMetaSchema.safeParse({ ...validMeta, status }).success).toBe(true);
    }
  });

  test("tags default to [] when omitted (後方互換)", () => {
    const { tags: _t, ...rest } = validMeta;
    expect(ReportMetaSchema.parse(rest).tags).toEqual([]);
    expect(ReportMetaSchema.parse(validMeta).tags).toEqual(["売上", "月次"]);
  });

  test("findings require ruleId/severity/message", () => {
    const bad = { ...validMeta, findings: [{ ruleId: "r1" }] };
    expect(ReportMetaSchema.safeParse(bad).success).toBe(false);
    const good = {
      ...validMeta,
      findings: [{ ruleId: "phishing-form", severity: "block", message: "external form action" }],
    };
    expect(ReportMetaSchema.safeParse(good).success).toBe(true);
  });
});

describe("ReportIdSchema (nanoid 21)", () => {
  test("accepts nanoid alphabet", () => {
    expect(ReportIdSchema.safeParse("V1StGXR8_Z5jdHi6B-myT").success).toBe(true);
  });
  test("rejects wrong length or characters", () => {
    expect(ReportIdSchema.safeParse("short").success).toBe(false);
    expect(ReportIdSchema.safeParse("V1StGXR8_Z5jdHi6B-my!").success).toBe(false);
    expect(ReportIdSchema.safeParse("V1StGXR8_Z5jdHi6B-myT9").success).toBe(false);
  });
});

describe("public/owner projections", () => {
  test("PublicReport strips ownerSub, audit and scan fields", () => {
    const pub = toPublicReport(ReportMetaSchema.parse(validMeta));
    expect(pub).not.toHaveProperty("ownerSub");
    expect(pub).not.toHaveProperty("sourceIp");
    expect(pub).not.toHaveProperty("userAgent");
    expect(pub).not.toHaveProperty("verdict");
    expect(pub).not.toHaveProperty("findings");
    expect(pub.ownerName).toBe("Alice");
    expect(PublicReportSchema.safeParse(pub).success).toBe(true);
  });

  test("OwnedReport keeps verdict/findings but strips audit fields", () => {
    const owned = toOwnedReport(ReportMetaSchema.parse(validMeta));
    expect(owned.verdict).toBe("pass");
    expect(owned.findings).toEqual([]);
    expect(owned).not.toHaveProperty("sourceIp");
    expect(owned).not.toHaveProperty("userAgent");
    expect(OwnedReportSchema.safeParse(owned).success).toBe(true);
  });
});

describe("error shape", () => {
  test("makeError produces the canonical {error:{code,message}} shape", () => {
    const err = makeError("not_found", "report not found");
    expect(err).toEqual({ error: { code: "not_found", message: "report not found" } });
    expect(ErrorResponseSchema.safeParse(err).success).toBe(true);
  });

  test("rejects unknown error codes", () => {
    expect(
      ErrorResponseSchema.safeParse({ error: { code: "whatever", message: "x" } }).success,
    ).toBe(false);
  });
});

describe("ReportTagsSchema (タグ正規化)", () => {
  test("trims, drops empties and dedupes (first-appearance order)", () => {
    expect(ReportTagsSchema.parse([" 売上 ", "", "  ", "月次", "売上"])).toEqual(["売上", "月次"]);
  });

  test("boundaries: 30 chars ok / 31 rejected; 10 tags ok / 11 rejected", () => {
    expect(ReportTagsSchema.parse(["x".repeat(REPORT_TAG_MAX)])).toEqual([
      "x".repeat(REPORT_TAG_MAX),
    ]);
    expect(ReportTagsSchema.safeParse(["x".repeat(REPORT_TAG_MAX + 1)]).success).toBe(false);

    const ten = Array.from({ length: REPORT_TAGS_MAX }, (_, i) => `t${i}`);
    expect(ReportTagsSchema.parse(ten)).toEqual(ten);
    expect(ReportTagsSchema.safeParse([...ten, "over"]).success).toBe(false);
    // 上限判定は正規化（重複除去）前の raw 配列長で行われる（MCP 入力と同じ規約）
    expect(ReportTagsSchema.safeParse([...ten, "t0"]).success).toBe(false);
    expect(ReportTagsSchema.parse([...ten.slice(0, REPORT_TAGS_MAX - 1), "t0"])).toEqual(
      ten.slice(0, REPORT_TAGS_MAX - 1),
    );
  });

  test("trim 前が31文字でも trim 後30文字以内なら通る", () => {
    expect(ReportTagsSchema.parse([` ${"x".repeat(REPORT_TAG_MAX)}`])).toEqual([
      "x".repeat(REPORT_TAG_MAX),
    ]);
  });
});

describe("API request schemas", () => {
  test("CreateReportRequest: title required, description defaults", () => {
    const parsed = CreateReportRequestSchema.parse({ title: "T", kind: "html" });
    expect(parsed.description).toBe("");
    expect(CreateReportRequestSchema.safeParse({ kind: "html" }).success).toBe(false);
    expect(CreateReportRequestSchema.safeParse({ title: "T", kind: "tar" }).success).toBe(false);
  });

  test("CreateReportRequest trims title and rejects over-long values", () => {
    expect(CreateReportRequestSchema.parse({ title: "  T  ", kind: "zip" }).title).toBe("T");
    expect(
      CreateReportRequestSchema.safeParse({ title: "x".repeat(201), kind: "html" }).success,
    ).toBe(false);
  });

  test("UpdateReportRequest requires at least one field", () => {
    expect(UpdateReportRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateReportRequestSchema.safeParse({ title: "new" }).success).toBe(true);
    expect(UpdateReportRequestSchema.safeParse({ description: "" }).success).toBe(true);
  });

  test("CreateReportRequest: tags default to [] and are normalized", () => {
    expect(CreateReportRequestSchema.parse({ title: "T", kind: "html" }).tags).toEqual([]);
    expect(
      CreateReportRequestSchema.parse({ title: "T", kind: "html", tags: [" a ", "a", ""] }).tags,
    ).toEqual(["a"]);
  });

  test("UpdateReportRequest accepts a tags-only patch ([] = 全削除)", () => {
    expect(UpdateReportRequestSchema.parse({ tags: ["再編", "再編"] }).tags).toEqual(["再編"]);
    expect(UpdateReportRequestSchema.parse({ tags: [] }).tags).toEqual([]);
    expect(UpdateReportRequestSchema.parse({ title: "t" }).tags).toBeUndefined();
  });

  test("ListReportsQuery accepts tag and rejects blank / over-long values", () => {
    expect(ListReportsQuerySchema.parse({ tag: " 月次 " }).tag).toBe("月次");
    expect(ListReportsQuerySchema.parse({}).tag).toBeUndefined();
    expect(ListReportsQuerySchema.safeParse({ tag: "  " }).success).toBe(false);
    expect(ListReportsQuerySchema.safeParse({ tag: "x".repeat(REPORT_TAG_MAX + 1) }).success).toBe(
      false,
    );
  });

  test("SearchQuery: q required, trimmed, limit coerced from string", () => {
    const parsed = SearchQuerySchema.parse({ q: " 東京 ", limit: "10" });
    expect(parsed.q).toBe("東京");
    expect(parsed.limit).toBe(10);
    expect(SearchQuerySchema.safeParse({ q: "   " }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: "a", limit: "0" }).success).toBe(false);
  });

  test("SearchQuery accepts an optional continuation cursor", () => {
    expect(SearchQuerySchema.parse({ q: "a", cursor: "20" }).cursor).toBe("20");
    expect(SearchQuerySchema.parse({ q: "a" }).cursor).toBeUndefined();
    expect(SearchQuerySchema.safeParse({ q: "a", cursor: "" }).success).toBe(false);
  });

  test("ListReportsQuery accepts order/kind and rejects unknown values", () => {
    expect(ListReportsQuerySchema.parse({ order: "asc", kind: "zip", limit: "5" })).toEqual({
      order: "asc",
      kind: "zip",
      limit: 5,
    });
    expect(ListReportsQuerySchema.parse({})).toEqual({});
    expect(ListReportsQuerySchema.safeParse({ order: "up" }).success).toBe(false);
    expect(ListReportsQuerySchema.safeParse({ kind: "tar" }).success).toBe(false);
  });

  test("CompleteReportRequest requires staging key", () => {
    expect(CompleteReportRequestSchema.safeParse({}).success).toBe(false);
    expect(CompleteReportRequestSchema.safeParse({ key: "staging/abc" }).success).toBe(true);
  });

  test("FlagReportRequest bounds reason length", () => {
    expect(FlagReportRequestSchema.safeParse({ reason: "" }).success).toBe(false);
    expect(FlagReportRequestSchema.safeParse({ reason: "x".repeat(1001) }).success).toBe(false);
    expect(FlagReportRequestSchema.safeParse({ reason: "phishing" }).success).toBe(true);
  });

  test("AdminListReportsQuery accepts status filter", () => {
    expect(
      AdminListReportsQuerySchema.parse({ status: "private", limit: "5" }),
    ).toEqual({ status: "private", limit: 5 });
    expect(AdminListReportsQuerySchema.safeParse({ status: "nope" }).success).toBe(false);
  });
});

describe("API response schemas", () => {
  test("GetConfigResponse: dev and cognito auth variants", () => {
    const base = {
      contentBaseUrl: "http://localhost:3000",
      limits: {
        maxHtmlSizeBytes: MAX_HTML_SIZE_BYTES,
        maxZipSizeBytes: MAX_ZIP_SIZE_BYTES,
        maxZipUncompressedBytes: MAX_ZIP_UNCOMPRESSED_BYTES,
        maxZipEntries: MAX_ZIP_ENTRIES,
        dailyUploadLimit: null,
      },
    };
    expect(
      GetConfigResponseSchema.safeParse({ ...base, auth: { mode: "dev", users: ["alice"] } })
        .success,
    ).toBe(true);
    expect(
      GetConfigResponseSchema.safeParse({
        ...base,
        auth: {
          mode: "cognito",
          region: "ap-northeast-1",
          userPoolId: "ap-northeast-1_x",
          clientId: "abc",
          domain: "https://x.auth.ap-northeast-1.amazoncognito.com",
        },
      }).success,
    ).toBe(true);
    expect(GetConfigResponseSchema.safeParse({ ...base, auth: { mode: "iam" } }).success).toBe(
      false,
    );
  });

  test("GetQuotaResponse: usedToday/remaining are nonnegative", () => {
    expect(
      GetQuotaResponseSchema.safeParse({
        dailyUploadLimit: 30,
        usedToday: 0,
        remaining: 30,
      }).success,
    ).toBe(true);
    expect(
      GetQuotaResponseSchema.safeParse({
        dailyUploadLimit: 30,
        usedToday: 30,
        remaining: -1,
      }).success,
    ).toBe(false);
  });

  test("GetQuotaResponse: 無制限（null）を受理する", () => {
    expect(
      GetQuotaResponseSchema.safeParse({
        dailyUploadLimit: null,
        usedToday: 42,
        remaining: null,
      }).success,
    ).toBe(true);
  });

  test("PresignedUpload shape", () => {
    const ok = PresignedUploadSchema.safeParse({
      url: "https://staging.s3.amazonaws.com",
      fields: { key: "staging/x", policy: "...", "x-amz-signature": "..." },
      key: "staging/x",
      expiresInSeconds: 300,
      maxSizeBytes: MAX_HTML_SIZE_BYTES,
    });
    expect(ok.success).toBe(true);
  });

  test("PresignedUpload: method/fields/headers default (S3 POST back-compat)", () => {
    // 既存の presigned POST 呼び出しは method/headers を省略できる。
    const parsed = PresignedUploadSchema.parse({
      url: "https://staging.s3.amazonaws.com",
      fields: { key: "staging/x", policy: "..." },
      key: "staging/x",
      expiresInSeconds: 300,
      maxSizeBytes: MAX_HTML_SIZE_BYTES,
    });
    expect(parsed.method).toBe("post");
    expect(parsed.headers).toEqual({});

    // fields も省略可能（default {}）。
    const noFields = PresignedUploadSchema.parse({
      url: "https://r2.example/put",
      key: "staging/x",
      expiresInSeconds: 300,
      maxSizeBytes: MAX_HTML_SIZE_BYTES,
    });
    expect(noFields.fields).toEqual({});
  });

  test("PresignedUpload: put + headers parse (R2 transport)", () => {
    const parsed = PresignedUploadSchema.parse({
      method: "put",
      url: "https://r2.example/staging/x?sig=abc",
      headers: { "content-type": "text/html" },
      key: "staging/x",
      expiresInSeconds: 300,
      maxSizeBytes: MAX_HTML_SIZE_BYTES,
    });
    expect(parsed.method).toBe("put");
    expect(parsed.headers).toEqual({ "content-type": "text/html" });
    expect(parsed.fields).toEqual({});
    // method は post/put のみ。
    expect(PresignedUploadSchema.safeParse({
      method: "patch",
      url: "https://x",
      key: "staging/x",
      expiresInSeconds: 300,
      maxSizeBytes: MAX_HTML_SIZE_BYTES,
    }).success).toBe(false);
  });
});

describe("constants", () => {
  test("verdict enum is pass/warn/block", () => {
    expect(ScanVerdictSchema.options).toEqual(["pass", "warn", "block"]);
  });

  test("CDN allowlist is the 4 major CDNs + Google Fonts hosts", () => {
    expect([...ALLOWED_CDN_HOSTS]).toEqual([
      "cdn.jsdelivr.net",
      "unpkg.com",
      "cdnjs.cloudflare.com",
      "cdn.tailwindcss.com",
    ]);
    expect([...ALLOWED_FONT_HOSTS]).toEqual(["fonts.googleapis.com", "fonts.gstatic.com"]);
    expect(isAllowedCdnHost("CDN.JSDELIVR.NET")).toBe(true);
    expect(isAllowedCdnHost("evil.example.com")).toBe(false);
  });

  test("size limits match the plan", () => {
    expect(MAX_HTML_SIZE_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_ZIP_SIZE_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_ZIP_UNCOMPRESSED_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_ZIP_ENTRIES).toBe(200);
  });

  test("zip entry extension allowlist", () => {
    expect(isAllowedZipEntryExtension(".html")).toBe(true);
    expect(isAllowedZipEntryExtension(".PNG")).toBe(true);
    expect(isAllowedZipEntryExtension(".exe")).toBe(false);
    expect(isAllowedZipEntryExtension(".php")).toBe(false);
    expect(isAllowedZipEntryExtension(".zip")).toBe(false); // nested zip forbidden
  });
});
