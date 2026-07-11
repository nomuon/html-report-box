# Tech Stack

- ランタイム/PM: **Bun**（Node/npm/Vite/jest/vitest/webpack/esbuild は不使用）。`bun install` / `bun run` / `bunx`
- 言語: TypeScript ^5（strict、`tsc --noEmit` で型検査のみ、トランスパイルは Bun）
- ワークスペース: Bun workspaces（`packages/*`）、ルート package.json は `"type": "module"`
- HTTP: Hono（ローカル Bun サーバーと Lambda 両対応）。express 不使用
- フロント: React + react-router + TanStack Query、Bun HTML imports でバンドル（Vite 不使用）
- バリデーション: zod（`packages/shared` に集約）
- スキャナ: parse5（HTML パース）、yauzl（zip 検査）、テスト検体生成に fflate
- テスト: `bun:test`（`import { test, expect } from "bun:test"`）
- IaC: AWS CDK（Lambda は Node 22 ランタイム想定）。デプロイは未実施
- 本番想定 AWS: S3 / CloudFront / API Gateway / Lambda / DynamoDB / Cognito — ローカルでは `core/src/local/` アダプタ + `.local-data/` で代替
- Bun は .env を自動ロード（dotenv 不要）。Bun API 詳細は `node_modules/bun-types/docs/**.mdx`
- Bun API 使用可能範囲の制約: `mem:core` のランタイム境界を参照