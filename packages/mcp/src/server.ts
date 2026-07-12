/**
 * MCP server factory — registers the read tools (search_reports / get_report /
 * list_recent_reports) and, for callers authenticated with a per-user API key,
 * the write tools (upload_report / publish_report / unpublish_report) against
 * a ReportService. Anonymous callers (static key / dev keyless) stay read-only.
 *
 * Stateless Streamable HTTP mode: the HTTP layer (index.ts) resolves the
 * caller per request and builds a fresh McpServer via this factory.
 * Portable (Node 22); no Bun APIs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  REPORT_DESCRIPTION_MAX,
  REPORT_TAG_MAX,
  REPORT_TAGS_MAX,
  REPORT_TITLE_MAX,
  SEARCH_QUERY_MAX,
  toPublicReport,
} from "@hrb/shared";
import { DomainError, isDomainError } from "@hrb/core";
import type { ApiKeyStore, AuthUser, ObjectStorage, ReportService } from "@hrb/core";

export interface McpContext {
  reportService: ReportService;
  /** Used to read the pre-extracted text at reports/<id>/.extracted.txt. */
  objectStorage: ObjectStorage;
  /** Per-user API key verification. Absent → only anonymous (read-only) access. */
  apiKeys?: ApiKeyStore;
  /** App origin for share URLs (/reports/:id), e.g. http://localhost:3000. */
  appBaseUrl?: string;
}

/** Caller identity resolved by the HTTP layer (null = anonymous read-only). */
export interface McpAuth {
  user: AuthUser | null;
}

export const MCP_SERVER_NAME = "html-report-box";
export const MCP_SERVER_VERSION = "0.1.0";

const EXTRACTED_TEXT_KEY = (id: string) => `reports/${id}/.extracted.txt`;
/** Cap the text payload returned to MCP clients (chars, not bytes). */
export const MAX_EXTRACTED_TEXT_CHARS = 100_000;

const DEFAULT_LIMIT = 20;

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** DomainError → isError tool response; anything else propagates. */
async function runTool(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (isDomainError(err)) return errorResult(`${err.code}: ${err.message}`);
    throw err;
  }
}

