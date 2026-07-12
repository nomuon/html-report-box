/**
 * API contracts (zod v4) for base path `/api`.
 * Every error response has the shape { error: { code, message } }.
 * Portable; no Bun-only APIs.
 */
import { z } from "zod";
import {
  AdminReportSchema,
  OwnedReportSchema,
  PublicReportSchema,
  ReportDescriptionSchema,
  ReportFlagSchema,
  ReportKindSchema,
  ReportStatusSchema,
  ReportTitleSchema,
} from "./report.ts";

// =====================
// Error shape
// =====================
export const ERROR_CODES = [
  "bad_request",
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "payload_too_large",
  "rate_limited",
  "upload_incomplete",
  "scan_rejected",
  "internal",
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export function makeError(code: ErrorCode, message: string): ErrorResponse {
  return { error: { code, message } };
}

export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;

// =====================
// Common
// =====================
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

/**
 * Presigned upload issued against the staging bucket. Two transports:
 * - method "post": S3 presigned POST — send a multipart form of `fields` + file
 *   (size enforced via the content-length-range policy condition).
 * - method "put":  presigned PUT (R2 等、POST 非対応) — PUT the raw bytes with
 *   `headers` applied.
 * `method` defaults to "post" so existing S3 issuers/consumers stay unchanged.
 */
export const PresignedUploadSchema = z.object({
  /** Upload transport: presigned POST (S3) or presigned PUT (R2 等). */
  method: z.enum(["post", "put"]).default("post"),
  /** URL to POST the multipart form / PUT the bytes to. */
  url: z.string().min(1),
  /** POST only: form fields that must accompany the file (policy, signature, key, ...). */
  fields: z.record(z.string(), z.string()).default({}),
  /** PUT only: request headers to apply to the raw-body upload (content-type 等). */
  headers: z.record(z.string(), z.string()).default({}),
  /** Staging object key the client will upload to. */
  key: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
  /** Enforced via content-length-range (POST policy) or a size check on complete. */
  maxSizeBytes: z.number().int().positive(),
});
export type PresignedUpload = z.infer<typeof PresignedUploadSchema>;
export type PresignedUploadInput = z.input<typeof PresignedUploadSchema>;

// =====================
// GET /config (public)
// =====================
export const AuthConfigSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("dev"),
    /** Selectable dev users in local mode. */
    users: z.array(z.string()).default([]),
  }),
  z.object({
    mode: z.literal("cognito"),
    region: z.string().min(1),
    userPoolId: z.string().min(1),
    clientId: z.string().min(1),
    /** Hosted UI domain, e.g. https://xxx.auth.ap-northeast-1.amazoncognito.com */
    domain: z.string().min(1),
  }),
  z.object({
    mode: z.literal("google"),
    /** Google OAuth client id rendered into the GIS Sign in with Google button. */
    clientId: z.string().min(1),
  }),
]);
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

// =====================
// POST /auth/google + POST /auth/logout (google mode only)
// =====================
export const GoogleLoginRequestSchema = z.object({
  /** Google ID token (GIS credential) issued to the configured client id. */
  credential: z.string().min(1),
});
export type GoogleLoginRequest = z.infer<typeof GoogleLoginRequestSchema>;

