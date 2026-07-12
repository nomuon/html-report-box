# デプロイガイド — ホスト先の選び方

HTML Report Box のホスト先は環境変数 **`HRB_TARGET`** ひとつで選ぶ。迷ったら次の決定表に従う。

| こういうとき | 選ぶもの | 起動方法 |
|---|---|---|
| 手元で開発・動作確認する | **dev**（既定） | `bun run dev` |
| VPS 1 台で社内に公開する | **vps** | `HRB_TARGET=vps bun run start` |
| マネージド・スケールが必要（S3/CloudFront/Lambda） | **aws** | `packages/infra` の CDK でデプロイ（このサーバーでは起動しない） |
| Cloudflare Workers 等 | 未対応 | 下記「Cloudflare について」参照 |

設定不備は起動時に**全件まとめて**エラー表示される（`packages/api/src/local/server-config.ts`）。エラーメッセージに従えば必要な環境変数がすべて分かる。

## 環境変数一覧

Bun は `.env` を自動ロードする（dotenv 不要）。

| 変数 | dev（既定） | vps |
|---|---|---|
| `HRB_TARGET` | 省略 or `dev` | **必須** `vps` |
| `PORT` | 任意（既定 3000） | 任意（app リスナー、既定 3000） |
| `HRB_CONTENT_PORT` | 不使用 | 任意（content リスナー、既定 PORT+1） |
| `HRB_DATA_DIR` | 任意（既定 `.local-data`） | **必須**・絶対パス |
| `GOOGLE_CLIENT_ID` | 任意（設定時 Google 認証） | **必須**（Google 認証のみ。`x-dev-user` は無効） |
| `HRB_ADMIN_EMAILS` | 任意 | 推奨（未設定だと admin 不在の警告） |
| `HRB_APP_ORIGIN` | 不使用 | **必須** https オリジン（例 `https://reports.example.com`） |
| `HRB_CONTENT_ORIGIN` | 不使用 | **必須** https オリジン・**app と別ホスト名** |
| `MCP_API_KEY` | 任意（設定時のみ /mcp 認証） | **必須** 32 文字以上（`openssl rand -base64 32`） |

## dev（手元開発）

従来どおり。1 プロセス・1 リスナー・同一オリジンで SPA / API / `/r/*` / MCP 全部入り。`x-dev-user: alice|bob|admin` ヘッダーでユーザー切替、CORS 有効、MCP は API キー不要。`bun run seed` → `bun run dev` → `bun scripts/smoke.ts`（smoke は `x-dev-user` 前提の **dev 専用ツール**）。

## vps（VPS 1 台で公開）

### 仕組み

1 プロセスだが **2 リスナー**でオリジンを分離する:

- **app リスナー**（`PORT`）: SPA / `/api/*` / `/mcp` / `/local-upload`。`/r/*` はルート自体が存在しない（リバースプロキシを誤設定しても app オリジンからアップロード HTML は配信されない = fail-secure）
- **content リスナー**（`HRB_CONTENT_PORT`）: `/r/*` のみ。CloudFront の content ディストリビューションと同一の CSP / セキュリティヘッダを付与

セッショントークンは localStorage（オリジン単位で隔離）なので、**app と content を別ホスト名にすること**が防御の核。同一ホストは server-config が起動を拒否する。

### 手順

1. **DNS**: 2 レコードを同じ VPS に向ける（例: `reports.example.com` と `reports-content.example.com`）
2. **Google OAuth**: Google Cloud Console で OAuth クライアント（Web）を作成し、Authorized JavaScript origins に `https://reports.example.com` を追加
3. **`.env`** をリポジトリ直下に作成:

   ```bash
   HRB_TARGET=vps
   HRB_DATA_DIR=/var/lib/hrb
   HRB_APP_ORIGIN=https://reports.example.com
   HRB_CONTENT_ORIGIN=https://reports-content.example.com
   GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
   HRB_ADMIN_EMAILS=you@example.com
   MCP_API_KEY=$(openssl rand -base64 32)   # 実際は生成した値を貼る
   ```

4. **リバースプロキシ（Caddy 推奨、自動 HTTPS）**: ホスト名 → リスナーの振り分けだけ

   ```caddyfile
   reports.example.com {
     reverse_proxy localhost:3000
   }
   reports-content.example.com {
     reverse_proxy localhost:3001
   }
   ```

5. **systemd unit**（例 `/etc/systemd/system/hrb.service`）:

   ```ini
   [Unit]
   Description=HTML Report Box
   After=network.target

   [Service]
   WorkingDirectory=/opt/html-report-box
   ExecStart=/usr/local/bin/bun run start
   Restart=always
   User=hrb

   [Install]
   WantedBy=multi-user.target
   ```

6. **疎通確認**（smoke は使えないので curl で）:

   ```bash
   curl -s https://reports.example.com/api/config          # auth.mode=google を確認
   curl -s -o /dev/null -w '%{http_code}' \
     -H 'x-dev-user: admin' https://reports.example.com/api/admin/flagged   # 401 なら OK
   curl -s -o /dev/null -w '%{http_code}' -X POST https://reports.example.com/mcp  # 401 なら OK
   ```

### 運用の前提と限界

- **単一プロセス限定**。JSON 永続化（JsonStore）とレートリミッタはプロセス内状態を持つ。`Restart=always` で常に 1 プロセスを保つこと。水平スケールが必要になったら aws へ
- **バックアップ = `HRB_DATA_DIR` の tar/rsync** だけ（全データがこのディレクトリに閉じる）
- レートリミット・WAF 相当はリバースプロキシ層で補強する（Cloudflare の DNS プロキシを前段に置くのも有効）
- メモリ 1GB 級の安価な VPS で足りる

## aws（CDK）

`HRB_TARGET=aws` でこのサーバーを起動しようとすると CDK への誘導エラーになる。AWS を選ぶ行為は CDK デプロイそのもの（`packages/infra` の 4 スタック）であり、Lambda 側は独自の環境変数契約（`REPORTS_TABLE_NAME` 等、`packages/core/src/aws/context.ts`）を使う。

> 注意: 現時点で AWS へは未デプロイ。`packages/api/src/lambda.ts` の `createAwsContext()` は未配線のスタブであり、実デプロイ時に `core/src/aws/context.ts` との接続が必要。

## Cloudflare について（未対応・将来の位置づけ)

Workers + D1 + R2 のアダプタ一式は未実装。ただし将来足すための下地は整備済み:

- scanner の zip 展開は fflate（pure JS）で Workers 互換
- `PresignedUpload` 契約は `method: "post" | "put"` を持ち、R2 の presigned PUT を表現できる
- `packages/core/src/conformance/` の契約テストが第 3 アダプタの受け入れ基準になる

追加する場合は `core/src/cloudflare/`（D1 Repository / R2 ObjectStorage / purge CdnInvalidator）+ Workers エントリポイント + `infra-cloudflare`（wrangler）を実装し、契約テストを通すこと。オリジン分離（app と content を別ドメイン）は Cloudflare でも必須。
