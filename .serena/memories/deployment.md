# デプロイ / ホスト先選択（2026-07-12 追加）

ホスト先は環境変数 **`HRB_TARGET`** ひとつで選ぶ（dev / vps / aws）。ユーザー向けガイドは `docs/DEPLOYMENT.md`（決定表・env 一覧・Caddy/systemd 手順）。設定解決は `packages/api/src/local/server-config.ts` の `resolveServerConfig(env)` — 違反は**全件列挙して throw**、`HRB_TARGET=aws` は CDK デプロイへ誘導するエラー。

## ターゲット別

- **dev（既定）**: 従来どおり 1 リスナー・同一オリジン全部入り。x-dev-user 有効・CORS 有効・MCP キー不要（`MCP_API_KEY` を設定した場合のみ認証）
- **vps**: local アダプタの本番昇格。必須 env: `HRB_DATA_DIR`（絶対パス）/ `HRB_APP_ORIGIN` / `HRB_CONTENT_ORIGIN`（https・app と別ホスト必須）/ `GOOGLE_CLIENT_ID` / `MCP_API_KEY`（32 文字以上）。`bun run start`（--hot なし）で起動
- **aws**: CDK（`packages/infra`）。Lambda は HRB_TARGET を読まない（偽の統一抽象を作らない設計判断）。`packages/api/src/lambda.ts` の `createAwsContext()` は未配線スタブのまま（既知の残タスク）

## vps の設計判断

- **2 リスナー方式**（Host ヘッダールーティングではない）: 同一プロセスで app リスナー（PORT: /api,/mcp,/local-upload,SPA）と content リスナー（HRB_CONTENT_PORT: /r/* のみ）を Bun.serve で分離。ホスト名→ポート振り分けはリバースプロキシ（Caddy）任せ。理由: Bun HTML import は Host 分岐ハンドラでラップ不可 / プロキシはどのみち TLS で必須 / app 側 routes に /r/* が存在しないため fail-secure
- **オリジン分離が必須な理由**: セッショントークンが localStorage 保管のため、同一オリジンで /r/ を配信すると悪性 HTML の直接オープンでトークン窃取可能。server-config が同一ホストを起動拒否
- **認証締め付け**: `GoogleAuthOptions.allowDevHeader`（default true）で vps は x-dev-user フォールバック無効。/mcp は既存 `bearerApiKeyAuth`（packages/mcp）でラップ
- **CSP**: `buildContentCsp()` を `packages/infra` → `packages/shared/src/content-csp.ts` に移設し、CloudFront とローカル/VPS 配信（routes.ts の handleContent）が同一ポリシーを共有。全モードで /r/* に付与（dev でも CSP 違反系レポートは動かなくなった、意図した挙動変化）
- **単一プロセス限定**: JsonStore / メモリレートリミッタはプロセス内状態。スケール必要なら aws へ、が線引き

## サーバー構成（packages/api/src/local/）

- `server.ts` = ブートストラップのみ / `routes.ts` = ハンドラ群（依存注入形、handleApi/handleMcp/handleLocalUpload/handleContent）/ `server-config.ts` = env 解決
- smoke.ts は x-dev-user 前提の **dev 専用ツール**。vps の疎通確認は curl（DEPLOYMENT.md 記載）

## 将来の Cloudflare 対応（未実装・下地のみ）

- scanner は fflate 化で WinterCG 互換（Node streams 依存ゼロ）
- `PresignedUpload` 契約に `method: "post"|"put"` + `headers`（default post で後方互換）— R2 の presigned PUT を表現可能。web/upload.ts と smoke.ts に put 分岐実装済み
- `packages/core/src/conformance/` の契約スイート（repository / search-index / object-storage、factory 注入形式）が第 3 アダプタの受け入れ基準。local は全 port、AWS は ObjectStorage のみ（Dynamo はコール記録型テスト維持）。SearchIndex.put の契約は**マージ（upsert）**で残留トークンの掃除は remove() の責務
