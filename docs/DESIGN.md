# HTML Report Box — UI デザインスペック

対象: `packages/web`（@hrb/web）実装エージェント向け。このファイルだけで UI 実装が完結する具体性で記述する。

## 0. 前提・技術制約

- **React SPA + プレーン CSS**。Tailwind / CSS-in-JS / UI ライブラリは使わない。CSS はグローバル 1 ファイル（`styles/tokens.css` + `styles/app.css`）+ 必要ならコンポーネント単位の CSS ファイル分割可
- **Bun バンドラ**（HTML imports）。Vite は使わない
- **テーマ**: ライト/ダーク両対応。初期値は `prefers-color-scheme`、手動トグルで上書き（`<html data-theme="light|dark">` を付与、`localStorage.hrb-theme` に永続化。トグル未操作時は `data-theme` を付けず media query に従う）
- **UI 言語は日本語**。マイクロコピーは本書 §5 のものをそのまま使う
- 参照した実 UI パターン（Lazyweb 収集済み）:
  - Zoho WorkDrive: 左寄せナビ + ファイル一覧テーブル + 右上「New」プライマリボタン + 完了トースト
  - SoundCloud Artist Studio: ダークダッシュボード、統計チップ、中央の大型 D&D ドロップゾーン
  - Databricks: D&D エリア + browse ボタン + 「対応フォーマット / サイズ上限」を薄字で併記
  - docsum / Sprig: モーダル型アップロード（点線ボーダー + browse 代替）
  - PandaDoc Notary: ステータスチップの色分け（Draft/Sent/Viewed/Completed 相当）

## 1. デザイントークン（CSS Custom Properties）

`styles/tokens.css` に以下をそのまま定義する。ダークは `@media (prefers-color-scheme: dark)` 内の `:root:not([data-theme="light"])` と、`:root[data-theme="dark"]` の両方に同じ値を定義する（手動トグルが常に勝つこと）。

```css
:root {
  /* ---- カラー: ライト ---- */
  --color-bg: #f3f5f8;            /* ページ背景 */
  --color-surface: #ffffff;       /* カード・ヘッダー・モーダル */
  --color-surface-2: #eceff4;     /* hover行、コード背景 */
  --color-border: #dde2e9;
  --color-border-strong: #b7c0cc;
  --color-text: #171e28;
  --color-text-muted: #56616f;
  --color-text-faint: #8b95a3;    /* 注記・placeholder */
  --color-primary: #2b4fc2;       /* 紺藍: プライマリボタン・リンク・フォーカス */
  --color-primary-hover: #223f9e;
  --color-primary-subtle: #e9eefb;/* 選択行・dragover 背景 */
  --color-accent: #0d9488;        /* verdigris: スキャン済み・信頼の演出 */
  --color-accent-subtle: #e4f5f2;
  --color-danger: #d63333;
  --color-danger-hover: #b32323;
  --color-danger-subtle: #fdeded;
  --color-success: #178743;
  --color-success-subtle: #e6f5eb;
  --color-warning: #a85d0a;
  --color-warning-subtle: #fdf3e1;
  --color-content-bg: #ffffff;    /* 記事本文（iframe）面。ライトでは常に白 */

  /* ---- status 色（チップ・DropZone 状態で共用） ---- */
  --status-processing-fg: #4f46e5;      /* indigo: 処理中 */
  --status-processing-bg: #eceafd;
  --status-published-fg: #15803d;       /* green: 公開中 */
  --status-published-bg: #e7f6ec;
  --status-pending-fg: #b45309;         /* amber: 承認待ち */
  --status-pending-bg: #fdf3e2;
  --status-rejected-fg: #b91c1c;        /* red: 拒否 */
  --status-rejected-bg: #fdecec;

  /* ---- 検索ハイライト ---- */
  --color-highlight-bg: #fde68a;
  --color-highlight-fg: #1a2027;

  /* ---- spacing（4px グリッド） ---- */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;
  --space-9: 96px;

  /* ---- radius ---- */
  --radius-sm: 8px;    /* ボタン・チップ・input */
  --radius-md: 12px;   /* カード・テーブルラップ */
  --radius-lg: 18px;   /* モーダル・ドロップゾーン */
  --radius-full: 999px;

  /* ---- shadow ---- */
  --shadow-sm: 0 1px 2px rgba(23, 30, 40, .05);
  --shadow-md: 0 6px 20px rgba(23, 30, 40, .08);
  --shadow-lg: 0 18px 48px rgba(23, 30, 40, .16); /* モーダル・トースト */

  /* ---- typography ---- */
  --font-sans: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "BIZ UDPGothic",
               Meiryo, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --text-xs: 12px;  /* 注記・チップ */
  --text-sm: 13px;  /* テーブル・補助 */
  --text-md: 15px;  /* 本文基準 */
  --text-lg: 17px;  /* カードタイトル・セクション見出し */
  --text-xl: 22px;  /* 詳細ページタイトル */
  --text-2xl: 28px; /* ページタイトル */
  --leading: 1.65;  /* 日本語向け行間 */

  /* ---- その他 ---- */
  --header-h: 64px;
  --container-max: 1200px;
  --transition: 160ms ease;
}
```

