/**
 * Typed API client for base path /api. Uses @hrb/shared contract types.
 * DOM-free (relies only on global fetch/URLSearchParams) so it can be unit
 * tested under `bun test` with a mocked fetch.
 */
import type {
  AdminClearFlagsResponse,
  AdminListFlagsResponse,
  AdminListFlaggedResponse,
  AdminListReportsResponse,
  AdminDeleteUserResponse,
  AdminListUsersResponse,
  AdminReportActionResponse,
  CompleteReportResponse,
  CreateApiKeyResponse,
  CreateReportRequestInput,
  CreateReportResponse,
  CreateUploadUrlResponse,
  DeleteApiKeyResponse,
  DeleteReportResponse,
  ErrorCode,
  FlagReportResponse,
  GetConfigResponse,
  GetQuotaResponse,
  GetReportResponse,
  GetReportSourceResponse,
  GetReportVersionSourceResponse,
  ListApiKeysResponse,
  ListOrder,
  ListReportsResponse,
  ListReportVersionsResponse,
  MyReportsResponse,
  PublishReportResponse,
  PublishVisibility,
  ReportKind,
  ReportStatus,
  RollbackReportResponse,
  SearchResponse,
  UnpublishReportResponse,
  UpdateReportContentResponse,
  UpdateReportRequest,
  UpdateReportResponse,
} from "@hrb/shared";

export class ApiError extends Error {
  readonly code: ErrorCode | "network";
  readonly status: number;