export function buildMcpServer(ctx: McpContext, auth: McpAuth = { user: null }): McpServer {
  const { reportService, objectStorage } = ctx;
  const user = auth.user;
  const appUrl = (id: string) => `${(ctx.appBaseUrl ?? "").replace(/\/+$/, "")}/reports/${id}`;
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  /** Write tools require a per-user API key; static-key/keyless callers are read-only. */
  const mustUser = (): AuthUser => {
    if (!user) {
      throw new DomainError(
        "unauthorized",
        "this tool requires a per-user API key (Authorization: Bearer hrb_...); " +
          "issue one from the マイレポート page",
      );
    }
    return user;
  };

  server.registerTool(
    "search_reports",
    {
      title: "Search reports",
      description:
        "Full-text search over published HTML reports (Japanese and English). " +
        "Returns metadata and share URLs ordered by relevance.",
      inputSchema: {
        query: z.string().min(1).max(SEARCH_QUERY_MAX).describe("Search query text"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(`Maximum number of results (default ${DEFAULT_LIMIT})`),
      },
    },
    async ({ query, limit }) => {
      const { results } = await reportService.search(query, { limit: limit ?? DEFAULT_LIMIT });
      return jsonResult({
        results: results.map((r) => ({
          id: r.report.id,
          title: r.report.title,
          description: r.report.description,
          tags: r.report.tags,
          ownerName: r.report.ownerName,
          kind: r.report.kind,
          updatedAt: r.report.updatedAt,
          url: reportService.contentUrl(r.report.id),
          score: r.score,
          matchedAll: r.matchedAll,
        })),
      });
    },
  );

  server.registerTool(
    "get_report",
    {
      title: "Get report",
      description:
        "Fetch one report by id: metadata, share URL and the extracted plain " +
        "text of its HTML content. Anonymous callers see published reports " +
        "only; with a per-user API key your own private reports are visible too.",
      inputSchema: {
        id: z.string().min(1).describe("Report id (from search_reports / list_recent_reports)"),
      },
    },
    async ({ id }) =>
      runTool(async () => {
        // Anonymous → published only; per-user key → owner's own reports too.
        const { report, url } = await reportService.get(id, user);
        const raw = await objectStorage.getContentObject(EXTRACTED_TEXT_KEY(id));
        const fullText = raw ? new TextDecoder().decode(raw) : "";
        const truncated = fullText.length > MAX_EXTRACTED_TEXT_CHARS;
        return jsonResult({
          report: toPublicReport(report),
          // Content URL only exists while served (published / unlisted).
          ...(report.status === "published" || report.status === "unlisted"
            ? { url: url ?? reportService.contentUrl(id) }
            : {}),
          appUrl: appUrl(id),
          extractedText: truncated ? fullText.slice(0, MAX_EXTRACTED_TEXT_CHARS) : fullText,
          extractedTextTruncated: truncated,
        });
      }),
  );

  server.registerTool(
    "list_recent_reports",
    {
      title: "List recent reports",
      description: "List published reports, most recently updated first.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(`Maximum number of reports (default ${DEFAULT_LIMIT})`),
      },
    },
    async ({ limit }) => {
      const page = await reportService.listPublished({ limit: limit ?? DEFAULT_LIMIT });
      return jsonResult({
        reports: page.items.map((meta) => ({
          ...toPublicReport(meta),
          url: reportService.contentUrl(meta.id),
        })),
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      });
    },
  );

  server.registerTool(
    "upload_report",
    {
      title: "Upload report",
      description:
        "Upload a single HTML document as a new report (requires a per-user " +
        "API key). The security scan always runs: pass/warn → the report is " +
        "created private (publish it with publish_report), block → rejected. " +
        "Counts against the owner's daily upload quota.",
      inputSchema: {
        title: z.string().trim().min(1).max(REPORT_TITLE_MAX).describe("Report title"),
        description: z
          .string()
          .trim()
          .max(REPORT_DESCRIPTION_MAX)
          .optional()
          .describe("Optional short description"),
        tags: z
          .array(z.string().trim().min(1).max(REPORT_TAG_MAX))
          .max(REPORT_TAGS_MAX)
          .optional()
          .describe(
            `Optional tags for organizing / filtering (max ${REPORT_TAGS_MAX}, ` +
              `each up to ${REPORT_TAG_MAX} chars; duplicates are dropped)`,
          ),
        html: z.string().min(1).describe("Full HTML document to upload"),
      },
    },
    async ({ title, description, tags, html }) =>
      runTool(async () => {
        const owner = mustUser();
        const { report } = await reportService.createFromHtml(owner, {
          title,
          ...(description !== undefined ? { description } : {}),
          ...(tags !== undefined ? { tags } : {}),
          html,
        });
        return jsonResult({
          id: report.id,
          status: report.status,
          verdict: report.verdict,
          findings: report.findings,
          appUrl: appUrl(report.id),
          ...(report.status === "rejected"
            ? { message: "security scan blocked this upload; the report is rejected" }
            : {}),
        });
      }),
  );

  server.registerTool(
    "publish_report",
    {
      title: "Publish report",
      description:
        "Make one of your private reports publicly visible (requires a " +
        "per-user API key; owner only). visibility 'published' lists the " +
        "report in the public list and search; 'unlisted' serves it only to " +
        "people who know the URL. Call again to switch between the two. " +
        "Returns the share URL.",
      inputSchema: {
        id: z.string().min(1).describe("Report id (from upload_report / get_report)"),
        visibility: z
          .enum(["published", "unlisted"])
          .optional()
          .describe(
            "'published' = listed and searchable (default); " +
              "'unlisted' = link-only, never listed or searchable",
          ),
      },
    },
    async ({ id, visibility }) =>
      runTool(async () => {
        const owner = mustUser();
        const { report, url } = await reportService.publish(owner, id, {
          ...(visibility !== undefined ? { visibility } : {}),
        });
        return jsonResult({
          id: report.id,
          status: report.status,
          shareUrl: appUrl(report.id),
          contentUrl: url,
        });
      }),
  );

  server.registerTool(
    "unpublish_report",
    {
      title: "Unpublish report",
      description:
        "Hide one of your published reports (requires a per-user API key; " +
        "owner only). The report and its share URL stop being served.",
      inputSchema: {
        id: z.string().min(1).describe("Report id"),
      },
    },
    async ({ id }) =>
      runTool(async () => {
        const owner = mustUser();
        const report = await reportService.unpublish(owner, id);
        return jsonResult({ id: report.id, status: report.status });
      }),
  );

  return server;
}