ダーク値（上記と同キーで上書き）:

```css
  --color-bg: #101418;
  --color-surface: #1a2027;
  --color-surface-2: #232b34;
  --color-border: #323c47;
  --color-border-strong: #46525f;
  --color-text: #e7ebf0;
  --color-text-muted: #9aa6b3;
  --color-text-faint: #6b7683;
  --color-primary: #4d8dff;
  --color-primary-hover: #6ba1ff;
  --color-primary-subtle: #1b2a45;
  --color-danger: #f26d6d;
  --color-danger-hover: #ff8a8a;
  --color-danger-subtle: #3a2226;
  --color-success: #4ade80;
  --color-success-subtle: #16301f;
  --color-warning: #fbbf24;
  --color-warning-subtle: #362a15;

  --status-processing-fg: #a5b4fc; --status-processing-bg: #272345;
  --status-published-fg: #6ee7a0;  --status-published-bg: #16301f;
  --status-pending-fg: #fcd34d;    --status-pending-bg: #362a15;
  --status-rejected-fg: #fca5a5;   --status-rejected-bg: #3a2226;

  --color-highlight-bg: #705d15;
  --color-highlight-fg: #f5f0dc;

  --shadow-sm: 0 1px 2px rgba(0,0,0,.4);
  --shadow-md: 0 4px 12px rgba(0,0,0,.5);
  --shadow-lg: 0 12px 32px rgba(0,0,0,.6);
```

基本ルール:

- `body { background: var(--color-bg); color: var(--color-text); font-family: var(--font-sans); font-size: var(--text-md); line-height: var(--leading); }`
- フォーカスリングは全インタラクティブ要素共通: `outline: 2px solid var(--color-primary); outline-offset: 2px;`（`:focus-visible` のみ）
- 色コントラストはチップ fg/bg の組で WCAG AA を満たす値にしてあるため変更しない

## 2. レイアウトと画面構成

### 2.1 アプリシェル

```
┌─────────────────────────────────────────────────────┐
│ Header (sticky, h=56px, surface, border-bottom)      │
│  [📦 HTML Report Box]  [ 検索バー(中央, max600px) ]   │
│                [+ アップロード] [🌓] [devユーザー▾]    │
├─────────────────────────────────────────────────────┤
│ main: max-width 1120px, margin auto, padding 24px    │
└─────────────────────────────────────────────────────┘
```