  constructor(code: ErrorCode | "network", message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Defaults to "/api" (same-origin). */
  baseUrl?: string;
  /** Called per request; returns auth headers (e.g. x-dev-user). */
  getHeaders?: () => Record<string, string>;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchFn?: FetchLike;
}

type Query = Record<string, string | number | undefined>;

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getHeaders: () => Record<string, string>;
  private readonly fetchFn: FetchLike;

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "/api").replace(/\/$/, "");
    this.getHeaders = opts.getHeaders ?? (() => ({}));
    // Wrap so a bare global fetch keeps its expected receiver.
    const f = opts.fetchFn ?? fetch;
    this.fetchFn = (input, init) => f(input, init);
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Query } = {},
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (opts.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    const headers: Record<string, string> = { ...this.getHeaders() };
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await this.fetchFn(url, init);
    } catch {
      throw new ApiError("network", "ネットワークエラーが発生しました", 0);
    }
    if (!res.ok) {
      let code: ErrorCode | "network" = "internal" as ErrorCode;
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        if (body?.error?.code) code = body.error.code as ErrorCode;
        if (body?.error?.message) message = body.error.message;
      } catch {
        // non-JSON error body; keep fallback
      }
      throw new ApiError(code, message, res.status);
    }
    return (await res.json()) as T;
  }

  // ---- public ----

  getConfig(): Promise<GetConfigResponse> {
    return this.request("GET", "/config");
  }

  listReports(
    opts: { order?: ListOrder; kind?: ReportKind; tag?: string; limit?: number; cursor?: string } = {},
  ): Promise<ListReportsResponse> {
    return this.request("GET", "/reports", {
      query: {
        order: opts.order,
        kind: opts.kind,
        tag: opts.tag,
        limit: opts.limit,
        cursor: opts.cursor,
      },
    });
  }

  search(q: string, opts: { limit?: number; cursor?: string } = {}): Promise<SearchResponse> {
    return this.request("GET", "/search", {
      query: { q, limit: opts.limit, cursor: opts.cursor },
    });
  }

  getReport(id: string): Promise<GetReportResponse> {
    return this.request("GET", `/reports/${encodeURIComponent(id)}`);
  }

  flagReport(id: string, reason: string): Promise<FlagReportResponse> {
    return this.request("POST", `/reports/${encodeURIComponent(id)}/flag`, { body: { reason } });
  }

  // ---- authenticated ----

  myReports(opts: { limit?: number; cursor?: string } = {}): Promise<MyReportsResponse> {
    return this.request("GET", "/me/reports", { query: { limit: opts.limit, cursor: opts.cursor } });
  }

  /** 日次アップロード残数（本日あと何件アップロードできるか）。 */
  myQuota(): Promise<GetQuotaResponse> {
    return this.request("GET", "/me/quota");
  }

  createReport(req: CreateReportRequestInput): Promise<CreateReportResponse> {
    return this.request("POST", "/reports", { body: req });
  }

  createUploadUrl(id: string, kind: ReportKind): Promise<CreateUploadUrlResponse> {
    return this.request("POST", `/reports/${encodeURIComponent(id)}/upload-url`, {
      body: { kind },
    });
  }

  completeReport(id: string, key: string): Promise<CompleteReportResponse> {
    return this.request("POST", `/reports/${encodeURIComponent(id)}/complete`, { body: { key } });
  }

  updateReport(id: string, patch: UpdateReportRequest): Promise<UpdateReportResponse> {
    return this.request("PATCH", `/reports/${encodeURIComponent(id)}`, { body: patch });
  }

  /** 公開（visibility 省略時は published）。published⇔unlisted の切替も再呼び出しで行う。 */
  publishReport(id: string, visibility: PublishVisibility = "published"): Promise<PublishReportResponse> {
    return this.request("POST", `/reports/${encodeURIComponent(id)}/publish`, {
      body: { visibility },
    });
  }

  unpublishReport(id: string): Promise<UnpublishReportResponse> {
    return this.request("POST", `/reports/${encodeURIComponent(id)}/unpublish`);
  }

  /** Source HTML for the owner's editor / private preview. */
  getReportSource(id: string): Promise<GetReportSourceResponse> {
    return this.request("GET", `/reports/${encodeURIComponent(id)}/source`);
  }

  /** Direct HTML edit (html kind only). Triggers a full re-scan server-side. */
  updateReportContent(id: string, html: string): Promise<UpdateReportContentResponse> {
    return this.request("PUT", `/reports/${encodeURIComponent(id)}/content`, {
      body: { html },
    });
  }

  /** バージョン履歴（owner/admin のみ、新しい順）。 */
  listReportVersions(id: string): Promise<ListReportVersionsResponse> {
    return this.request("GET", `/reports/${encodeURIComponent(id)}/versions`);
  }

  /** 旧版の HTML（owner/admin のみ）。 */
  getReportVersionSource(id: string, version: number): Promise<GetReportVersionSourceResponse> {
    return this.request(
      "GET",
      `/reports/${encodeURIComponent(id)}/versions/${encodeURIComponent(String(version))}/source`,
    );
  }

  /** 旧版を新しい版として復元（サーバー側でフルスキャン再実行）。 */
  rollbackReport(id: string, version: number): Promise<RollbackReportResponse> {
    return this.request("POST", `/reports/${encodeURIComponent(id)}/rollback`, {
      body: { version },
    });
  }

  deleteReport(id: string): Promise<DeleteReportResponse> {
    return this.request("DELETE", `/reports/${encodeURIComponent(id)}`);
  }

  // ---- API キー（MCP 等のプログラマティックアクセス用） ----

  listApiKeys(): Promise<ListApiKeysResponse> {
    return this.request("GET", "/me/api-keys");
  }

  /** 発行。plaintext はこのレスポンス限り（以後取得できない）。 */
  createApiKey(name: string): Promise<CreateApiKeyResponse> {
    return this.request("POST", "/me/api-keys", { body: { name } });
  }

  deleteApiKey(keyId: string): Promise<DeleteApiKeyResponse> {
    return this.request("DELETE", `/me/api-keys/${encodeURIComponent(keyId)}`);
  }

  // ---- admin ----

  adminListReports(
    opts: { status?: ReportStatus; limit?: number; cursor?: string } = {},
  ): Promise<AdminListReportsResponse> {
    return this.request("GET", "/admin/reports", {
      query: { status: opts.status, limit: opts.limit, cursor: opts.cursor },
    });
  }

  adminListFlagged(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<AdminListFlaggedResponse> {
    return this.request("GET", "/admin/flagged", {
      query: { limit: opts.limit, cursor: opts.cursor },
    });
  }

  adminListFlags(id: string): Promise<AdminListFlagsResponse> {
    return this.request("GET", `/admin/reports/${encodeURIComponent(id)}/flags`);
  }

  adminClearFlags(id: string): Promise<AdminClearFlagsResponse> {
    return this.request("DELETE", `/admin/reports/${encodeURIComponent(id)}/flags`);
  }

  adminTakedown(id: string): Promise<AdminReportActionResponse> {
    return this.request("POST", `/admin/reports/${encodeURIComponent(id)}/takedown`);
  }

  adminListUsers(opts: { limit?: number; cursor?: string } = {}): Promise<AdminListUsersResponse> {
    return this.request("GET", "/admin/users", {
      query: { limit: opts.limit, cursor: opts.cursor },
    });
  }

  adminSetAdmin(username: string, isAdmin: boolean): Promise<{ ok: true }> {
    return this.request(
      isAdmin ? "PUT" : "DELETE",
      `/admin/users/${encodeURIComponent(username)}/admin`,
    );
  }

  adminDeleteUser(username: string): Promise<AdminDeleteUserResponse> {
    return this.request("DELETE", `/admin/users/${encodeURIComponent(username)}`);
  }
}
