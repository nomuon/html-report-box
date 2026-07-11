/**
 * Report domain schemas (zod v4). Portable; no Bun-only APIs.
 */
import { z } from "zod";
import { REPORT_ID_PATTERN } from "./constants.ts";

// ---- Enums ----
/**
 * Lifecycle:
 *   private   — exists but unlisted; owner/admin only (initial state, user can
 *               publish/unpublish freely)
 *   published — publicly listed, indexed and served
 *   rejected  — latest upload was blocked by the security scan
 *   takedown  — force-unpublished by an administrator
 */
export const REPORT_STATUSES = ["private", "published", "rejected", "takedown"] as const;
export const ReportStatusSchema = z.enum(REPORT_STATUSES);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

export const REPORT_KINDS = ["html", "zip"] as const;
export const ReportKindSchema = z.enum(REPORT_KINDS);
export type ReportKind = z.infer<typeof ReportKindSchema>;

export const SCAN_VERDICTS = ["pass", "warn", "block"] as const;
export const ScanVerdictSchema = z.enum(SCAN_VERDICTS);
export type ScanVerdict = z.infer<typeof ScanVerdictSchema>;

// ---- Scan finding ----
export const ScanFindingSchema = z.object({
  ruleId: z.string().min(1),
  severity: z.enum(["warn", "block"]),
  message: z.string().min(1),
  /** Optional evidence snippet / matched value (truncated by producer). */
  detail: z.string().optional(),
  /** For zip uploads: the entry path the finding was raised on. */
  entryPath: z.string().optional(),
});
export type ScanFinding = z.infer<typeof ScanFindingSchema>;

// ---- Abuse flag (通報) ----
export const ReportFlagSchema = z.object({
  reason: z.string().min(1),
  createdAt: z.iso.datetime(),
  /** Audit only; stripped from non-admin views. */
  sourceIp: z.string().optional(),
});
export type ReportFlag = z.infer<typeof ReportFlagSchema>;

// ---- Report id ----
export const ReportIdSchema = z.string().regex(REPORT_ID_PATTERN, "invalid report id");
export type ReportId = z.infer<typeof ReportIdSchema>;

// ---- Field limits ----
export const REPORT_TITLE_MAX = 200;
export const REPORT_DESCRIPTION_MAX = 2000;

export const ReportTitleSchema = z.string().trim().min(1).max(REPORT_TITLE_MAX);
export const ReportDescriptionSchema = z.string().trim().max(REPORT_DESCRIPTION_MAX);

// ---- Full report metadata (internal record; DynamoDB META item shape) ----
export const ReportMetaSchema = z.object({
  id: ReportIdSchema,
  title: ReportTitleSchema,
  description: ReportDescriptionSchema.default(""),
  /** Cognito sub (or dev user id in local mode) of the owner. */
  ownerSub: z.string().min(1),
  /** Display name denormalized from the IdP at upload time. */
  ownerName: z.string().min(1),
  status: ReportStatusSchema,
  kind: ReportKindSchema,
  /** Monotonically increasing content version (1 on first publish). */
  version: z.number().int().min(1),
  /** Hex sha256 of the uploaded object. Absent until the first complete. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Uploaded object size in bytes. Absent until the first complete. */
  sizeBytes: z.number().int().nonnegative().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Result of the latest security scan. Absent until the first upload completes. */
  verdict: ScanVerdictSchema.optional(),
  findings: z.array(ScanFindingSchema).default([]),
  /** Audit trail (never exposed publicly). */
  sourceIp: z.string().optional(),
  userAgent: z.string().optional(),
});
export type ReportMeta = z.infer<typeof ReportMetaSchema>;
export type ReportMetaInput = z.input<typeof ReportMetaSchema>;

// ---- Public view: what unauthenticated readers see ----
export const PublicReportSchema = ReportMetaSchema.omit({
  ownerSub: true,
  verdict: true,
  findings: true,
  sourceIp: true,
  userAgent: true,
});
export type PublicReport = z.infer<typeof PublicReportSchema>;

// ---- Owner view: adds scan outcome, still hides audit fields ----
export const OwnedReportSchema = ReportMetaSchema.omit({
  sourceIp: true,
  userAgent: true,
});
export type OwnedReport = z.infer<typeof OwnedReportSchema>;

// ---- Admin view: everything ----
export const AdminReportSchema = ReportMetaSchema;
export type AdminReport = z.infer<typeof AdminReportSchema>;

export function toPublicReport(meta: ReportMeta): PublicReport {
  return PublicReportSchema.parse(meta);
}

export function toOwnedReport(meta: ReportMeta): OwnedReport {
  return OwnedReportSchema.parse(meta);
}
