# HTML Report Box

Claude などが出力する**単一 HTML レポートを社内で安全に共有する**ためのホスティングサービス。
ドラッグ&ドロップでアップロード → 共有 URL 発行 → 全文検索（日本語/英語）→ リモート MCP でエージェントから参照、までを一気通貫で提供する。悪性 HTML の社内配布を防ぐため、アップロード時に静的セキュリティスキャン（pass / warn / block の3段階）を必ず実行する。

> **デプロイは後日**: AWS への実デプロイはまだ行っていない。コード・IaC（CDK）・ローカル動作確認までが現状のスコープ。ローカルでは AWS 依存をすべてインメモリ + `.local-data/` 永続化アダプタに差し替えて動作する。

## アーキテクチャ

AWS サーバーレス構成（S3 + CloudFront + API Gateway + Lambda + DynamoDB + Cognito(Google IdP)）。API フレームワークは Hono で、同一コードをローカル Bun サーバーと Lambda（Node 22）の両方で実行する。

```
                        社内 NW（WAF IP アロウリスト、CIDR はパラメータ化）
                        ┌──────────────────────────────────────────────┐
                        │                                              │
      ┌─────────────────▼──────────────────┐   ┌──────────────────────▼─────┐
      │ CloudFront A（アプリ）             │   │ CloudFront B（コンテンツ） │
      │  app.<domain>                      │   │  content.<domain>          │
      │  ├ /            → S3 hrb-app (SPA) │   │  └ /r/<id>/* → S3          │
      │  ├ /api/*       → API GW → Lambda  │   │      hrb-content           │
      │  └ /mcp         → API GW → Lambda  │   │  静的 CSP 付与・cookieless │
      └───────────────┬────────────────────┘   └────────────▲───────────────┘
                      │                                     │
        ┌─────────────▼────────────┐            公開コピー（scan pass 後のみ）
        │ Lambda (Hono)            │                        │
        │  api / mcp の 2 関数     │──────┬─────────────────┘
        └─┬───────────┬────────────┘      │
          │           │              ┌────▼────────┐
   ┌──────▼─────┐ ┌───▼──────────┐   │ S3          │
   │ DynamoDB   │ │ Cognito      │   │  hrb-staging│ ← presigned POST 直PUT
   │ hrb-reports│ │ (Google IdP, │   │  (1日で削除)│    （Lambda 6MB 制限回避）
   │ hrb-search │ │  admin group)│   └─────────────┘
   └────────────┘ └──────────────┘
```

- **オリジン分離が防御の核**: アップロードされた HTML はアプリ（認証トークンを持つオリジン）とは**別の CloudFront ディストリビューション・別オリジン**から配信する。レポート内の JS 実行は許容しつつ、SPA のトークン窃取を構造的に不可能にする
- **共有 URL はアプリのシェルページ**（`/reports/:id`）が正。`<iframe sandbox="allow-scripts allow-forms allow-popups allow-modals">` でコンテンツオリジンを埋め込む
- **検索は DynamoDB 転置インデックス**（CJK バイグラム + ASCII ワード、タイトル+8/説明+4/本文+1 の重み）。数万文書・低 QPS 想定のため OpenSearch は使わない
- **reportId は nanoid(21)**（推測不能）。`hrb-staging` は presigned POST の受け口で、スキャン通過後にのみ `hrb-content` へコピーされる

### アップロード〜公開フロー

公開/非公開はオーナー自身が切り替える（admin の事前承認は廃止）。非公開は「削除」ではなく
「存在するが未公開」のステータスで、オーナーと admin だけが内容（非公開プレビュー / ソース）を閲覧できる。

```
POST /api/reports（META 作成 status=private + presigned 発行）
  → S3 staging へ直 PUT
  → POST /api/reports/:id/complete
      検証（サイズ/キー） → メタ・本文抽出（parse5） → SecurityScanner.scan()
        pass/warn → sources/<id>/current に原本保存 → private（公開中の上書きは公開のまま再公開）
                    warn の findings はオーナーに提示（公開判断はオーナー）
        block     → rejected（検体は staging に30日保持、公開済みなら取り下げ）
  → POST /api/reports/:id/publish    原本から展開 → content バケットへコピー → 転置インデックス → published
  → POST /api/reports/:id/unpublish  content 削除 + インデックス除去 → private（原本は保持）
```

