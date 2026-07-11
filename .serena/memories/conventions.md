# Conventions

- **Ports & Adapters を崩さない**: 新しい外部依存は必ず `core/src/ports.ts` に IF を切り、`core/src/local/` と `core/src/aws/` の両実装を用意する
- **Bun API の使用範囲**: `core/src/local/`・`api/src/local/`・`packages/web`・scripts のみ。Lambda 搭載コード（shared/core 本体/scanner/api/mcp）は Node 22 互換 API のみ
- **エラー**: `DomainError`（`core/src/errors.ts`）を投げる。HTTP レスポンスは常に `{error:{code,message}}`、ステータスは `DomainError.httpStatus` 由来。生 throw や独自エラー形式を作らない
- **ルート保護は宣言的**: public / `requireAuth` / `requireAdmin` のいずれかを明示
- **zod スキーマ・API 契約は `packages/shared` に集約**。api/web/mcp で個別に型を再定義しない
- **スキャナルール追加手順**: `packages/scanner/src/rules/` に 1 ルール 1 ファイル（`rule.ts` の IF に準拠）→ `rules/index.ts` に登録。判定は block / warn の 2 段階。テストはゴールデン形式 + 悪性 zip 検体（fflate で生成、`rules/rules.test.ts`・`index.test.ts` 参照）
- テストは `bun:test` を同ディレクトリ `*.test.ts` に配置（例: `report-service.ts` ↔ `report-service.test.ts`）
- ドキュメント・コメントは日本語ベース（README/CLAUDE.md が日本語）