- ロゴ: テキスト「HTML Report Box」（`--text-lg`, font-weight 700）+ ブランドマーク SVG（`BrandMark`: 角丸タイル `--color-primary` × 白い盾+チェック）。クリックで `/` へ
- 検索バー: ヘッダー中央（§3 SearchInput）。Enter で `/search?q=...` へ遷移
- 「+ アップロード」: プライマリボタン。`/upload` へ（Zoho WorkDrive の右上「New」相当）
- テーマトグル: アイコンボタン（ライト時 moon / ダーク時 sun の SVG アイコン、`aria-label="テーマ切り替え"`）
- ユーザーメニュー: アバター円（イニシャル 1 文字、`--color-primary-subtle` 背景）+ 名前。クリックでドロップダウン: 「マイレポート」「管理画面（admin のみ）」「ログアウト」。**ローカル dev モード時**（`GET /api/config` の `mode==="local"`）はドロップダウン上部に「devユーザー切替」セクションを出し、alice / bob / admin をラジオ選択（選択値を `X-Dev-User` ヘッダーに載せる。選択は localStorage 永続化）
- 未ログイン時: ユーザーメニュー位置に「Google でログイン」セカンダリボタン。閲覧・検索は未ログインでも可能。「+ アップロード」押下時は先にログインを促すモーダル
- モバイル（<720px）: 検索バーはヘッダー下の 2 段目に落とす。テーブルはカード表示に切替（§2.2）

ルーティング（react-router）:

| path | 画面 |
|---|---|
| `/` | ① 一覧（最新順） |
| `/search?q=` | ① 一覧の検索結果モード |
| `/upload` | ② アップロード |
| `/reports/:id` | ③ レポート詳細シェル |
| `/mine` | ④ マイレポート |
| `/admin` | ⑤ 管理画面（admin 以外は EmptyState「権限がありません」） |

### 2.2 画面①: 一覧 / 検索結果（`/`, `/search`）

- ページタイトル行: 「レポート一覧」（検索時は「「{q}」の検索結果 {n}件」）+ 右端に表示切替アイコン（テーブル/カード、localStorage 永続化、デフォルト: テーブル）
- **テーブル表示**（デスクトップ基準。Zoho WorkDrive 準拠）:
  - 列: タイトル（リンク, 太字）/ 作成者 / 更新日時（`2026/07/10 21:30` 形式, `--text-sm` muted）/ 種類（HTML / ZIP チップ）/ ステータスチップ
  - 行 hover: `background: var(--color-surface-2)`。行全体クリックで詳細へ
  - ヘッダ行: `--color-surface-2` 背景、`--text-xs` muted、font-weight 600
- **カード表示**: グリッド `repeat(auto-fill, minmax(280px, 1fr))`, gap `--space-4`。カード内: タイトル（2 行で ellipsis）→ 説明（`--text-sm` muted, 2 行 ellipsis）→ 下段に作成者 + 更新日 + ステータスチップ
- **検索結果ハイライト**: タイトル・説明中のクエリ一致部分を `<mark>`（`--color-highlight-bg`/`fg`, radius 2px, padding 0 2px）で強調。一致判定はクライアント側でクエリ文字列の単純部分一致（大小・NFKC 無視）
- 一般ユーザー向け一覧に出るのは `published` のみ（API がそう返す）。ステータスチップは実質「公開中」だが、コンポーネントは 4 状態対応で作る（マイレポート・admin で再利用）
- ページング: 「さらに読み込む」セカンダリボタン（無限スクロール不要）
- 0 件: EmptyState（§3）。通常時アイコン 📭「まだレポートがありません」+ プライマリボタン「最初のレポートをアップロード」/ 検索時 🔍「「{q}」に一致するレポートは見つかりませんでした」

### 2.3 画面②: アップロード（`/upload`）

SoundCloud Artist Studio / Databricks 参照。ページ中央に大型 DropZone を 1 枚置く構成。

- ページタイトル「レポートをアップロード」
- **DropZone**（§3 参照。幅 100%（max 720px 中央寄せ）、min-height 280px）
- DropZone 下に薄字注記（`--text-xs`, `--color-text-faint`, Databricks 式）:
  「対応形式: HTML（単一ファイル, 最大 5MB）/ ZIP（index.html 必須, 最大 20MB）」
- ファイル確定後（drop または browse）、DropZone の下にメタ入力フォームが出現:
  - タイトル（必須, text input。HTML の `<title>` から自動補完し編集可）
  - 説明（任意, textarea 3 行）
  - 「アップロード」プライマリボタン + 「キャンセル」ゴーストボタン
- アップロード開始で DropZone が uploading → scanning → done/rejected と遷移（§4.2）
- done 後: 共有 URL 表示 + コピー（§4.3）+「詳細を見る」「続けてアップロード」ボタン

