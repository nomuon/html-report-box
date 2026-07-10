/**
 * Local SearchIndex — inverted index (token → reportId → {w, u}) persisted
 * as `${dataDir}/search.json`. Mirrors the hrb-search DynamoDB table shape.
 * Local-only module.
 */
import { join } from "node:path";
import type { Posting, SearchHit, SearchIndex } from "../ports.ts";
import { JsonStore } from "./json-store.ts";

interface SearchDb {
  /** token → reportId → posting */
  postings: Record<string, Record<string, { w: number; u: string }>>;
}

export class LocalSearchIndex implements SearchIndex {
  private readonly store: JsonStore<SearchDb>;

  constructor(dataDir: string) {
    this.store = new JsonStore<SearchDb>(join(dataDir, "search.json"), () => ({
      postings: {},
    }));
  }

  async put(reportId: string, postings: readonly Posting[], updatedAt: string): Promise<void> {
    this.store.mutate((db) => {
      for (const posting of postings) {
        (db.postings[posting.token] ??= {})[reportId] = { w: posting.weight, u: updatedAt };
      }
    });
  }

  async remove(reportId: string, tokens: readonly string[]): Promise<void> {
    this.store.mutate((db) => {
      for (const token of tokens) {
        const byReport = db.postings[token];
        if (!byReport) continue;
        delete byReport[reportId];
        if (Object.keys(byReport).length === 0) delete db.postings[token];
      }
    });
  }

  async query(tokens: readonly string[]): Promise<SearchHit[]> {
    const db = this.store.get();
    const hits = new Map<string, SearchHit>();
    const seen = new Set<string>();
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      const byReport = db.postings[token];
      if (!byReport) continue;
      for (const [reportId, posting] of Object.entries(byReport)) {
        const hit = hits.get(reportId);
        if (hit) {
          hit.score += posting.w;
          hit.matchedTokens += 1;
          if (posting.u > hit.updatedAt) hit.updatedAt = posting.u;
        } else {
          hits.set(reportId, {
            reportId,
            score: posting.w,
            matchedTokens: 1,
            updatedAt: posting.u,
          });
        }
      }
    }
    return [...hits.values()];
  }
}
