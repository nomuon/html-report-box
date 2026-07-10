/**
 * MCP server factory — registers the three read-only tools
 * (search_reports / get_report / list_recent_reports) against a ReportService.
 *
 * Stateless Streamable HTTP mode: the HTTP layer (index.ts) builds a fresh
 * McpServer per request via this factory. Portable (Node 22); no Bun APIs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SEARCH_QUERY_MAX, toPublicReport } from "@hrb/shared";
import { DomainError } from "@hrb/core";
import type { ObjectStorage, ReportService } from "@hrb/core";

export interface McpContext {
  reportService: ReportService;
  /** Used to read the pre-extracted text at reports/<id>/.extracted.txt. */
  objectStorage: ObjectStorage;
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

export function buildMcpServer(ctx: McpContext): McpServer {
  const { reportService, objectStorage } = ctx;
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

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
      const results = await reportService.search(query, limit ?? DEFAULT_LIMIT);
      return jsonResult({
        results: results.map((r) => ({
          id: r.report.id,
          title: r.report.title,
          description: r.report.description,
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
        "Fetch one published report by id: metadata, share URL and the extracted " +
        "plain text of its HTML content.",
      inputSchema: {
        id: z.string().min(1).describe("Report id (from search_reports / list_recent_reports)"),
      },
    },
    async ({ id }) => {
      try {
        // No viewer passed → only published reports are visible.
        const { report, url } = await reportService.get(id);
        const raw = await objectStorage.getContentObject(EXTRACTED_TEXT_KEY(id));
        const fullText = raw ? new TextDecoder().decode(raw) : "";
        const truncated = fullText.length > MAX_EXTRACTED_TEXT_CHARS;
        return jsonResult({
          report: toPublicReport(report),
          url: url ?? reportService.contentUrl(id),
          extractedText: truncated ? fullText.slice(0, MAX_EXTRACTED_TEXT_CHARS) : fullText,
          extractedTextTruncated: truncated,
        });
      } catch (err) {
        if (err instanceof DomainError && err.code === "not_found") {
          return errorResult(`report not found: ${id}`);
        }
        throw err;
      }
    },
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

  return server;
}