- `GET /api/reports/:id/source`（オーナー/admin）… 非公開プレビューと HTML 直接編集用のソース取得
- `PUT /api/reports/:id/content`（オーナー/admin、html のみ）… HTML 直接編集。上書きアップロード同様フルスキャンを再実行
- コンテンツオリジン（`/r/<id>/`）に載るのは published のみ。「content バケットに存在する = 公開中」の不変条件は維持

## パッケージ構成（Bun workspaces モノレポ）

| パッケージ | 内容 |
|---|---|
| `packages/shared` (@hrb/shared) | zod スキーマ・API 契約・トークナイザ・定数。全パッケージの土台 |
| `packages/core` (@hrb/core) | ドメインサービス（ReportService）+ ports（Repository/SearchIndex/ObjectStorage/AuthVerifier/…）+ ローカルアダプタ |
| `packages/scanner` (@hrb/scanner) | 静的セキュリティスキャナ。parse5 で 1 回パース → 1 ルール 1 ファイルのプラガブル Rule 群 + yauzl zip 検査 |
| `packages/api` (@hrb/api) | Hono HTTP 層（`/api/*`）。`lambda.ts` / `local/server.ts`（Bun dev サーバー） |
| `packages/mcp` (@hrb/mcp) | リモート MCP サーバー（Streamable HTTP・ステートレス）。search / get / list の 3 ツール |
| `packages/web` (@hrb/web) | React SPA（Bun HTML imports、Vite 不使用）。一覧・検索・D&D アップロード・詳細シェル・admin |
| `packages/infra` (@hrb/infra) | CDK 4 スタック: `HrbEdgeStack`(WAF, us-east-1) / `HrbStatefulStack`(DynamoDB・S3・Cognito) / `HrbAppStack`(Lambda・API GW) / `HrbCdnStack`(CloudFront×2 + OAC) |

依存方向: `web→shared` / `api→core→shared` / `mcp→core→shared` / `scanner→(core,shared)` / `infra→shared`。
Lambda に載るコード（shared/core/scanner/api/mcp）は Node 22 互換。Bun 専用 API は `local/` 配下とスクリプトに限定。

## ローカル開発

前提: [Bun](https://bun.com) v1.3+（Node/npm/Vite は不要）。

```bash
bun install                          # 依存導入
bun run seed                         # サンプル日本語レポート3件を .local-data/ に投入
bun run dev                          # http://localhost:3000 （--hot 付き）
```

dev サーバー 1 プロセスで全部入り:

- `/` … React SPA（Bun HTML import）
- `/api/*` … Hono API（`x-dev-user: alice | bob | admin` ヘッダーで dev ユーザー切替。admin だけが管理操作可）
- `/local-upload` … S3 presigned POST のローカル代替
- `/r/<id>/` … 公開済みレポート配信（コンテンツ CloudFront 相当。dotfile は 404。本番と同一の CSP を dev でも付与するため、CSP に違反するレポートは dev でも動かない）
- `/mcp` … リモート MCP（dev では API キー不要）

データは `.local-data/`（JSON + オブジェクト）に永続化。`HRB_DATA_DIR` / `PORT` 環境変数で変更可能。

### Google ログイン（ローカルで実アカウント認証）

既定はヘッダー切替の dev 認証だが、`GOOGLE_CLIENT_ID` を設定すると実際の Google アカウントでログイン/新規登録できる（GIS の Sign in with Google ボタン → ID トークンをサーバーで jose + Google JWKS 検証 → 30 日の opaque セッショントークンを発行、`.local-data/google-auth.json` に永続化。初回ログインで自動的にアカウント作成）。

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) で OAuth クライアント（種別: ウェブアプリケーション）を作成し、**承認済みの JavaScript 生成元**に `http://localhost:3000` を追加（ID トークンフローなのでリダイレクト URI は不要）
2. `.env`（Bun が自動ロード）に設定:

```bash
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
HRB_ADMIN_EMAILS=you@example.com   # カンマ区切り。管理者にするメールアドレス
```

3. `bun run dev` — 起動ログに `auth : google (...)` と出れば有効。管理画面からは Google ユーザーの admin 付与/削除（レポートカスケード）も可能。ローカル利便のため `x-dev-user` ヘッダーのフォールバックは google モードでも有効（curl / smoke 用。`HRB_TARGET=vps` では無効化される）。

AWS 本番は従来どおり Cognito(Google IdP) 連携の設計で、この直接続フローは `core/src/local/` に閉じている。

### テスト・検証

