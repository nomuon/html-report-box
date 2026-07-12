/**
 * Report domain schemas (zod v4). Portable; no Bun-only APIs.
 */
import { z } from "zod";
import { REPORT_ID_PATTERN } from "./constants.ts";

// ---- Enums ----
/**
 * Lifecycle:
 *   private   — exists but hidden; owner/admin only (initial state, user can
 *               publish/unpublish freely)
 *   published — publicly listed, indexed and served
 *   unlisted  — served like published, but never listed or indexed
 *               (link-only sharing; anyone with the URL can view)
 *   rejected  — latest upload was blocked by the security scan
 *   takedown  — force-unpublished by an administrator
 */
export const REPORT_STATUSES = ["private", "published", "unlisted", "rejected", "takedown"] as const;
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

// ---- Version history entry (原本 sources/<id>/v<version> のメタデータ) ----
export const ReportVersionSchema = z.object({
  /** ReportMeta.version と同じ単調増加値。 */
  version: z.number().int().min(1),
  /**
   * 取り込み時点の kind。上書きで kind が変わり得るため、rollback は
   * この値でスキャン・展開する（zip を html として扱う事故を防ぐ）。
   */
  kind: ReportKindSchema,
  createdAt: z.iso.datetime(),
  sizeBytes: z.number().int().nonnegative(),
  verdict: ScanVerdictSchema,
});
export type ReportVersion = z.infer<typeof ReportVersionSchema>;

// ---- Report id ----
export const ReportIdSchema = z.string().regex(REPORT_ID_PATTERN, "invalid report id");
export type ReportId = z.infer<typeof ReportIdSchema>;

// ---- Field limits ----
export const REPORT_TITLE_MAX = 200;
export const REPORT_DESCRIPTION_MAX = 2000;
export const REPORT_TAGS_MAX = 10;
export const REPORT_TAG_MAX = 30;

export const ReportTitleSchema = z.string().trim().min(1).max(REPORT_TITLE_MAX);
export const ReportDescriptionSchema = z.string().trim().max(REPORT_DESCRIPTION_MAX);

/**
 * タグ配列の正規化: 各タグを trim → 空文字を除外 → 重複を除去。
 * 各タグは最大 REPORT_TAG_MAX 文字、正規化後は最大 REPORT_TAGS_MAX 個。
 */
export const ReportTagsSchema = z
  .array(z.string().trim().max(REPORT_TAG_MAX))
  .transform((tags) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tag of tags) {
      if (tag.length === 0 || seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
    }
    return out;
  })
  .refine((tags) => tags.length <= REPORT_TAGS_MAX, {
    message: `at most ${REPORT_TAGS_MAX} tags are allowed`,
  });

// ---- Full report metadata (internal record; DynamoDB META item shape) ----
export const ReportMetaSchema = z.object({
  id: ReportIdSchema,
  title: ReportTitleSchema,
  description: ReportDescriptionSchema.default(""),
  /** 整理用タグ（正規化済み）。tags を持たない既存データは空として扱う（後方互換）。 */
  tags: ReportTagsSchema.default([]),
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
  /**
   * 公開の有効期限（ISO 8601）。未設定は無期限。期限を過ぎた published /
   * unlisted は読み取りパスで「公開されていない」扱いになる（遅延失効 —
   * status 自体は書き換えない。ReportService.isExpired 参照）。
   */
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  /** Result of the latest security scan. Absent until the first upload completes. */
  verdict: ScanVerdictSchema.optional(),
  findings: z.array(ScanFindingSchema).default([]),
  /**
   * 保持中の原本バージョン履歴（古い順、最大 REPORT_VERSION_HISTORY_LIMIT 件）。
   * versions を持たない既存データは空履歴として扱う（後方互換）。
   */
  versions: z.array(ReportVersionSchema).default([]),
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
  versions: true,
  sourceIp: true,
  userAgent: true,
});
export type PublicReport = z.infer<typeof PublicReportSchema>;

// ---- Owner view: adds scan outcome, still hides audit fields ----
export const OwnedReportSchema = ReportMetaSchema.omit({
  sourceIp: true,
  userAgent: true,
}).extend({
  /** 累計閲覧数（オーナー向け一覧で付与。META には保存されないカウンタ由来）。 */
  viewCount: z.number().int().nonnegative().optional(),
});
export type OwnedReport = z.infer<typeof OwnedReportSchema>;

// ---- Admin view: everything ----
export const AdminReportSchema = ReportMetaSchema;
export type AdminReport = z.infer<typeof AdminReportSchema>;

export function toPublicReport(meta: ReportMeta): PublicReport {
  return PublicReportSchema.parse(meta);
}

export function toOwnedReport(meta: ReportMeta & { viewCount?: number }): OwnedReport {
  return OwnedReportSchema.parse(meta);
}