### 2.4 画面③: レポート詳細シェル（`/reports/:id`）

共有 URL の正はこのページ。上部メタバー + 下部 iframe の 2 段。

```
┌────────────────────────────────────────────────────────────┐
│ タイトル(--text-xl)                                          │
│ 作成者 · 更新 2026/07/10 21:30 (· 非オーナーにはステータスチップ)│
│ [公開トグル] [<> HTMLを編集] [⬆ 上書きアップロード]            │
│ [✏ タイトル・説明] [🔗 共有URLをコピー] [⚠ 通報](公開中のみ)   │
├────────────────────────────────────────────────────────────┤
│ (非公開でオーナー/admin: 非公開プレビューバナー)                │
│ <iframe sandbox="allow-scripts allow-forms                  │
│   allow-popups allow-modals" src=コンテンツURL | srcdoc>     │
│   （height: calc(100vh - header - メタバー)）                │
└────────────────────────────────────────────────────────────┘
```

- メタバーは `--color-surface` + border-bottom。iframe はフルブリード（`--container-max` 制限を外し全幅）、`border: none`
- **オーナー/admin のアクション**: 公開トグル（§4.4）/「HTMLを編集」（html kind のみ、§4.6）/「上書きアップロード」（小型 DropZone モーダル）/「タイトル・説明」（メタ編集モーダル）
- 「共有 URL をコピー」: 公開中のみ表示。このシェルページの URL（`location.origin + /reports/:id`）をコピー。§4.3 のフィードバック
- 通報ボタン: 公開中かつ非オーナーにのみ表示。ゴースト（danger 色文字）。クリック → 確認モーダル「このレポートを通報しますか？」+ 理由 textarea（任意）→ POST 後トースト「通報を受け付けました。管理者が確認します」
- **非公開プレビュー**: private のレポートをオーナー/admin が開くと `GET /reports/:id/source` の HTML を `srcdoc` で埋め込み、上部に warning 色のバナー「非公開プレビュー — この内容はあなたと管理者のみ閲覧できます」（zip は追加アセット未解決の注記を付ける）
- private / rejected / takedown のレポートをオーナー/admin 以外が開いた場合・存在しない ID: EmptyState「このレポートは表示できません」
- iframe に **必ず** `sandbox="allow-scripts allow-forms allow-popups allow-modals"` を付ける（`allow-same-origin` は絶対に付けない）。`referrerPolicy="no-referrer"` も付与（srcdoc プレビューも同一 sandbox）

### 2.5 画面④: マイレポート（`/mine`）

- テーブル表示固定。列: タイトル / 公開状態 / 更新日時 / 操作
- **公開状態列**: published・private は公開トグル（§4.4）、rejected・takedown はステータスチップ。verdict=warn の行はトグル横に ℹ️ tooltip（スキャン注意項目の要約）
- 操作列: アイコンボタン 4 つ（tooltip 付き）: `<>` HTMLを編集（zip は disabled）/ ⬆️ 上書きアップロード / ✏️ タイトル・説明を編集 / 🗑 削除
  - **HTMLを編集**: ワイドモーダル + monospace textarea（§4.6）
  - **タイトル・説明**: モーダル（タイトル + 説明の 2 項目 + 保存/キャンセル）
  - **上書き**: モーダル内に小型 DropZone（min-height 180px、状態遷移は §4.2 と同一）。注記「上書きすると再スキャンが実行されます」
  - **削除**: 確認モーダル「「{title}」を削除しますか？ 共有 URL は無効になります。この操作は取り消せません」+ 削除（danger ボタン）/ キャンセル
- `rejected` 行は行全体 60% opacity + チップ tooltip に拒否理由（API の findings 要約）
- 0 件 EmptyState: 📄「あなたのレポートはまだありません」+「アップロードする」ボタン

### 2.6 画面⑤: 管理画面（`/admin`）

タブ 3 つ（下線式タブ、選択タブは `--color-primary` の 2px 下線 + 太字）:

