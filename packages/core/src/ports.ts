/**
 * @hrb/core ports — interfaces implemented by local adapters (src/local/, Bun OK)
 * and AWS adapters (added in S6). This file must stay portable (Node 22).
 */
import type {
  AdminUser,
  AuthConfig,
  PresignedUpload,
  ReportFlag,
  ReportKind,
  ReportMeta,
  ReportStatus,
  ScanFinding,
  ScanVerdict,
} from "@hrb/shared";

// ---- Auth ----

export interface AuthUser {
  /** Cognito sub (or dev user id in local mode). */
  sub: string;
  /** Display name denormalized onto reports at upload time. */
  name: string;
  isAdmin: boolean;
}

export interface AuthVerifier {
  /**
   * Verify request credentials. `headers` uses lower-cased header names.
   * Returns null when unauthenticated (routes decide whether that is fatal).
   */
  verify(headers: Record<string, string | undefined>): Promise<AuthUser | null>;
  /** Client auth bootstrap info for GET /config. */
  authConfig(): AuthConfig;
}

// ---- Pagination ----

export interface PageOptions {
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

// ---- Repository ----

export type { ReportFlag };

export interface ReportRepository {
  /** Throws DomainError("conflict") when the id already exists. */
  create(meta: ReportMeta): Promise<void>;
  get(id: string): Promise<ReportMeta | null>;
  getMany(ids: readonly string[]): Promise<Map<string, ReportMeta>>;
  update(meta: ReportMeta): Promise<void>;
  /** Removes META, TOKENS, pending-upload pointer and flags for the id. */
  delete(id: string): Promise<void>;
  /** status=published only, updatedAt descending. */
  listPublished(opts?: PageOptions): Promise<Page<ReportMeta>>;
  /** All statuses for one owner, updatedAt descending. */
  listByOwner(ownerSub: string, opts?: PageOptions): Promise<Page<ReportMeta>>;
  /** Admin: all reports, optional status filter, updatedAt descending. */
  listAll(opts?: PageOptions & { status?: ReportStatus }): Promise<Page<ReportMeta>>;
  /** Tokens registered in the search index for this document (TOKENS item). */
  getDocumentTokens(id: string): Promise<string[]>;
  putDocumentTokens(id: string, tokens: readonly string[]): Promise<void>;
  /** Staging key of the latest issued upload (consumed by complete/approve). */
  setPendingUpload(id: string, stagingKey: string): Promise<void>;
  getPendingUpload(id: string): Promise<string | null>;
  clearPendingUpload(id: string): Promise<void>;
  /** Returns the post-increment upload count for ownerSub on dateKey (UTC YYYY-MM-DD). */
  incrementDailyUploads(ownerSub: string, dateKey: string): Promise<number>;
  addFlag(id: string, flag: ReportFlag): Promise<void>;
  listFlags(id: string): Promise<ReportFlag[]>;
  /** Every report id that currently has at least one flag (admin 通報一覧). */
  listFlagged(): Promise<Array<{ id: string; flags: ReportFlag[] }>>;
  /** Resolve a report's flags (admin marks the通報 handled). */
  clearFlags(id: string): Promise<void>;
}

// ---- Search index ----

export interface Posting {
  token: string;
  weight: number;
}

export interface SearchHit {
  reportId: string;
  /** Sum of matched posting weights. */
  score: number;
  /** Number of distinct query tokens that matched this document. */
  matchedTokens: number;
  updatedAt: string;
}

export interface SearchIndex {
  put(reportId: string, postings: readonly Posting[], updatedAt: string): Promise<void>;
  remove(reportId: string, tokens: readonly string[]): Promise<void>;
  /** Aggregated hits across tokens (one entry per reportId). Order unspecified. */
  query(tokens: readonly string[]): Promise<SearchHit[]>;
}

// ---- Object storage ----

export interface ObjectStorage {
  /** Presigned POST against the staging area (size enforced via content-length-range). */
  createPresignedUpload(opts: {
    key: string;
    maxSizeBytes: number;
    expiresInSeconds?: number;
  }): Promise<PresignedUpload>;
  getStagingObject(key: string): Promise<Uint8Array | null>;
  deleteStagingObject(key: string): Promise<void>;
  putContentObject(key: string, data: Uint8Array, contentType: string): Promise<void>;
  getContentObject(key: string): Promise<Uint8Array | null>;
  /** Delete every content object whose key starts with `prefix`. */
  deleteContentPrefix(prefix: string): Promise<void>;
}

// ---- CDN ----

export interface CdnInvalidator {
  invalidate(paths: readonly string[]): Promise<void>;
}

// ---- User admin (Cognito adapter / local stub) ----

export interface UserAdmin {
  listUsers(opts?: PageOptions): Promise<Page<AdminUser>>;
  setAdmin(username: string, isAdmin: boolean): Promise<void>;
  /** Stable subject id (= ReportMeta.ownerSub) for the user, or null if unknown. */
  getUserSub(username: string): Promise<string | null>;
  /** Deletes the account. Throws DomainError("not_found") for unknown users. */
  deleteUser(username: string): Promise<void>;
}

// ---- Security scanner (implemented by @hrb/scanner in S2.5) ----

export interface ScanInput {
  kind: ReportKind;
  data: Uint8Array;
  filename?: string;
}

export interface ScanResult {
  verdict: ScanVerdict;
  findings: ScanFinding[];
}

export interface SecurityScanner {
  scan(input: ScanInput): Promise<ScanResult>;
}

// ---- Domain reputation (URLhaus/OpenPhish feed; local stub) ----

export interface DomainReputation {
  isMalicious(host: string): Promise<boolean>;
}

// ---- Zip extraction (implemented by @hrb/scanner with yauzl; guarded against
//      zip-slip / zip bombs). Optional dependency of ReportService. ----

export interface ZipEntryFile {
  /** Normalized relative path inside the archive (e.g. "index.html", "assets/app.css"). */
  path: string;
  data: Uint8Array;
}

export interface ZipExtractor {
  extract(data: Uint8Array): Promise<ZipEntryFile[]>;
}
