# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

HTML Report Box — Claude などが出力する単一 HTML レポートを社内で安全に共有するホスティングサービス。アップロード時に静的セキュリティスキャン（pass / warn / block）を必ず実行する。AWS サーバーレス構成（S3 / CloudFront / API Gateway / Lambda / DynamoDB / Cognito）だが、**AWS へのデプロイはまだ行っておらず**、ローカルでは AWS 依存をすべてインメモリ + `.local-data/` 永続化アダプタに差し替えて動作する。

詳細は `README.md`（アーキテクチャ・セキュリティ設計）と `docs/DESIGN.md`（UI デザインスペック）を参照。

## コマンド

ランタイムは Bun（Node/npm/Vite は不使用）。

```bash
bun install                          # 依存導入
bun run seed                         # サンプルレポート3件を .local-data/ に投入
bun run dev                          # dev サーバー http://localhost:3000（--hot）

bun run typecheck                    # 全パッケージ tsc --noEmit
bun test                             # 全 unit/integration テスト
bun test packages/scanner            # 特定パッケージのみ
bun test packages/core/src/report-service.test.ts   # 単一ファイル
bun test -t "テスト名の一部"          # テスト名でフィルタ

bun scripts/smoke.ts                 # E2E（要: bun run seed + bun run dev 起動済み）
bun run --filter @hrb/infra synth    # Lambda バンドル + cdk synth
bun test packages/infra --update-snapshots   # CDK snapshot 更新
```

dev サーバーは 1 プロセスで全部入り: SPA (`/`) / API (`/api/*`) / presigned POST 代替 (`/local-upload`) / 公開コンテンツ配信 (`/r/<id>/`) / リモート MCP (`/mcp`)。dev では `x-dev-user: alice | bob | admin` ヘッダーでユーザー切替（admin のみ管理操作可）、MCP は API キー不要。データは `.local-data/`（`HRB_DATA_DIR` / `PORT` で変更可）。

## アーキテクチャ

Bun workspaces モノレポ。依存方向: `web→shared` / `api→core→shared` / `mcp→core→shared` / `scanner→(core,shared)` / `infra→shared`。

| パッケージ | 内容 |
|---|---|
| `packages/shared` | zod スキーマ・API 契約・トークナイザ（CJK バイグラム + ASCII ワード）・定数。全パッケージの土台 |
| `packages/core` | ドメインサービス（`ReportService`）+ ports（`src/ports.ts`）+ ローカル/AWS アダプタ |
| `packages/scanner` | 静的セキュリティスキャナ。parse5 で 1 回パース → 1 ルール 1 ファイルのプラガブル Rule 群 + yauzl zip 検査 |
| `packages/api` | Hono HTTP 層（`/api/*`）。`createApp(ctx)` に AppContext を注入 |
| `packages/mcp` | リモート MCP サーバー（Streamable HTTP・ステートレス）。search / get / list の読み取り専用 3 ツール |
| `packages/web` | React SPA（Bun HTML imports・react-router・TanStack Query） |
| `packages/infra` | CDK 4 スタック: HrbEdgeStack(WAF) / HrbStatefulStack / HrbAppStack / HrbCdnStack |

### 重要な設計原則

- **Ports & Adapters**: `core/src/ports.ts` のインターフェース（ReportRepository / SearchIndex / ObjectStorage / AuthVerifier / …）に対し、`core/src/local/`（Bun・JSON 永続化）と `core/src/aws/`（DynamoDB・S3・Cognito）の 2 実装がある。同一の Hono アプリがローカル Bun サーバーと Lambda（Node 22）の両方で動く。
- **ランタイム互換の境界**: Lambda に載るコード（shared / core / scanner / api / mcp）は **Node 22 互換必須**。Bun 専用 API（`Bun.file` 等）は `core/src/local/`・`api/src/local/`・`packages/web`・スクリプト類に限定すること。
- **オリジン分離が防御の核**: アップロードされた HTML は認証トークンを持つアプリとは別の CloudFront ディストリビューション・別オリジンから cookieless で配信。共有 URL はアプリのシェルページ `/reports/:id` が正で、sandbox 付き iframe でコンテンツを埋め込む。
- **アップロードフロー**: `POST /api/reports`（META 作成 + presigned 発行）→ staging へ直 PUT → `POST /api/reports/:id/complete` で検証・本文抽出・スキャン。pass → content へコピー + 転置インデックス → published、warn → pending_review（admin 承認待ち）、block → rejected。上書きは必ずフルスキャン再実行。
- **検索は DynamoDB 転置インデックス**（OpenSearch 不使用）。タイトル+8 / 説明+4 / 本文+1 の重み付け。
- エラーは常に `{error:{code,message}}` 形式。`DomainError.httpStatus` がステータスコードを決める。ルート保護は宣言的（public / `requireAuth` / `requireAdmin`）。

### スキャナへのルール追加

`packages/scanner/src/rules/` の Rule は 1 ルール 1 ファイルのプラガブル構造（`rule.ts` がインターフェース、`index.ts` に登録）。判定は block（フィッシングフォーム・eval+atob 連鎖・zip-slip 等）/ warn（外部 action フォーム・難読化スコア超過等）の 2 段階。テストはゴールデン形式 + 悪性 zip 検体（fflate で生成）。

## Bun の使い方

- `bun <file>` / `bun test` / `bun build` / `bun install` / `bun run <script>` / `bunx` を Node/npm/jest/vitest/webpack/esbuild の代わりに使う
- Bun は .env を自動ロードする（dotenv 不要）
- サーバーは `Bun.serve()`（express 不使用）、フロントは HTML imports（Vite 不使用）。ただし上記「ランタイム互換の境界」に注意 — Lambda 搭載コードでは Bun API 禁止
- テストは `bun:test`（`import { test, expect } from "bun:test"`）
- Bun API の詳細は `node_modules/bun-types/docs/**.mdx`