1. **通報**: 通報（abuse flag）が付いたレポートの一覧テーブル。列: タイトル / 作成者 / ステータス / 通報（件数バッジ。クリックで理由一覧モーダル）/ 最終通報日時 / 操作「プレビュー」（新規タブで詳細シェルを開く）・「テイクダウン」（danger、published のみ）・「通報を解決」（ghost、確認モーダルで flag を全消去）。0 件 EmptyState: ✅「未対応の通報はありません」
2. **全レポート**: 全 status の一覧 + status フィルタチップ（複数選択トグル）。操作: 「テイクダウン」（danger、確認モーダル、published のみ）
3. **ユーザー管理**: ユーザー一覧（ユーザー名 / メール / admin チップ）。操作: 「admin 付与」「admin 剥奪」トグルボタン（確認モーダル付き）

## 3. コンポーネント仕様

すべて `src/components/` に 1 コンポーネント 1 ファイル。className は `hrb-` プレフィックス（例 `hrb-btn`）。

### Button

- variant: `primary` / `secondary` / `danger` / `ghost`
- 共通: height 40px（`size="lg"` は 48px、DropZone 内 browse 等）、padding `0 var(--space-5)`、radius `--radius-sm`、font-weight 600、`--text-sm`、transition `background var(--transition)`
- primary: bg `--color-primary`、白文字、hover `--color-primary-hover`
- secondary: bg `--color-surface`、border 1px `--color-border-strong`、文字 `--color-text`、hover bg `--color-surface-2`
- danger: bg `--color-danger`、白文字、hover `--color-danger-hover`
- ghost: 背景なし、文字 `--color-text-muted`（danger ghost は `--color-danger`）、hover bg `--color-surface-2`
- disabled: opacity .5 + `cursor: not-allowed`。loading: 文字の左に 14px スピナー（CSS border 回転）+ disabled 扱い

### Chip（ステータスチップ）

- inline-flex、height 24px、padding `0 var(--space-3)`、radius `--radius-full`、`--text-xs`、font-weight 600、先頭に 6px の● ドット
- マッピング（ラベルは必ずこの日本語）:

| status | ラベル | fg / bg |
|---|---|---|
| published | 公開中 | `--status-published-*` |
| private | 非公開 | 中立色（fg `--color-text-muted` / bg `--color-surface-2`） |
| rejected | 拒否 | `--status-rejected-*` |
| takedown | 管理停止 | `--status-rejected-*` |

- 種類チップ（HTML / ZIP）は中立色: bg `--color-surface-2`、fg `--color-text-muted`、ドットなし

### Card

- bg `--color-surface`、border 1px `--color-border`、radius `--radius-md`、padding `--space-5`、shadow `--shadow-sm`
- クリッカブル時: hover で `--shadow-md` + border `--color-border-strong`、`cursor: pointer`

### Modal

- オーバーレイ: `rgba(0,0,0,.5)`（ダーク時 `.65`）、クリックで閉じる（destructive 確認中は閉じない）
- 本体: `--color-surface`、radius `--radius-lg`、shadow `--shadow-lg`、width min(560px, calc(100vw - 32px))、padding `--space-6`。ヘッダー（`--text-lg` 太字 + 右上 x アイコンボタン）/ 本文 / フッター（右寄せボタン行, gap `--space-3`）
- 開閉: opacity+scale(.97→1) 150ms。Esc で閉じる。開時に最初のフォーカス可能要素へフォーカス（簡易フォーカストラップ）。`role="dialog" aria-modal="true"`

### Toast

- 右下固定（bottom/right `--space-6`）、縦積み最大 3 件。width 360px、`--color-surface`、border 1px `--color-border`、radius `--radius-md`、shadow `--shadow-lg`
- 構成: SVG アイコン（check-circle / x-circle / info、意味色）+ メッセージ（`--text-sm`）+ x 閉じる。5 秒で自動消滅（hover 中は停止）。出現は translateY(8px)+fade 160ms
- `aria-live="polite"` のコンテナに入れる

### EmptyState

- 中央寄せ、padding `--space-9` 上下。72px の円（`--color-surface-2`）内に SVG アイコン → 見出し（`--text-lg`, muted）→ 補足（`--text-sm`, faint）→ 任意のアクションボタン

### SearchInput

