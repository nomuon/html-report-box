/**
 * ReportService — domain logic for the report lifecycle:
 * create (META + presigned upload) → complete (validate → extract → scan →
 * publish / pending_review / rejected) → list / get / search / update /
 * delete, plus admin approve / reject / takedown and abuse flags.
 * Portable (Node 22); no Bun-only APIs.
 */
import { createHash } from "node:crypto";
import {
  CreateReportRequestSchema,
  DAILY_UPLOAD_LIMIT,
  MAX_HTML_SIZE_BYTES,
  MAX_ZIP_SIZE_BYTES,
  REPORT_DESCRIPTION_MAX,
  UpdateReportRequestSchema,
  buildDocumentTokens,
  tokenizeQuery,
  toPublicReport,
} from "@hrb/shared";
import type {
  CreateReportRequest,
  PresignedUpload,
  ReportKind,
  ReportMeta,
  ReportStatus,
  SearchResult,
  UpdateReportRequest,
} from "@hrb/shared";
import { DomainError } from "./errors.ts";
import { generateId } from "./id.ts";
import { contentTypeForPath } from "./content-type.ts";
import { extractHtml } from "./html/extract.ts";
import type {
  AuthUser,
  CdnInvalidator,
  ObjectStorage,
  Page,
  PageOptions,
  ReportFlag,
  ReportRepository,
  SearchIndex,
  SecurityScanner,
  ZipExtractor,
} from "./ports.ts";

export interface AuditInfo {
  sourceIp?: string;
  userAgent?: string;
}

export interface ReportServiceDeps {
  repo: ReportRepository;
  search: SearchIndex;
  storage: ObjectStorage;
  scanner: SecurityScanner;
  cdn: CdnInvalidator;
  /** Absent until @hrb/scanner is wired in; zip completes fail cleanly without it. */
  zipExtractor?: ZipExtractor;
  /** Origin serving uploaded content, e.g. http://localhost:3000 (no trailing slash). */
  contentBaseUrl: string;
  dailyUploadLimit?: number;
  presignedExpirySeconds?: number;
  now?: () => Date;
  newId?: () => string;
}

const EXTRACTED_TEXT_FILENAME = ".extracted.txt";

function parseOrThrow<T>(schema: { parse(value: unknown): T }, value: unknown, what: string): T {
  try {
    return schema.parse(value);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : undefined;
    throw new DomainError("validation_failed", detail ? `invalid ${what}: ${detail}` : `invalid ${what}`);
  }
}

