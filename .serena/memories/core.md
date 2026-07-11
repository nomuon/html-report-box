# Core

HTML Report Box — 単一 HTML レポートの社内共有ホスティング。アップロード時に静的セキュリティスキャン（pass/warn/block）必須。AWS サーバーレス設計だが **未デプロイ**：ローカルは AWS 依存を全てインメモリ + `.local-data/` アダプタで代替して動く。

詳細ドキュメント: `README.md`（アーキテクチャ・セキュリティ設計）、`docs/DESIGN.md`（UI スペック）。

## ソースマップ（Bun workspaces モノレポ、依存方向つき）

- `packages/shared` — zod スキーマ・API 契約・トークナイザ（CJK バイグラム + ASCII ワード）・定数。全パッケージの土台
- `packages/core` — ドメインサービス `ReportService`（`src/report-service.ts`）+ ports（`src/ports.ts`）+ アダプタ 2 系統: `src/local/`（Bun/JSON 永続化）と `src/aws/`（DynamoDB/S3/Cognito）。core→shared
- `packages/scanner` — 静的スキャナ。parse5 1 回パース → `src/rules/` に 1 ルール 1 ファイル（`rule.ts` が IF、`index.ts` に登録）+ `src/zip/` yauzl zip 検査。scanner→(core,shared)
- `packages/api` — Hono HTTP 層 `/api/*`。`createApp(ctx)` に AppContext 注入。dev サーバー本体は `src/local/server.ts`。api→core→shared
- `packages/mcp` — リモート MCP サーバー（Streamable HTTP・ステートレス）。search/get/list 読み取り専用 3 ツール。mcp→core→shared
- `packages/web` — React SPA（Bun HTML imports・react-router・TanStack Query）。web→shared
- `packages/infra` — CDK 4 スタック: HrbEdgeStack(WAF) / HrbStatefulStack / HrbAppStack / HrbCdnStack。infra→shared

## プロジェクト全体の不変条件

- **Ports & Adapters**: `core/src/ports.ts` の IF（ReportRepository / SearchIndex / ObjectStorage / AuthVerifier …）に local/aws の 2 実装。同一 Hono アプリがローカル Bun と Lambda(Node 22) 両方で動く
- **ランタイム境界**: Lambda 搭載コード（shared/core/scanner/api/mcp）は Node 22 互換必須。Bun 専用 API（`Bun.file` 等）は `core/src/local/`・`api/src/local/`・`packages/web`・scripts のみ許可
- **オリジン分離**: アップロード HTML は別 CloudFront/別オリジンから cookieless 配信。共有 URL はシェルページ `/reports/:id`、sandbox iframe 埋め込み
- **アップロードフロー**: `POST /api/reports`（META+presigned）→ staging 直 PUT → `POST /api/reports/:id/complete`（検証・本文抽出・スキャン）。pass→published、warn→pending_review（admin 承認）、block→rejected。上書きは必ずフルスキャン再実行
- **検索**: DynamoDB 転置インデックス（OpenSearch 不使用）。重み: タイトル+8 / 説明+4 / 本文+1
- エラーは常に `{error:{code,message}}`、`DomainError.httpStatus` がステータス決定。ルート保護は宣言的（public / requireAuth / requireAdmin）

技術スタックとバージョン: `mem:tech_stack`。開発コマンド: `mem:suggested_commands`。コード規約: `mem:conventions`。完了時チェック: `mem:task_completion`。