- height 40px、radius `--radius-full`、bg `--color-surface-2`（フォーカスで `--color-surface` + border `--color-primary`）、左に search アイコン（SVG）、右に x クリアボタン（入力時のみ表示）
- placeholder: 「レポートを検索…」。IME 変換中の Enter（`isComposing`）では検索しない

### DropZone

- 点線ボーダー 2px dashed `--color-border-strong`、radius `--radius-lg`、bg `--color-surface`、中央寄せ縦積み（docsum/Sprig 式）
- 内容（idle 時）: upload-cloud アイコン（64px 円 `--color-primary-subtle`）→ 「ここに HTML / ZIP ファイルをドラッグ＆ドロップ」（`--text-md` 太字）→ 「または」（faint）→ 「ファイルを選択」secondary ボタン（`<input type="file" accept=".html,.htm,.zip" hidden>` を発火）
- スキャン中: shield-check アイコン（accent 円）+ ゾーン上を verdigris の走査線が縦にスイープ（シグネチャ演出、reduced-motion では停止）
- キーボード操作: DropZone 自体を `role="button" tabIndex=0` にし Enter/Space で file picker
- 状態別の見た目は §4.2

### ProgressBar

- track: height 8px、radius `--radius-full`、bg `--color-surface-2`
- bar: `--color-primary`、width は %、transition `width 200ms linear`
- 不確定モード（スキャン中）: 幅 30% のバーが左右に往復するアニメ 1.4s
- 右側に % 表示（`--text-xs`, muted）。`role="progressbar"` + aria-valuenow

### Tooltip

- `--color-text` 背景（ダーク時 `--color-surface-2`）+ 反転文字、`--text-xs`、padding 4px 8px、radius `--radius-sm`。hover/focus から 300ms 遅延で表示

## 4. インタラクション詳細

### 4.1 D&D 状態遷移（DropZone 6 状態）

```
idle --(dragenter)--> dragover --(drop/選択)--> [クライアント検証]
  ├─ NG（拡張子/サイズ）→ idle に戻し danger トースト
  └─ OK → メタ入力 → 「アップロード」→ uploading --(S3 PUT 完了)-->
     scanning --(complete API 応答)--> done | rejected
                                  └ done = private（verdict=warn は注意項目を表示）
```

| 状態 | 見た目 |
|---|---|
| idle | 上記デフォルト |
| dragover | border を solid `--color-primary` に、bg `--color-primary-subtle`、全体 scale(1.01)。文言「ドロップしてアップロード」。※dragleave の児要素チラつき対策にカウンタ方式を使う |
| uploading | ボーダー solid `--color-border`。ファイル名 + サイズ表示 + ProgressBar（S3 PUT の進捗 %。XMLHttpRequest の `upload.onprogress` を使う。fetch では進捗が取れない）+ 「キャンセル」ghost |
| scanning | ProgressBar 不確定モード + 🛡 アイコン + 「セキュリティスキャン中…」（muted）。キャンセル不可 |
| done | ✅ 48px + 「アップロードが完了しました」+ 非公開である旨の説明 + 「公開する」primary（クリックで publish API → 共有 URL 行 §4.3 に切替）/「詳細を見る」secondary /「続けてアップロード」ghost。verdict=warn は注意項目リストを warning-subtle ボックスで表示 |
| rejected | ⛔ 48px + 「アップロードを拒否しました」（danger 色太字）+ 理由リスト（API findings の日本語 message を `--text-sm` で列挙）+ 「別のファイルを試す」secondary ボタン（idle へ戻る） |

- ページ全体への drop 事故防止: `window` の dragover/drop で `preventDefault()`
- クライアント側事前検証の文言: 拡張子 NG →「HTML または ZIP ファイルのみアップロードできます」/ サイズ超過 →「ファイルサイズが上限（HTML 5MB / ZIP 20MB）を超えています」/ 複数ファイル →「一度にアップロードできるのは 1 ファイルです」

### 4.2 アップロード進捗 → スキャン → 結果

