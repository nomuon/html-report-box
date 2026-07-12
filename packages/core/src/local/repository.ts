/**
 * Local ReportRepository — in-memory with JSON persistence under `${dataDir}/reports.json`.
 * Local-only module.
 */
import { join } from "node:path";
import type { ReportMeta, ReportStatus } from "@hrb/shared";
import { DomainError } from "../errors.ts";
import type { Page, PageOptions, ReportFlag, ReportRepository } from "../ports.ts";
import { JsonStore } from "./json-store.ts";

interface ReportsDb {
  reports: Record<string, ReportMeta>;
  tokens: Record<string, string[]>;
  pending: Record<string, string>;
  /** key: `${ownerSub}#${dateKey}` */
  quotas: Record<string, number>;
  flags: Record<string, ReportFlag[]>;
}

const DEFAULT_LIMIT = 50;

function paginate(items: ReportMeta[], opts?: PageOptions): Page<ReportMeta> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const offset = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
  if (Number.isNaN(offset) || offset < 0) {
    throw new DomainError("bad_request", "invalid cursor");
  }
  const page = items.slice(offset, offset + limit);
  const next = offset + limit;
  return next < items.length
    ? { items: page, nextCursor: String(next) }
    : { items: page };
}

function byUpdatedAtDesc(a: ReportMeta, b: ReportMeta): number {
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

export class LocalReportRepository implements ReportRepository {
  private readonly store: JsonStore<ReportsDb>;

  constructor(dataDir: string) {
    this.store = new JsonStore<ReportsDb>(join(dataDir, "reports.json"), () => ({
      reports: {},
      tokens: {},
      pending: {},
      quotas: {},
      flags: {},
    }));
    // 2026-07 の可視性モデル刷新（processing / pending_review 廃止）前の dev
    // データを private に読み替える。旧レコードは sources/ を持たないため、
    // 再公開には再アップロードが必要（publish が conflict で案内する）。
    this.store.mutate((db) => {
      for (const meta of Object.values(db.reports)) {
        const legacy = meta.status as string;
        if (legacy === "processing" || legacy === "pending_review") meta.status = "private";
      }
    });
  }

  async create(meta: ReportMeta): Promise<void> {
    this.store.mutate((db) => {
      if (db.reports[meta.id]) {
        throw new DomainError("conflict", `report ${meta.id} already exists`);
      }
      db.reports[meta.id] = structuredClone(meta);
    });
  }

  async get(id: string): Promise<ReportMeta | null> {
    const meta = this.store.get().reports[id];
    return meta ? structuredClone(meta) : null;
  }

  async getMany(ids: readonly string[]): Promise<Map<string, ReportMeta>> {
    const db = this.store.get();
    const out = new Map<string, ReportMeta>();
    for (const id of ids) {
      const meta = db.reports[id];
      if (meta) out.set(id, structuredClone(meta));
    }
    return out;
  }

  async update(meta: ReportMeta): Promise<void> {
    this.store.mutate((db) => {
      if (!db.reports[meta.id]) {
        throw new DomainError("not_found", `report ${meta.id} does not exist`);
      }
      db.reports[meta.id] = structuredClone(meta);
    });
  }

  async delete(id: string): Promise<void> {
    this.store.mutate((db) => {
      delete db.reports[id];
      delete db.tokens[id];
      delete db.pending[id];
      delete db.flags[id];
    });
  }

  async listPublished(opts?: PageOptions): Promise<Page<ReportMeta>> {
    const all = Object.values(this.store.get().reports)
      .filter((m) => m.status === "published")
      .sort(byUpdatedAtDesc)
      .map((m) => structuredClone(m));
    return paginate(all, opts);
  }

  async listByOwner(ownerSub: string, opts?: PageOptions): Promise<Page<ReportMeta>> {
    const all = Object.values(this.store.get().reports)
      .filter((m) => m.ownerSub === ownerSub)
      .sort(byUpdatedAtDesc)
      .map((m) => structuredClone(m));
    return paginate(all, opts);
  }

  async listAll(opts?: PageOptions & { status?: ReportStatus }): Promise<Page<ReportMeta>> {
    const all = Object.values(this.store.get().reports)
      .filter((m) => (opts?.status ? m.status === opts.status : true))
      .sort(byUpdatedAtDesc)
      .map((m) => structuredClone(m));
    return paginate(all, opts);
  }

  async getDocumentTokens(id: string): Promise<string[]> {
    return [...(this.store.get().tokens[id] ?? [])];
  }

  async putDocumentTokens(id: string, tokens: readonly string[]): Promise<void> {
    this.store.mutate((db) => {
      if (tokens.length === 0) {
        delete db.tokens[id];
      } else {
        db.tokens[id] = [...tokens];
      }
    });
  }

  async setPendingUpload(id: string, stagingKey: string): Promise<void> {
    this.store.mutate((db) => {
      db.pending[id] = stagingKey;
    });
  }

  async getPendingUpload(id: string): Promise<string | null> {
    return this.store.get().pending[id] ?? null;
  }

  async clearPendingUpload(id: string): Promise<void> {
    this.store.mutate((db) => {
      delete db.pending[id];
    });
  }

  async incrementDailyUploads(ownerSub: string, dateKey: string): Promise<number> {
    return this.store.mutate((db) => {
      const key = `${ownerSub}#${dateKey}`;
      const next = (db.quotas[key] ?? 0) + 1;
      db.quotas[key] = next;
      return next;
    });
  }

  async getDailyUploads(ownerSub: string, dateKey: string): Promise<number> {
    return this.store.get().quotas[`${ownerSub}#${dateKey}`] ?? 0;
  }

  async addFlag(id: string, flag: ReportFlag): Promise<void> {
    this.store.mutate((db) => {
      (db.flags[id] ??= []).push(structuredClone(flag));
    });
  }

  async listFlags(id: string): Promise<ReportFlag[]> {
    return structuredClone(this.store.get().flags[id] ?? []);
  }

  async listFlagged(): Promise<Array<{ id: string; flags: ReportFlag[] }>> {
    const db = this.store.get();
    return Object.entries(db.flags)
      .filter(([, flags]) => flags.length > 0)
      .map(([id, flags]) => ({ id, flags: structuredClone(flags) }));
  }

  async clearFlags(id: string): Promise<void> {
    this.store.mutate((db) => {
      delete db.flags[id];
    });
  }
}
