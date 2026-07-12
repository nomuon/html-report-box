/**
 * local アダプタ（Bun・JSON 永続化）を temp dir で factory 生成し、ports の
 * 共通契約スイート 3 種を全て流す。テストごとに新しい temp dir を割り当てて
 * インスタンス間の状態共有を避ける。Bun 専用 API はこの test ファイルでは可。
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runObjectStorageConformance } from "../conformance/object-storage.suite.ts";
import { runRepositoryConformance } from "../conformance/repository.suite.ts";
import { runSearchIndexConformance } from "../conformance/search-index.suite.ts";
import { LocalObjectStorage } from "./object-storage.ts";
import { LocalReportRepository } from "./repository.ts";
import { LocalSearchIndex } from "./search-index.ts";

const root = mkdtempSync(join(tmpdir(), "hrb-conformance-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function freshDir(): string {
  return mkdtempSync(join(root, "case-"));
}

runRepositoryConformance("LocalReportRepository", () => new LocalReportRepository(freshDir()));

runSearchIndexConformance("LocalSearchIndex", () => new LocalSearchIndex(freshDir()));

runObjectStorageConformance("LocalObjectStorage", () => {
  const storage = new LocalObjectStorage(freshDir());
  return { storage, putStaging: (key, data) => storage.putStagingObject(key, data) };
});
