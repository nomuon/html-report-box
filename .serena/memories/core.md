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
- **アップロードフロー / 可視性（2026-07 刷新）**: `POST /api/reports`（META status=private + presigned）→ staging 直 PUT → `POST /api/reports/:id/complete`（検証・本文抽出・スキャン）。pass/warn → 原本を `sources/<id>/current` に保存して private（公開中の上書きは公開のまま再公開）、block → rejected。ステータスは private/published/rejected/takedown の4種（processing・pending_review は廃止）。公開/非公開はオーナーが `publish`/`unpublish` で自己切替（admin 事前承認なし）。非公開でもオーナー/admin は `GET /reports/:id/source`（非公開プレビュー・srcdoc埋め込み）、`PUT /reports/:id/content` で HTML 直接編集（html kind のみ・フルスキャン+クォータ消費）。「content バケットに存在=公開中」の不変条件は維持（原本は sources/ プレフィックス、/r/ からは到達不能）。admin モデレーションは通報一覧（GET /admin/flagged）+ テイクダウン + 通報解決（DELETE /admin/reports/:id/flags）。上書き・編集は必ずフルスキャン再実行
- **旧データの原本復元（2026-07-11 追加）**: sources/ 導入前のレポートは原本オブジェクトを持たず getSource/publish が失敗していた。`ReportService.loadSource`（private メソッド）が sources/ 欠損時に公開コピー `reports/<id>/index.html`（html kind のみ、META の sha256 と一致する場合のみ）を sources/ にバックフィルして復元する。unpublish は公開コピー削除前に loadSource でレスキュー。復元不能（旧 private・rejected 等）は getSource 404 のままだが、web の EditHtmlModal は `not_found` を「原本消失」通知（.hrb-editor-notice、pending トークン色）+ 空エディタとして扱い、書き直し保存（PUT /content、要 sha256 定義）を許可する
- **admin ユーザー削除（2026-07-11 追加）**: `DELETE /admin/users/:username` = アカウント削除 + 所有レポート全削除のカスケード（レスポンス `{ok, deletedReports}`）。順序は sub 解決 → `ReportService.adminDeleteByOwner(admin, sub)`（listByOwner を空になるまで先頭ページ再取得しつつ private の purge 内部メソッドで index/storage/staging/META/CDN を一括削除）→ `UserAdmin.deleteUser`。自分自身は bad_request で拒否。`UserAdmin` port に `getUserSub`/`deleteUser` が増え、Cognito 実装は AdminGetUser/AdminDeleteUser（HrbAppStack の IAM にも追加済み）、Local 実装は DEV_USERS ベース（メモリのみ・再起動で復活）
- **検索**: DynamoDB 転置インデックス（OpenSearch 不使用）。重み: タイトル+8 / 説明+4 / 本文+1
- エラーは常に `{error:{code,message}}`、`DomainError.httpStatus` がステータス決定。ルート保護は宣言的（public / requireAuth / requireAdmin）

技術スタックとバージョン: `mem:tech_stack`。開発コマンド: `mem:suggested_commands`。コード規約: `mem:conventions`。完了時チェック: `mem:task_completion`。