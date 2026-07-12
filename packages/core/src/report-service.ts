/**
 * ReportService — domain logic for the report lifecycle:
 * create (META + presigned upload) → complete (validate → extract → scan →
 * private / rejected) → publish / unpublish (owner-controlled visibility) →
 * list / get / search / update / editContent / delete, version history +
 * rollback, plus admin takedown and abuse flags (通報).
 * Portable (Node 22); no Bun-only APIs.
 */
import { createHash } from "node:crypto";
import {
  CreateReportRequestSchema,
  DAILY_UPLOAD_LIMIT,
  MAX_HTML_SIZE_BYTES,
  MAX_ZIP_SIZE_BYTES,
  REPORT_DESCRIPTION_MAX,
  REPORT_VERSION_HISTORY_LIMIT,
  UpdateReportRequestSchema,
  buildDocumentTokens,
  tokenizeQuery,
  toPublicReport,
} from "@hrb/shared";
import type {
  CreateReportRequest,
  PresignedUpload,
  PublishVisibility,
  ReportKind,
  ReportMeta,
  ReportStatus,
  ReportVersion,
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
  PublishedListOptions,
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

  async listPublished(opts?: PublishedListOptions): Promise<Page<ReportMeta>> {
    return this.repo.listPublished(opts);
  }

  /**
   * Visibility: published / unlisted → anyone; otherwise owner or admin only
   * (non-visible reports surface as not_found, never as forbidden).
   */
  async get(
    id: string,
    viewer?: AuthUser | null,
  ): Promise<{ report: ReportMeta; url?: string; isOwner: boolean }> {
    const meta = await this.repo.get(id);
    if (!meta) throw new DomainError("not_found", "report not found");
    const isOwner = viewer != null && viewer.sub === meta.ownerSub;
    const visible = this.isPubliclyServed(meta.status) || isOwner || (viewer?.isAdmin ?? false);
    if (!visible) throw new DomainError("not_found", "report not found");
    if (this.isPubliclyServed(meta.status)) {
      return { report: meta, url: this.contentUrl(id), isOwner };
    }
    return { report: meta, isOwner };
  }

  /**
   * Ranked full-text search over published reports. The full ranking is
   * recomputed per call and paginated with an offset cursor (same style as
   * adminListFlagged; the recompute cost is acceptable at local scale).
   */
  async search(
    query: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ results: SearchResult[]; nextCursor?: string }> {
    const limit = opts?.limit ?? 20;
    const offset = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    if (Number.isNaN(offset) || offset < 0) {
      throw new DomainError("bad_request", "invalid cursor");
    }
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return { results: [] };
    const hits = await this.searchIndex.query(tokens);
    if (hits.length === 0) return { results: [] };
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
    const page = results
      .slice(offset, offset + limit)
      .map(({ updatedAt: _u, ...rest }) => rest);
    const next = offset + limit;
    return next < results.length
      ? { results: page, nextCursor: String(next) }
      : { results: page };
  }

  // =====================
  // Owner operations
  // =====================

  async listMine(user: AuthUser, opts?: PageOptions): Promise<Page<ReportMeta>> {
    return this.repo.listByOwner(user.sub, opts);
  }

  /** Daily upload quota status for the caller (GET /me/quota). */
  async getUploadQuota(
    user: AuthUser,
  ): Promise<{ dailyUploadLimit: number; usedToday: number; remaining: number }> {
    const count = await this.repo.getDailyUploads(user.sub, this.quotaDateKey());
    // ローカルアダプタは上限超過分もカウントするため上限に丸める。
    const usedToday = Math.min(count, this.dailyUploadLimit);
    return {
      dailyUploadLimit: this.dailyUploadLimit,
      usedToday,
      remaining: this.dailyUploadLimit - usedToday,
    };
  }

  async create(
    user: AuthUser,
    input: { title: string; description?: string; tags?: string[]; kind: ReportKind },
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
      tags: request.tags,
      ownerSub: user.sub,
      ownerName: user.name,
      status: "private",
      kind: request.kind,
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      findings: [],
      versions: [],
      ...(audit?.sourceIp !== undefined ? { sourceIp: audit.sourceIp } : {}),
      ...(audit?.userAgent !== undefined ? { userAgent: audit.userAgent } : {}),
    };
    await this.repo.create(meta);
    const upload = await this.issuePresigned(id, request.kind);
    return { report: meta, upload };
  }

  /**
   * One-shot HTML upload without the presigned/staging round-trip (MCP の
   * upload_report 用): create META + ingest the bytes directly. The full scan
   * pipeline runs exactly like a normal complete — block → rejected, pass /
   * warn → private. Counts against the daily upload quota.
   */
  async createFromHtml(
    user: AuthUser,
    input: { title: string; description?: string; tags?: string[]; html: string },
    audit?: AuditInfo,
  ): Promise<{ report: ReportMeta; url?: string }> {
    const request: CreateReportRequest = parseOrThrow(
      CreateReportRequestSchema,
      { title: input.title, description: input.description, tags: input.tags, kind: "html" },
      "report",
    );
    const data = new TextEncoder().encode(input.html);
    if (data.byteLength === 0) {
      throw new DomainError("validation_failed", "html must not be empty");
    }
    if (data.byteLength > MAX_HTML_SIZE_BYTES) {
      throw new DomainError("payload_too_large", `content exceeds ${MAX_HTML_SIZE_BYTES} bytes`);
    }
    await this.consumeUploadQuota(user);

    const id = this.newId();
    const nowIso = this.now().toISOString();
    const meta: ReportMeta = {
      id,
      title: request.title,
      description: request.description,
      tags: request.tags,
      ownerSub: user.sub,
      ownerName: user.name,
      status: "private",
      kind: "html",
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      findings: [],
      versions: [],
      ...(audit?.sourceIp !== undefined ? { sourceIp: audit.sourceIp } : {}),
      ...(audit?.userAgent !== undefined ? { userAgent: audit.userAgent } : {}),
    };
    await this.repo.create(meta);
    return this.ingest(meta, data);
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
   * Finish an upload: validate the staged object, run the security scan and
   * branch on the verdict:
   *   block       → rejected (content + source purged; staged sample retained)
   *   pass / warn → source stored; a published report is re-published in
   *                 place, anything else lands (or stays) private until the
   *                 owner publishes it explicitly
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

    const result = await this.ingest(meta, data);
    await this.repo.clearPendingUpload(id);
    if (result.report.status !== "rejected") {
      // Staged sample of a blocked upload is intentionally retained
      // (30-day lifecycle in AWS).
      await this.storage.deleteStagingObject(key);
    }
    return result;
  }

  /**
   * Make a private report publicly viewable (owner or admin). Idempotent.
   * visibility: published = 一覧・検索に表示 / unlisted = URL を知る人のみ
   * （一覧・検索インデックスには載せない）。published⇔unlisted の切替も
   * 再呼び出しで行う（コンテンツは配信済みなのでインデックスだけ遷移）。
   */
  async publish(
    user: AuthUser,
    id: string,
    opts?: { visibility?: PublishVisibility },
  ): Promise<{ report: ReportMeta; url: string }> {
    const visibility = opts?.visibility ?? "published";
    const meta = await this.mustGet(id);
    this.assertOwnerOrAdmin(user, meta);
    if (meta.status === "takedown" && !user.isAdmin) {
      throw new DomainError("forbidden", "report was taken down by an administrator");
    }
    if (meta.status === visibility) {
      return { report: meta, url: this.contentUrl(id) };
    }
    if (meta.status === "rejected") {
      throw new DomainError(
        "conflict",
        "report was rejected by the security scan; upload a fixed version first",
      );
    }
    if (this.isPubliclyServed(meta.status)) {
      // published ⇔ unlisted: content objects stay as-is; only the search
      // index membership and META change.
      meta.status = visibility;
      meta.updatedAt = this.now().toISOString();
      if (visibility === "published") {
        const extracted = await this.storage.getContentObject(
          `reports/${id}/${EXTRACTED_TEXT_FILENAME}`,
        );
        await this.reindex(meta, extracted ? new TextDecoder().decode(extracted) : "");
      } else {
        await this.removeFromIndex(id);
      }
      await this.repo.update(meta);
      return { report: meta, url: this.contentUrl(id) };
    }
    const data = await this.loadSource(meta);
    if (!data) {
      throw new DomainError("conflict", "report has no publishable content; upload it first");
    }
    const { files, extraction } = await this.extractFiles(meta.kind, data);
    meta.updatedAt = this.now().toISOString();
    await this.writePublic(meta, files, extraction.text, visibility);
    return { report: meta, url: this.contentUrl(id) };
  }

  /**
   * Hide a published / unlisted report (owner or admin): removed from list /
   * search / content origin, but META and the editable source are kept.
   * Idempotent.
   */
  async unpublish(user: AuthUser, id: string): Promise<ReportMeta> {
    const meta = await this.mustGet(id);
    this.assertOwnerOrAdmin(user, meta);
    if (meta.status === "takedown" && !user.isAdmin) {
      throw new DomainError("forbidden", "report was taken down by an administrator");
    }
    if (meta.status === "private") return meta;
    if (!this.isPubliclyServed(meta.status)) {
      throw new DomainError("conflict", `report is ${meta.status}, not published`);
    }
    // Legacy reports: the public copy may be the only remaining bytes —
    // rescue it into sources/ before it is deleted below.
    await this.loadSource(meta);
    await this.removeFromIndex(id);
    await this.storage.deleteContentPrefix(`reports/${id}/`);
    meta.status = "private";
    meta.updatedAt = this.now().toISOString();
    await this.repo.update(meta);
    await this.cdn.invalidate([`/r/${id}/*`]);
    return meta;
  }

  /**
   * Source HTML for the owner's editor / private preview (owner or admin).
   * html kind → the uploaded source; zip kind → the extracted root index.html.
   */
  async getSource(user: AuthUser, id: string): Promise<{ kind: ReportKind; html: string }> {
    const meta = await this.mustGet(id);
    this.assertOwnerOrAdmin(user, meta);
    if (meta.status === "takedown" && !user.isAdmin) {
      throw new DomainError("forbidden", "report was taken down by an administrator");
    }
    const data = await this.loadSource(meta);
    if (!data) throw new DomainError("not_found", "report has no stored content");
    if (meta.kind === "html") {
      return { kind: "html", html: new TextDecoder().decode(data) };
    }
    const { files } = await this.extractFiles("zip", data);
    const index = files.find((f) => f.path === "index.html");
    return { kind: "zip", html: new TextDecoder().decode(index?.data ?? new Uint8Array()) };
  }

  /**
   * Direct HTML edit (html kind only). Runs the full scan pipeline exactly
   * like an overwrite upload (counts against the daily upload quota).
   */
  async editContent(
    user: AuthUser,
    id: string,
    html: string,
  ): Promise<{ report: ReportMeta; url?: string }> {
    const meta = await this.mustGet(id);
    this.assertOwnerOrAdmin(user, meta);
    if (meta.status === "takedown" && !user.isAdmin) {
      throw new DomainError("forbidden", "report was taken down by an administrator");
    }
    if (meta.kind !== "html") {
      throw new DomainError("bad_request", "direct editing is only available for html reports");
    }
    if (meta.sha256 === undefined) {
      throw new DomainError("conflict", "report has no uploaded content to edit yet");
    }
    const data = new TextEncoder().encode(html);
    if (data.byteLength > MAX_HTML_SIZE_BYTES) {
      throw new DomainError("payload_too_large", `content exceeds ${MAX_HTML_SIZE_BYTES} bytes`);
    }
    await this.consumeUploadQuota(user);
    return this.ingest(meta, data);
  }

  /** バージョン履歴（owner or admin）。新しい版が先頭。 */
  async listVersions(user: AuthUser, id: string): Promise<ReportVersion[]> {
    const meta = await this.mustGet(id);
    this.assertOwnerOrAdmin(user, meta);
    if (meta.status === "takedown" && !user.isAdmin) {
      throw new DomainError("forbidden", "report was taken down by an administrator");
    }
    return [...(meta.versions ?? [])].reverse();
  }

  /**
   * 旧版の HTML（owner or admin）。getSource と同じ形:
   * html kind → 保存された原本、zip kind → 展開した root index.html。
   */
  async getVersionSource(
    user: AuthUser,
    id: string,
    version: number,
  ): Promise<{ kind: ReportKind; html: string }> {
    const meta = await this.mustGet(id);
    this.assertOwnerOrAdmin(user, meta);
    if (meta.status === "takedown" && !user.isAdmin) {
      throw new DomainError("forbidden", "report was taken down by an administrator");
    }
    const entry = (meta.versions ?? []).find((v) => v.version === version);
    if (!entry) throw new DomainError("not_found", "version not found");
    const data = await this.storage.getContentObject(this.versionKey(id, version));
    if (!data) throw new DomainError("not_found", "version content not found");
    if (entry.kind === "html") {
      return { kind: "html", html: new TextDecoder().decode(data) };
    }
    const { files } = await this.extractFiles("zip", data);
    const index = files.find((f) => f.path === "index.html");
    return { kind: "zip", html: new TextDecoder().decode(index?.data ?? new Uint8Array()) };
  }

  /**
   * 旧版の原本を editContent と同じパスで再取り込み（owner or admin）:
   * フルスキャン再実行・新しい version として履歴に積む。zip 版も原本
   * （zip バイト列）をそのまま再取り込みする。日次クォータを消費する。
   */
  async rollback(
    user: AuthUser,
    id: string,
    version: number,
  ): Promise<{ report: ReportMeta; url?: string }> {
    const meta = await this.mustGet(id);
    this.assertOwnerOrAdmin(user, meta);
    if (meta.status === "takedown" && !user.isAdmin) {
      throw new DomainError("forbidden", "report was taken down by an administrator");
    }
    const entry = (meta.versions ?? []).find((v) => v.version === version);
    if (!entry) throw new DomainError("not_found", "version not found");
    const data = await this.storage.getContentObject(this.versionKey(id, version));
    if (!data) throw new DomainError("not_found", "version content not found");
    await this.consumeUploadQuota(user);
    // kind は取り込み時点の値で復元する（zip 原本を html として扱わない）。
    const target: ReportMeta = { ...meta, kind: entry.kind };
    return this.ingest(target, data);
  }

  async update(user: AuthUser, id: string, patch: UpdateReportRequest): Promise<ReportMeta> {
    const request = parseOrThrow(UpdateReportRequestSchema, patch, "report update");
    const meta = await this.mustGet(id);
    this.assertOwnerOrAdmin(user, meta);
    if (request.title !== undefined) meta.title = request.title;
    if (request.description !== undefined) meta.description = request.description;
    if (request.tags !== undefined) meta.tags = request.tags;
    meta.updatedAt = this.now().toISOString();
    await this.repo.update(meta);
    if (meta.status === "published") {
      // Title/description/tags carry index weight — rebuild postings.
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
    await this.purge(id);
  }

  /**
   * Admin: deletes every report owned by ownerSub (user-deletion cascade).
   * Returns the number of deleted reports.
   */
  async adminDeleteByOwner(user: AuthUser, ownerSub: string): Promise<number> {
    this.assertAdmin(user);
    let deleted = 0;
    // purge() removes items from the listing, so always re-fetch the first page.
    for (;;) {
      const page = await this.repo.listByOwner(ownerSub, { limit: 100 });
      if (page.items.length === 0) return deleted;
      for (const meta of page.items) {
        await this.purge(meta.id);
        deleted += 1;
      }
    }
  }

  /** Removes index entries, stored objects, pending staging and META for id. */
  private async purge(id: string): Promise<void> {
    await this.removeFromIndex(id);
    await this.storage.deleteContentPrefix(`reports/${id}/`);
    await this.storage.deleteContentPrefix(`sources/${id}/`);
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
    // unlisted も URL を知っていれば閲覧できるため通報対象。
    if (!meta || !this.isPubliclyServed(meta.status)) {
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

  /** 通報一覧: reports that received abuse flags, newest flag first. */
  async adminListFlagged(
    user: AuthUser,
    opts?: PageOptions,
  ): Promise<Page<{ report: ReportMeta; flags: ReportFlag[] }>> {
    this.assertAdmin(user);
    const flagged = await this.repo.listFlagged();
    const metas = await this.repo.getMany(flagged.map((f) => f.id));
    const items = flagged.flatMap(({ id, flags }) => {
      const report = metas.get(id);
      return report && flags.length > 0 ? [{ report, flags }] : [];
    });
    const latest = (flags: ReportFlag[]) =>
      flags.reduce((max, f) => (f.createdAt > max ? f.createdAt : max), "");
    items.sort((a, b) => latest(b.flags).localeCompare(latest(a.flags)));
    // repo.listFlagged() は全件返すので、ソート後にオフセット cursor でページングする。
    const limit = opts?.limit ?? 50;
    const offset = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    if (Number.isNaN(offset) || offset < 0) {
      throw new DomainError("bad_request", "invalid cursor");
    }
    const page = items.slice(offset, offset + limit);
    const next = offset + limit;
    return next < items.length ? { items: page, nextCursor: String(next) } : { items: page };
  }

  /** Resolve a report's flags (通報を処理済みにする). */
  async adminClearFlags(user: AuthUser, id: string): Promise<void> {
    this.assertAdmin(user);
    await this.repo.clearFlags(id);
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

  /** published / unlisted — content is served to anyone who has the URL. */
  private isPubliclyServed(status: ReportStatus): status is PublishVisibility {
    return status === "published" || status === "unlisted";
  }

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

  /** UTC YYYY-MM-DD — increment と残数読み取りで必ず同じ境界を使う。 */
  private quotaDateKey(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private async consumeUploadQuota(user: AuthUser): Promise<void> {
    const count = await this.repo.incrementDailyUploads(user.sub, this.quotaDateKey());
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
      // tags を持たない既存データは空として扱う（後方互換）。
      tags: meta.tags ?? [],
      body: bodyText,
    });
    await this.searchIndex.put(meta.id, postings, meta.updatedAt);
    await this.repo.putDocumentTokens(
      meta.id,
      postings.map((p) => p.token),
    );
  }

  /** Storage key of the canonical uploaded bytes (kept while the report exists). */
  private sourceKey(id: string): string {
    return `sources/${id}/current`;
  }

  /** Storage key of one retained version's original bytes. */
  private versionKey(id: string, version: number): string {
    return `sources/${id}/v${version}`;
  }

  /**
   * Canonical uploaded bytes for editing / (re-)publishing. Reports stored
   * before the sources/ prefix existed only have the public copy — recover
   * it (html kind: identical bytes, verified against META's sha256) and
   * backfill sources/ so subsequent reads and unpublish keep working.
   */
  private async loadSource(meta: ReportMeta): Promise<Uint8Array | null> {
    if (meta.sha256 === undefined) return null;
    const stored = await this.storage.getContentObject(this.sourceKey(meta.id));
    if (stored) return stored;
    // Legacy zip originals are not reconstructible from the extracted files.
    if (meta.kind !== "html") return null;
    const published = await this.storage.getContentObject(`reports/${meta.id}/index.html`);
    if (!published) return null;
    if (createHash("sha256").update(published).digest("hex") !== meta.sha256) return null;
    await this.storage.putContentObject(
      this.sourceKey(meta.id),
      published,
      "text/html; charset=utf-8",
    );
    return published;
  }

  /**
   * Scan + store new content bytes and persist the outcome:
   *   block       → rejected (index/content/source purged)
   *   pass / warn → source object replaced; published reports are
   *                 re-published in place, all other statuses become private
   */
  private async ingest(
    meta: ReportMeta,
    data: Uint8Array,
  ): Promise<{ report: ReportMeta; url?: string }> {
    const id = meta.id;
    const isOverwrite = meta.sha256 !== undefined;
    const next: ReportMeta = {
      ...meta,
      sha256: createHash("sha256").update(data).digest("hex"),
      sizeBytes: data.byteLength,
      version: isOverwrite ? meta.version + 1 : meta.version,
      updatedAt: this.now().toISOString(),
      versions: [...(meta.versions ?? [])],
    };

    const scan = await this.scanner.scan({ kind: meta.kind, data });
    next.verdict = scan.verdict;
    next.findings = scan.findings;

    if (scan.verdict === "block") {
      next.status = "rejected";
      // sources/ prefix ごと消えるため、バージョン履歴も空にする。
      next.versions = [];
      await this.removeFromIndex(id);
      await this.storage.deleteContentPrefix(`reports/${id}/`);
      await this.storage.deleteContentPrefix(`sources/${id}/`);
      await this.repo.update(next);
      await this.cdn.invalidate([`/r/${id}/*`]);
      return { report: next };
    }

    // Validates the payload (zip must contain a root index.html) before
    // anything is persisted.
    const { files, extraction } = await this.extractFiles(next.kind, data);
    if (next.description === "" && extraction.description) {
      next.description = extraction.description.slice(0, REPORT_DESCRIPTION_MAX);
    }
    const contentType = next.kind === "html" ? "text/html; charset=utf-8" : "application/zip";
    await this.storage.putContentObject(this.sourceKey(id), data, contentType);
    // バージョン履歴: 原本を sources/<id>/v<version> にも残し、上限超過分は
    // 最古から間引く（メタとオブジェクトの両方）。
    await this.storage.putContentObject(this.versionKey(id, next.version), data, contentType);
    next.versions.push({
      version: next.version,
      kind: next.kind,
      createdAt: next.updatedAt,
      sizeBytes: data.byteLength,
      verdict: scan.verdict,
    });
    while (next.versions.length > REPORT_VERSION_HISTORY_LIMIT) {
      const oldest = next.versions.shift()!;
      await this.storage.deleteContentObject(this.versionKey(id, oldest.version));
    }

    if (this.isPubliclyServed(meta.status)) {
      // 公開中（published / unlisted）の上書きは同じ公開範囲のまま再公開する。
      await this.writePublic(next, files, extraction.text, meta.status);
      return { report: next, url: this.contentUrl(id) };
    }
    next.status = "private";
    await this.repo.update(next);
    return { report: next };
  }

  /** Extract servable files + index text; validates zip structure. */
  private async extractFiles(
    kind: ReportKind,
    data: Uint8Array,
  ): Promise<{
    files: Array<{ path: string; data: Uint8Array }>;
    extraction: ReturnType<typeof extractHtml>;
  }> {
    let files: Array<{ path: string; data: Uint8Array }>;
    let htmlBytes: Uint8Array;
    if (kind === "zip") {
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
    return { files, extraction: extractHtml(new TextDecoder().decode(htmlBytes)) };
  }

  /**
   * Write content objects + extracted text and mark the report published or
   * unlisted. The search index is only rebuilt for published — unlisted is
   * never indexed (removed if it was). Mutates `meta` and persists it.
   */
  private async writePublic(
    meta: ReportMeta,
    files: Array<{ path: string; data: Uint8Array }>,
    bodyText: string,
    visibility: PublishVisibility = "published",
  ): Promise<void> {
    const id = meta.id;
    for (const file of files) {
      await this.storage.putContentObject(
        `reports/${id}/${file.path}`,
        file.data,
        contentTypeForPath(file.path),
      );
    }
    await this.storage.putContentObject(
      `reports/${id}/${EXTRACTED_TEXT_FILENAME}`,
      new TextEncoder().encode(bodyText),
      "text/plain; charset=utf-8",
    );
    meta.status = visibility;
    if (visibility === "published") {
      await this.reindex(meta, bodyText);
    } else {
      await this.removeFromIndex(id);
    }
    await this.repo.update(meta);
    await this.cdn.invalidate([`/r/${id}/*`]);
  }
}