```bash
bun run typecheck                    # 全パッケージ tsc --noEmit
bun test                             # 281 unit/integration テスト（tokenizer / scanner ゴールデン / zip 悪性検体 / Hono app.request / CDK snapshot）
bun scripts/smoke.ts                 # E2E（要: bun run seed + bun run dev 起動済み。SMOKE_BASE_URL で向き先変更可）
bun run --filter @hrb/infra synth    # Lambda バンドル + cdk synth
```

`scripts/smoke.ts` は実サーバーに対する E2E で、アップロード（HTML/zip → private → 公開）→ 配信 → 悪性検体の block（zip-slip / eval+atob / フィッシングフォーム）→ warn（private + オーナー自身の公開）→ 非公開化/再公開 + ソース取得 + HTML 直接編集 → 上書き（version+1・旧インデックス掃除）→ 通報 + レート制限 + admin 通報一覧/解決 → テイクダウン → 認可 → MCP 3 ツール → 削除、までを検証する。

## デプロイ（ホスト先の選択）

ホスト先は環境変数 `HRB_TARGET` ひとつで選ぶ — 手元開発は **dev**（既定、`bun run dev`）、VPS 1 台での公開は **vps**（`HRB_TARGET=vps bun run start`。2 リスナーでオリジン分離・Google 認証必須・`x-dev-user` 無効）、マネージド構成は **aws**（CDK デプロイ）。必要な環境変数・Caddy/systemd の手順・運用の限界は **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** を参照。設定不備は起動時に全件まとめてエラー表示される。

## MCP 接続

dev サーバー起動中に:

```bash
claude mcp add --transport http hrb http://localhost:3000/mcp
```

ツール（すべて読み取り専用・published のみ参照可能）:

- `search_reports { query, limit? }` … 全文検索（日本語/英語）。メタ + 共有 URL + スコア
- `get_report { id }` … メタ + 共有 URL + 抽出済みプレーンテキスト（`.extracted.txt` を再利用、再パースなし）
- `list_recent_reports { limit? }` … 更新順一覧

本番では Distribution A 経由の `https://app.<domain>/mcp`（WAF IP 制限が自動適用）+ 静的 API キー（`Authorization: Bearer`、SSM SecureString）を予定。

## セキュリティ設計（要約）

防御は 3 層。詳細は `docs/DESIGN.md` と各パッケージのコード参照。

1. **構造的隔離** — 検知をすり抜けても被害が閉じる
   - コンテンツは別オリジン・完全 cookieless 配信。シェルページの iframe は `allow-same-origin` / `allow-top-navigation` / `allow-downloads` なし
   - コンテンツ側 CSP（CloudFront で静的付与）: `connect-src 'self'` / `form-action 'self'` / `frame-src 'none'` 等。script/style は self + 主要 CDN（jsdelivr/unpkg/cdnjs/tailwind）のみ許可
2. **アップロード時静的スキャン**（同期、pass / warn / block）
   - block: 資格情報フィッシングフォーム（password + 外部 action / ブランド語彙）、外部への即時 meta refresh、実行系拡張子リンク、eval+atob 等のデコード実行連鎖、大型 data:URI、hidden iframe、マイナーシグネチャ、SVG 内スクリプト、MIME 不一致、既知悪性ドメイン
   - warn（オーナーに注意提示。公開はオーナー判断）: 外部 action フォーム、password 入力の存在、JS 外部リダイレクト、難読化スコア閾値超え、アローリスト外 script src
   - zip: yauzl ストリーミング検査。zip-slip / symlink / 暗号化エントリ / zip bomb（実測 100MB・200 エントリ・圧縮率 100:1）/ ネスト zip 拒否、拡張子アローリスト、root `index.html` 必須。html/js/svg エントリは再帰スキャン
   - サイズ上限: HTML 5MB / zip 20MB（presigned `content-length-range` と Lambda 内で二重強制）
3. **追跡と即応**
   - アップロードは Google ログイン必須。META に sha256 / sourceIp / userAgent / verdict / findings を監査記録
   - 通報ボタン（無認証可・IP レート制限 5 件/10 分）→ admin が管理画面の通報一覧で確認し、テイクダウン（強制非公開 + 公開コンテンツ削除 + invalidation、META は監査用に保持）または通報解決
   - ユーザーあたり 30 アップロード/日。上書きは必ずフルスキャン再実行
   - 全体を社内 NW に閉域（WAF IP アロウリスト、デフォルト Block）

不採用（意図的）: ClamAV / 動的解析 / DOMPurify サニタイズ — レポート内 JS を動かすという前提と矛盾し、脅威モデルにも合わないため。将来の非同期第 2 段スキャン（S3 イベント→深掘り→事後テイクダウン）を追加できる構造だけ確保している。
