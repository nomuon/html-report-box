/**
 * @hrb/core ports — interfaces implemented by local adapters (src/local/, Bun OK)
 * and AWS adapters (added in S6). This file must stay portable (Node 22).
 */
import type {
  AdminUser,
  ApiKey,
  AuthConfig,
  ListOrder,
  PresignedUpload,
  ReportFlag,
  ReportKind,
  ReportMeta,
  ReportStatus,
  ScanFinding,
  ScanVerdict,
  SessionUser,
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

/**
 * Session login/logout for auth modes where the app issues its own session
 * tokens (google mode). Absent in Cognito mode (Hosted UI owns the session).
 */
export interface SessionAuth {
  /** Verifies a Google ID token, provisions the user on first login, returns a session. */
  loginWithGoogle(credential: string): Promise<{ token: string; user: SessionUser }>;
  /** Revokes the session token. Unknown tokens are a no-op. */
  logout(token: string): Promise<void>;
}

// ---- Per-user API keys (MCP 等のプログラマティックアクセス) ----

/** Key owner captured at issue time (name is denormalized like ReportMeta.ownerName). */
export interface ApiKeyOwner {
  sub: string;
  name: string;
}

/** verify() resolution: which user a presented plaintext key belongs to. */
export interface VerifiedApiKey {
  ownerSub: string;
  ownerName: string;
  keyId: string;
}

/**
 * Per-user API key store. Only the sha256 hash of a key is persisted; the
 * plaintext is returned exactly once from issue().
 */
export interface ApiKeyStore {
  issue(owner: ApiKeyOwner, name: string): Promise<{ key: ApiKey; plaintext: string }>;
  /** Keys of one owner, newest first (metadata only — never the plaintext/hash). */
  list(ownerSub: string): Promise<ApiKey[]>;
  /** Throws DomainError("not_found") when the owner has no such key. */
  revoke(ownerSub: string, keyId: string): Promise<void>;
  /**
   * Resolve a plaintext key to its owner (hash equality), or null when
   * unknown/revoked. Updates lastUsedAt best-effort.
   */
  verify(plaintext: string): Promise<VerifiedApiKey | null>;
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

/** Options for the public published list: sort order + kind / tag filters. */
export interface PublishedListOptions extends PageOptions {
  /** updatedAt sort order (default "desc" = newest first). */
  order?: ListOrder;
  /** Restrict results to one report kind. */
  kind?: ReportKind;
  /** Restrict results to reports carrying this exact tag. */
  tag?: string;
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
  /** status=published only, updatedAt ordered (default descending), optional kind filter. */
  listPublished(opts?: PublishedListOptions): Promise<Page<ReportMeta>>;
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
  /** Current upload count for ownerSub on dateKey (0 when nothing was uploaded). */
  getDailyUploads(ownerSub: string, dateKey: string): Promise<number>;
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
  /**
   * Presigned upload against the staging area. Returns a presigned POST (S3;
   * size enforced via content-length-range) or a presigned PUT (R2 等、POST
   * 非対応)。返却形は PresignedUpload.method で判別する。
   */
  createPresignedUpload(opts: {
    key: string;
    maxSizeBytes: number;
    expiresInSeconds?: number;
  }): Promise<PresignedUpload>;
  getStagingObject(key: string): Promise<Uint8Array | null>;
  deleteStagingObject(key: string): Promise<void>;
  putContentObject(key: string, data: Uint8Array, contentType: string): Promise<void>;
  getContentObject(key: string): Promise<Uint8Array | null>;
  /** Delete a single content object. Missing keys are a no-op. */
  deleteContentObject(key: string): Promise<void>;
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
