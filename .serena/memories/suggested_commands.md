# Suggested Commands

```bash
bun install                          # 依存導入
bun run seed                         # サンプルレポート3件を .local-data/ に投入
bun run dev                          # dev サーバー http://localhost:3000（--hot、実体: packages/api/src/local/server.ts）

bun run typecheck                    # 全パッケージ tsc --noEmit
bun test                             # 全 unit/integration テスト
bun test packages/scanner            # 特定パッケージのみ
bun test packages/core/src/report-service.test.ts   # 単一ファイル
bun test -t "テスト名の一部"          # テスト名フィルタ

bun scripts/smoke.ts                 # E2E（前提: bun run seed 済み + bun run dev 起動中）
bun run --filter @hrb/infra synth    # Lambda バンドル + cdk synth
bun test packages/infra --update-snapshots   # CDK snapshot 更新
```

- dev サーバーは 1 プロセス全部入り: SPA `/` / API `/api/*` / presigned POST 代替 `/local-upload` / 公開配信 `/r/<id>/` / リモート MCP `/mcp`
- dev のユーザー切替: `x-dev-user: alice | bob | admin` ヘッダー（admin のみ管理操作可）。dev の MCP は API キー不要
- データ置き場は `.local-data/`（環境変数 `HRB_DATA_DIR` / `PORT` で変更可）