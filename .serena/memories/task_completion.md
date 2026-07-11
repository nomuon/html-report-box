# Task Completion Checklist

コーディングタスク完了時に必ず実行:

```bash
bun run typecheck    # 全パッケージ tsc --noEmit
bun test             # 全テスト（変更が局所なら bun test packages/<pkg> で先に確認可）
```

追加で必要な場合:

- infra（CDK）を触った場合: `bun run --filter @hrb/infra synth`、スナップショット差分が意図通りなら `bun test packages/infra --update-snapshots`
- API/フロー横断の変更: `bun run seed` + `bun run dev` 起動のうえ `bun scripts/smoke.ts`（E2E）

リンター/フォーマッターの専用設定は現状なし（tsc + bun test が唯一のゲート）。