export class ReportService {
  private readonly repo: ReportRepository;
  private readonly searchIndex: SearchIndex;
  private readonly storage: ObjectStorage;
  private readonly scanner: SecurityScanner;
  private readonly cdn: CdnInvalidator;
  private readonly zipExtractor: ZipExtractor | undefined;
  private readonly contentBaseUrl: string;
  private readonly dailyUploadLimit: number;
  private readonly presignedExpirySeconds: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: ReportServiceDeps) {
    this.repo = deps.repo;
    this.searchIndex = deps.search;
    this.storage = deps.storage;
    this.scanner = deps.scanner;
    this.cdn = deps.cdn;
    this.zipExtractor = deps.zipExtractor;
    this.contentBaseUrl = deps.contentBaseUrl.replace(/\/+$/, "");
    this.dailyUploadLimit = deps.dailyUploadLimit ?? DAILY_UPLOAD_LIMIT;
    this.presignedExpirySeconds = deps.presignedExpirySeconds ?? 900;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => generateId());
  }

  // =====================
  // Public reads
  // =====================

  contentUrl(id: string): string {
    return `${this.contentBaseUrl}/r/${id}/`;
  }

  async listPublished(opts?: PageOptions): Promise<Page<ReportMeta>> {
    return this.repo.listPublished(opts);
  }

  /**
   * Visibility: published → anyone; otherwise owner or admin only
   * (non-visible reports surface as not_found, never as forbidden).
   */
  async get(id: string, viewer?: AuthUser | null): Promise<{ report: ReportMeta; url?: string }> {
    const meta = await this.repo.get(id);
    if (!meta) throw new DomainError("not_found", "report not found");
    const visible =
      meta.status === "published" ||
      (viewer != null && (viewer.isAdmin || viewer.sub === meta.ownerSub));
    if (!visible) throw new DomainError("not_found", "report not found");
    if (meta.status === "published") {
      return { report: meta, url: this.contentUrl(id) };
    }
    return { report: meta };
  }

  async search(query: string, limit = 20): Promise<SearchResult[]> {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return [];
    const hits = await this.searchIndex.query(tokens);
    if (hits.length === 0) return [];
    const metas = await this.repo.getMany(hits.map((h) => h.reportId));
    const results: Array<SearchResult & { updatedAt: string }> = [];
    for (const hit of hits) {
      const meta = metas.get(hit.reportId);
      if (!meta || meta.status !== "published") continue;
      results.push({
        report: toPublicReport(meta),
        score: hit.score,
        matchedAll: hit.matchedTokens >= tokens.length,
        updatedAt: meta.updatedAt,
      });
    }
    results.sort((a, b) => {
      if (a.matchedAll !== b.matchedAll) return a.matchedAll ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return results.slice(0, limit).map(({ updatedAt: _u, ...rest }) => rest);
  }

  // =====================
  // Owner operations
  // =====================

  async listMine(user: AuthUser, opts?: PageOptions): Promise<Page<ReportMeta>> {
    return this.repo.listByOwner(user.sub, opts);
  }

  async create(
    user: AuthUser,
    input: { title: string; description?: string; kind: ReportKind },
    audit?: AuditInfo,
  ): Promise<{ report: ReportMeta; upload: PresignedUpload }> {
    const request: CreateReportRequest = parseOrThrow(CreateReportRequestSchema, input, "report");
    await this.consumeUploadQuota(user);

    const id = this.newId();
    const nowIso = this.now().toISOString();
    const meta: ReportMeta = {
      id,
      title: request.title,
      description: request.description,
      ownerSub: user.sub,
      ownerName: user.name,
      status: "processing",
      kind: request.kind,
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      findings: [],
      ...(audit?.sourceIp !== undefined ? { sourceIp: audit.sourceIp } : {}),
      ...(audit?.userAgent !== undefined ? { userAgent: audit.userAgent } : {}),
    };
    await this.repo.create(meta);
    const upload = await this.issuePresigned(id, request.kind);
    return { report: meta, upload };
  }

  /** Presigned upload for overwriting an existing report (owner or admin). */
  async issueUploadUrl(
    user: AuthUser,
    id: string,
    kind: ReportKind,
  ): Promise<{ upload: PresignedUpload }> {
    const meta = await this.mustGet(id);
    this.assertOwnerOrAdmin(user, meta);
    if (meta.status === "takedown" && !user.isAdmin) {
      throw new DomainError("forbidden", "report was taken down by an administrator");
    }
    await this.consumeUploadQuota(user);
    if (meta.kind !== kind) {
      meta.kind = kind;
      await this.repo.update(meta);
    }
    const upload = await this.issuePresigned(id, kind);
    return { upload };
  }

  /**
   * Finish an upload: validate the staged object, extract metadata/text,
   * run the security scan and branch on the verdict:
   *   pass → publish (content copy + .extracted.txt + index)  [url returned]
   *   warn → pending_review (staged object retained for admin approval)
   *   block → rejected (staged sample retained for forensics)
   */
  async complete(
    user: AuthUser,
    id: string,
    key: string,
  ): Promise<{ report: ReportMeta; url?: string }> {
    const meta = await this.mustGet(id);
    this.assertOwnerOrAdmin(user, meta);
    if (meta.status === "takedown" && !user.isAdmin) {
      throw new DomainError("forbidden", "report was taken down by an administrator");
    }
    const expectedKey = await this.repo.getPendingUpload(id);
    if (!expectedKey || expectedKey !== key) {
      throw new DomainError("bad_request", "unknown upload key for this report");
    }
    const data = await this.storage.getStagingObject(key);
    if (!data || data.byteLength === 0) {
      throw new DomainError("upload_incomplete", "no uploaded object found for this key");
    }
    const maxSize = meta.kind === "html" ? MAX_HTML_SIZE_BYTES : MAX_ZIP_SIZE_BYTES;
    if (data.byteLength > maxSize) {
      throw new DomainError("payload_too_large", `upload exceeds ${maxSize} bytes`);
    }

    const nowIso = this.now().toISOString();
    const isOverwrite = meta.sha256 !== undefined;
    const next: ReportMeta = {
      ...meta,
      sha256: createHash("sha256").update(data).digest("hex"),
      sizeBytes: data.byteLength,
      version: isOverwrite ? meta.version + 1 : meta.version,
      updatedAt: nowIso,
    };

    const scan = await this.scanner.scan({ kind: meta.kind, data });
    next.verdict = scan.verdict;
    next.findings = scan.findings;

    if (scan.verdict === "block") {
      // Reject and take any previously published content down.
      // Staged sample is intentionally retained (30-day lifecycle in AWS).
      next.status = "rejected";
      await this.removeFromIndex(id);
      await this.storage.deleteContentPrefix(`reports/${id}/`);
      await this.repo.update(next);
      await this.cdn.invalidate([`/r/${id}/*`]);
      return { report: next };
    }

    if (scan.verdict === "warn") {
      // Hold in staging until an admin approves; previous published content
      // (already scanned) stays live until then.
      next.status = "pending_review";
      await this.repo.update(next);
      return { report: next };
    }

    await this.publishContent(next, data);
    await this.repo.clearPendingUpload(id);
    await this.storage.deleteStagingObject(key);
    return { report: next, url: this.contentUrl(id) };
  }

  async update(user: AuthUser, id: string, patch: UpdateReportRequest): Promise<ReportMeta> {
    const request = parseOrThrow(UpdateReportRequestSchema, patch, "report update");
    const meta = await this.mustGet(id);
    this.assertOwnerOrAdmin(user, meta);
    if (request.title !== undefined) meta.title = request.title;
    if (request.description !== undefined) meta.description = request.description;
    meta.updatedAt = this.now().toISOString();
    await this.repo.update(meta);
    if (meta.status === "published") {
      // Title/description carry index weight — rebuild postings.
      const extracted = await this.storage.getContentObject(
        `reports/${id}/${EXTRACTED_TEXT_FILENAME}`,
      );
      const body = extracted ? new TextDecoder().decode(extracted) : "";
      await this.reindex(meta, body);
    }
    return meta;
  }

  async delete(user: AuthUser, id: string): Promise<void> {
    const meta = await this.mustGet(id);
    this.assertOwnerOrAdmin(user, meta);
    await this.removeFromIndex(id);
    await this.storage.deleteContentPrefix(`reports/${id}/`);
    const pendingKey = await this.repo.getPendingUpload(id);
    if (pendingKey) await this.storage.deleteStagingObject(pendingKey);
    await this.repo.delete(id);
    await this.cdn.invalidate([`/r/${id}/*`]);
  }

  // =====================
  // Abuse flags (unauthenticated, rate limited at the HTTP layer)
  // =====================

  async flag(id: string, reason: string, audit?: AuditInfo): Promise<void> {
    const meta = await this.repo.get(id);
    if (!meta || meta.status !== "published") {
      throw new DomainError("not_found", "report not found");
    }
    const flag: ReportFlag = {
      reason,
      createdAt: this.now().toISOString(),
      ...(audit?.sourceIp !== undefined ? { sourceIp: audit.sourceIp } : {}),
    };
    await this.repo.addFlag(id, flag);
  }

  // =====================
  // Admin operations
  // =====================

  async adminList(
    user: AuthUser,
    opts?: PageOptions & { status?: ReportStatus },
  ): Promise<Page<ReportMeta>> {
    this.assertAdmin(user);
    return this.repo.listAll(opts);
  }

  async adminListFlags(user: AuthUser, id: string): Promise<ReportFlag[]> {
    this.assertAdmin(user);
    return this.repo.listFlags(id);
  }

  /** Publish a pending_review report from its retained staging object. */
  async adminApprove(user: AuthUser, id: string): Promise<ReportMeta> {
    this.assertAdmin(user);
    const meta = await this.mustGet(id);
    if (meta.status !== "pending_review") {
      throw new DomainError("conflict", `report is ${meta.status}, not pending_review`);
    }
    const key = await this.repo.getPendingUpload(id);
    const data = key ? await this.storage.getStagingObject(key) : null;
    if (!key || !data) {
      throw new DomainError("conflict", "staged object for this review no longer exists");
    }
    meta.updatedAt = this.now().toISOString();
    await this.publishContent(meta, data);
    await this.repo.clearPendingUpload(id);
    await this.storage.deleteStagingObject(key);
    return meta;
  }

  /** Reject a pending_review report (staged sample retained). */
  async adminReject(user: AuthUser, id: string): Promise<ReportMeta> {
    this.assertAdmin(user);
    const meta = await this.mustGet(id);
    if (meta.status !== "pending_review") {
      throw new DomainError("conflict", `report is ${meta.status}, not pending_review`);
    }
    meta.status = "rejected";
    meta.updatedAt = this.now().toISOString();
    await this.removeFromIndex(id);
    await this.storage.deleteContentPrefix(`reports/${id}/`);
    await this.repo.update(meta);
    await this.cdn.invalidate([`/r/${id}/*`]);
    return meta;
  }

  /** Unpublish + purge content, keep META for audit. */
  async adminTakedown(user: AuthUser, id: string): Promise<ReportMeta> {
    this.assertAdmin(user);
    const meta = await this.mustGet(id);
    meta.status = "takedown";
    meta.updatedAt = this.now().toISOString();
    await this.removeFromIndex(id);
    await this.storage.deleteContentPrefix(`reports/${id}/`);
    await this.repo.update(meta);
    await this.cdn.invalidate([`/r/${id}/*`]);
    return meta;
  }

  // =====================
  // Internals
  // =====================

  private async mustGet(id: string): Promise<ReportMeta> {
    const meta = await this.repo.get(id);
    if (!meta) throw new DomainError("not_found", "report not found");
    return meta;
  }

  private assertOwnerOrAdmin(user: AuthUser, meta: ReportMeta): void {
    if (user.isAdmin || user.sub === meta.ownerSub) return;
    throw new DomainError("forbidden", "you do not own this report");
  }

  private assertAdmin(user: AuthUser): void {
    if (!user.isAdmin) throw new DomainError("forbidden", "admin privileges required");
  }

  private async consumeUploadQuota(user: AuthUser): Promise<void> {
    const dateKey = this.now().toISOString().slice(0, 10);
    const count = await this.repo.incrementDailyUploads(user.sub, dateKey);
    if (count > this.dailyUploadLimit) {
      throw new DomainError(
        "rate_limited",
        `daily upload limit (${this.dailyUploadLimit}) exceeded`,
      );
    }
  }

  private async issuePresigned(id: string, kind: ReportKind): Promise<PresignedUpload> {
    const key = `staging/${id}/${this.newId()}`;
    const upload = await this.storage.createPresignedUpload({
      key,
      maxSizeBytes: kind === "html" ? MAX_HTML_SIZE_BYTES : MAX_ZIP_SIZE_BYTES,
      expiresInSeconds: this.presignedExpirySeconds,
    });
    await this.repo.setPendingUpload(id, key);
    return upload;
  }

  /** Remove search postings and clear the TOKENS record. */
  private async removeFromIndex(id: string): Promise<void> {
    const oldTokens = await this.repo.getDocumentTokens(id);
    if (oldTokens.length > 0) {
      await this.searchIndex.remove(id, oldTokens);
      await this.repo.putDocumentTokens(id, []);
    }
  }

  private async reindex(meta: ReportMeta, bodyText: string): Promise<void> {
    const oldTokens = await this.repo.getDocumentTokens(meta.id);
    if (oldTokens.length > 0) await this.searchIndex.remove(meta.id, oldTokens);
    const postings = buildDocumentTokens({
      title: meta.title,
      description: meta.description,
      body: bodyText,
    });
    await this.searchIndex.put(meta.id, postings, meta.updatedAt);
    await this.repo.putDocumentTokens(
      meta.id,
      postings.map((p) => p.token),
    );
  }

  /**
   * Write content objects + extracted text, rebuild the search index and mark
   * the report published. Mutates `meta` (status/description) and persists it.
   */
  private async publishContent(meta: ReportMeta, data: Uint8Array): Promise<void> {
    const id = meta.id;
    let files: Array<{ path: string; data: Uint8Array }>;
    let htmlBytes: Uint8Array;

    if (meta.kind === "zip") {
      if (!this.zipExtractor) {
        throw new DomainError("bad_request", "zip uploads are not supported in this deployment");
      }
      const entries = await this.zipExtractor.extract(data);
      const index = entries.find((e) => e.path === "index.html");
      if (!index) {
        throw new DomainError("validation_failed", "zip must contain a root index.html");
      }
      files = entries;
      htmlBytes = index.data;
    } else {
      files = [{ path: "index.html", data }];
      htmlBytes = data;
    }

    const extraction = extractHtml(new TextDecoder().decode(htmlBytes));
    if (meta.description === "" && extraction.description) {
      meta.description = extraction.description.slice(0, REPORT_DESCRIPTION_MAX);
    }

    for (const file of files) {
      await this.storage.putContentObject(
        `reports/${id}/${file.path}`,
        file.data,
        contentTypeForPath(file.path),
      );
    }
    await this.storage.putContentObject(
      `reports/${id}/${EXTRACTED_TEXT_FILENAME}`,
      new TextEncoder().encode(extraction.text),
      "text/plain; charset=utf-8",
    );

    meta.status = "published";
    await this.reindex(meta, extraction.text);
    await this.repo.update(meta);
    await this.cdn.invalidate([`/r/${id}/*`]);
  }
}