/** Authenticated user as returned to the SPA (session bootstrap). */
export const SessionUserSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
  email: z.string().min(1),
  picture: z.string().url().optional(),
  isAdmin: z.boolean(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const GoogleLoginResponseSchema = z.object({
  /** Opaque session token; sent back as `authorization: Bearer <token>`. */
  token: z.string().min(1),
  user: SessionUserSchema,
});
export type GoogleLoginResponse = z.infer<typeof GoogleLoginResponseSchema>;

export const LogoutResponseSchema = z.object({ ok: z.literal(true) });
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

export const GetConfigResponseSchema = z.object({
  /** Origin serving uploaded content, e.g. https://content.example.com */
  contentBaseUrl: z.string().min(1),
  auth: AuthConfigSchema,
  limits: z.object({
    maxHtmlSizeBytes: z.number().int().positive(),
    maxZipSizeBytes: z.number().int().positive(),
    maxZipUncompressedBytes: z.number().int().positive(),
    maxZipEntries: z.number().int().positive(),
    dailyUploadLimit: z.number().int().positive(),
  }),
});
export type GetConfigResponse = z.infer<typeof GetConfigResponseSchema>;

// =====================
// GET /reports (public list, published only)
// =====================
export const ListReportsQuerySchema = PaginationQuerySchema;
export type ListReportsQuery = z.infer<typeof ListReportsQuerySchema>;

export const ListReportsResponseSchema = z.object({
  reports: z.array(PublicReportSchema),
  nextCursor: z.string().optional(),
});
export type ListReportsResponse = z.infer<typeof ListReportsResponseSchema>;

// =====================
// GET /search?q= (public)
// =====================
export const SEARCH_QUERY_MAX = 200;
export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const SearchResultSchema = z.object({
  report: PublicReportSchema,
  /** Sum of matched posting weights. */
  score: z.number().nonnegative(),
  /** True when every query token matched (ranked above partial matches). */
  matchedAll: z.boolean(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// =====================
// GET /reports/:id (public)
// =====================
export const GetReportResponseSchema = z.object({
  report: PublicReportSchema,
  /** Content URL, e.g. https://content.example.com/r/<id>/ (absent unless published). */
  url: z.string().optional(),
});
export type GetReportResponse = z.infer<typeof GetReportResponseSchema>;

// =====================
// GET /me/reports (auth)
// =====================
export const MyReportsResponseSchema = z.object({
  reports: z.array(OwnedReportSchema),
  nextCursor: z.string().optional(),
});
export type MyReportsResponse = z.infer<typeof MyReportsResponseSchema>;

// =====================
// POST /reports (auth) — create META (status=private) + issue presigned POST
// =====================
export const CreateReportRequestSchema = z.object({
  title: ReportTitleSchema,
  description: ReportDescriptionSchema.default(""),
  kind: ReportKindSchema,
});
export type CreateReportRequest = z.infer<typeof CreateReportRequestSchema>;
export type CreateReportRequestInput = z.input<typeof CreateReportRequestSchema>;

export const CreateReportResponseSchema = z.object({
  report: OwnedReportSchema,
  upload: PresignedUploadSchema,
});
export type CreateReportResponse = z.infer<typeof CreateReportResponseSchema>;

// =====================
// POST /reports/:id/upload-url (auth, owner) — presigned POST for overwrite
// =====================
export const CreateUploadUrlRequestSchema = z.object({
  kind: ReportKindSchema,
});
export type CreateUploadUrlRequest = z.infer<typeof CreateUploadUrlRequestSchema>;

export const CreateUploadUrlResponseSchema = z.object({
  upload: PresignedUploadSchema,
});
export type CreateUploadUrlResponse = z.infer<typeof CreateUploadUrlResponseSchema>;

// =====================
// POST /reports/:id/complete (auth, owner) — validate + scan + store
// (already-published reports stay published; everything else lands private)
// =====================
export const CompleteReportRequestSchema = z.object({
  /** Staging key returned by the presigned upload. */
  key: z.string().min(1),
});
export type CompleteReportRequest = z.infer<typeof CompleteReportRequestSchema>;

export const CompleteReportResponseSchema = z.object({
  report: OwnedReportSchema,
  /** Present when the report ended up published. */
  url: z.string().optional(),
});
export type CompleteReportResponse = z.infer<typeof CompleteReportResponseSchema>;

// =====================
// PATCH /reports/:id (auth, owner) — metadata edit
// =====================
export const UpdateReportRequestSchema = z
  .object({
    title: ReportTitleSchema.optional(),
    description: ReportDescriptionSchema.optional(),
  })
  .refine((v) => v.title !== undefined || v.description !== undefined, {
    message: "at least one of title/description is required",
  });
export type UpdateReportRequest = z.infer<typeof UpdateReportRequestSchema>;

export const UpdateReportResponseSchema = z.object({
  report: OwnedReportSchema,
});
export type UpdateReportResponse = z.infer<typeof UpdateReportResponseSchema>;

// =====================
// POST /reports/:id/publish (auth, owner or admin) — private → published
// =====================
export const PublishReportResponseSchema = z.object({
  report: OwnedReportSchema,
  /** Content URL of the now-published report. */
  url: z.string().min(1),
});
export type PublishReportResponse = z.infer<typeof PublishReportResponseSchema>;

// =====================
// POST /reports/:id/unpublish (auth, owner or admin) — published → private
// =====================
export const UnpublishReportResponseSchema = z.object({
  report: OwnedReportSchema,
});
export type UnpublishReportResponse = z.infer<typeof UnpublishReportResponseSchema>;

// =====================
// GET /reports/:id/source (auth, owner or admin) — HTML for editing / private preview
// =====================
export const GetReportSourceResponseSchema = z.object({
  kind: ReportKindSchema,
  /** html kind: the uploaded source. zip kind: the extracted root index.html (read-only preview). */
  html: z.string(),
});
export type GetReportSourceResponse = z.infer<typeof GetReportSourceResponseSchema>;

// =====================
// PUT /reports/:id/content (auth, owner or admin) — direct HTML edit (html kind only)
// =====================
export const UpdateReportContentRequestSchema = z.object({
  html: z.string().min(1),
});
export type UpdateReportContentRequest = z.infer<typeof UpdateReportContentRequestSchema>;

export const UpdateReportContentResponseSchema = z.object({
  report: OwnedReportSchema,
  /** Present when the report is (still) published. */
  url: z.string().optional(),
});
export type UpdateReportContentResponse = z.infer<typeof UpdateReportContentResponseSchema>;

// =====================
// DELETE /reports/:id (auth, owner or admin)
// =====================
export const DeleteReportResponseSchema = OkResponseSchema;
export type DeleteReportResponse = z.infer<typeof DeleteReportResponseSchema>;

// =====================
// POST /reports/:id/flag (public, rate limited) — abuse report
// =====================
export const FLAG_REASON_MAX = 1000;
export const FlagReportRequestSchema = z.object({
  reason: z.string().trim().min(1).max(FLAG_REASON_MAX),
});
export type FlagReportRequest = z.infer<typeof FlagReportRequestSchema>;

export const FlagReportResponseSchema = OkResponseSchema;
export type FlagReportResponse = z.infer<typeof FlagReportResponseSchema>;

// =====================
// Admin
// =====================

// GET /admin/reports — all statuses, optional filter
export const AdminListReportsQuerySchema = PaginationQuerySchema.extend({
  status: ReportStatusSchema.optional(),
});
export type AdminListReportsQuery = z.infer<typeof AdminListReportsQuerySchema>;

export const AdminListReportsResponseSchema = z.object({
  reports: z.array(AdminReportSchema),
  nextCursor: z.string().optional(),
});
export type AdminListReportsResponse = z.infer<typeof AdminListReportsResponseSchema>;

// POST /admin/reports/:id/takedown — force-unpublish + purge a report
export const AdminReportActionResponseSchema = z.object({
  report: AdminReportSchema,
});
export type AdminReportActionResponse = z.infer<typeof AdminReportActionResponseSchema>;

// GET /admin/flagged — reports that received abuse flags (通報), newest flag first
export const AdminFlaggedReportSchema = z.object({
  report: AdminReportSchema,
  flags: z.array(ReportFlagSchema),
});
export type AdminFlaggedReport = z.infer<typeof AdminFlaggedReportSchema>;

export const AdminListFlaggedResponseSchema = z.object({
  items: z.array(AdminFlaggedReportSchema),
});
export type AdminListFlaggedResponse = z.infer<typeof AdminListFlaggedResponseSchema>;

// GET /admin/reports/:id/flags — flags of one report
export const AdminListFlagsResponseSchema = z.object({
  flags: z.array(ReportFlagSchema),
});
export type AdminListFlagsResponse = z.infer<typeof AdminListFlagsResponseSchema>;

// DELETE /admin/reports/:id/flags — resolve (clear) all flags of a report
export const AdminClearFlagsResponseSchema = OkResponseSchema;
export type AdminClearFlagsResponse = z.infer<typeof AdminClearFlagsResponseSchema>;

// GET /admin/users
export const AdminUserSchema = z.object({
  username: z.string().min(1),
  name: z.string().optional(),
  email: z.string().optional(),
  isAdmin: z.boolean(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const AdminListUsersResponseSchema = z.object({
  users: z.array(AdminUserSchema),
  nextCursor: z.string().optional(),
});
export type AdminListUsersResponse = z.infer<typeof AdminListUsersResponseSchema>;

// PUT /admin/users/:username/admin — grant / DELETE — revoke
export const AdminSetAdminResponseSchema = OkResponseSchema;
export type AdminSetAdminResponse = z.infer<typeof AdminSetAdminResponseSchema>;

// DELETE /admin/users/:username — delete the account + cascade-delete their reports
export const AdminDeleteUserResponseSchema = z.object({
  ok: z.literal(true),
  /** レポート巻き添え削除の件数（UI のトースト表示用） */
  deletedReports: z.number().int().nonnegative(),
});
export type AdminDeleteUserResponse = z.infer<typeof AdminDeleteUserResponseSchema>;