- uploading 中の % は実進捗。100% 到達後すぐ scanning に切替（complete API 呼び出し中）
- scanning が 3 秒超えたら文言の下に「大きなファイルは時間がかかることがあります」を faint で追加
- complete API がネットワークエラー: danger トースト「アップロード処理に失敗しました。時間をおいて再試行してください」+ idle へ戻す

### 4.3 コピー成功フィードバック

- 共有 URL 行: readonly input（`--font-mono`, `--text-sm`, bg `--color-surface-2`）+ 「コピー」secondary ボタンの横並び
- クリック → `navigator.clipboard.writeText` → ボタンが 2 秒間「✓ コピーしました」（success 色文字）に変化して戻る + success トースト「共有 URL をコピーしました」。詳細シェルのヘッダーボタンも同挙動（トーストのみでも可）
- 失敗時（権限等）: input を全選択状態にして danger トースト「コピーできませんでした。URL を選択してコピーしてください」

### 4.4 公開/非公開トグル

- `role="switch"` のトグル（トラック 36×20px + サム 14px + テキストラベル「公開中/非公開」）。ON は `--status-published-fg`
- **公開（OFF→ON）**: 確認モーダル「レポートを公開しますか？」（一覧・検索に表示され、共有 URL を知っている人は誰でも閲覧できる旨 + いつでも戻せる旨）→ publish API → success トースト
- **非公開（ON→OFF）**: 即時実行（再トグルですぐ戻せるため確認なし）→ unpublish API → success トースト「非公開にしました。内容は保持され、あなたと管理者のみ閲覧できます」
- rejected / takedown はトグル非表示（チップ表示）。verdict=warn は付随の ℹ️ tooltip で注意項目を提示（公開はオーナー判断）

### 4.6 HTML 直接編集モーダル

- ワイドモーダル（width min(960px, 100vw-32px)）+ monospace textarea（min-height min(480px, 55vh)、`white-space: pre`）
- `GET /reports/:id/source` でソースをロード → 編集 → 「保存」で `PUT /reports/:id/content`。フッター左に注記「保存すると再スキャンが実行されます」。変更がない間は保存 disabled
- 保存結果: published なら「保存しました。公開中の内容を更新しました」/ private なら「保存しました（非公開のまま）」。verdict=warn は info トースト追加
- **block された場合**: モーダルは閉じず、編集内容を保持したまま danger ボックスで findings を列挙（修正して再保存で private に復帰できる）
- zip kind は編集不可（ボタン disabled、tooltip「ZIPは直接編集できません」）

### 4.5 その他マイクロコピー一覧（トースト等）

| イベント | 種別 | 文言 |
|---|---|---|
| メタ編集保存 | success | 変更を保存しました |
| 削除完了 | success | レポートを削除しました |
| 上書き完了 | success | レポートを上書きしました |
| 公開 | success | レポートを公開しました。共有URLで誰でも閲覧できます |
| 非公開化 | success | 非公開にしました。内容は保持され、あなたと管理者のみ閲覧できます |
| テイクダウン | success | レポートを公開停止しました |
| 通報解決 | success | 通報を解決済みにしました |
| admin 権限変更 | success | 権限を更新しました |
| 認可エラー(401/403) | danger | この操作にはログインが必要です／権限がありません |
| 汎用エラー | danger | エラーが発生しました。時間をおいて再試行してください |
| ログイン誘導モーダル | - | 見出し「ログインが必要です」/ 本文「レポートのアップロードには Google アカウントでのログインが必要です」/ ボタン「Google でログイン」primary |

## 5. 実装メモ（S4 エージェント向け）

- 日時表示は `Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" })` 相当で統一
- ステータス→表示のマッピング・チップは `StatusChip` 1 コンポーネントに集約し、一覧/マイレポート/admin/詳細で共用する
- テーマトグルは FOUC 防止のため、HTML エントリの `<head>` にインラインスクリプトで `localStorage.hrb-theme` を読んで `data-theme` を先付けする
- CSS はトークン参照のみで書き、生 hex をコンポーネント CSS に書かない
- アイコンは自前のインライン SVG セット（`components/Icon.tsx`、stroke 1.75 / currentColor / 24 viewBox）。絵文字は使用しない。外部アイコンフォント・CDN 依存なし
