/**
 * Production-like seed on top of `bun run seed`: 14 reports across 4 owners
 * covering every status (private / published / rejected / takedown), real
 * @hrb/scanner verdicts (pass / warn / block), abuse flags (open + resolved),
 * multi-version edits and a zip report. Timestamps spread over the past two
 * months via an injected clock. Idempotent by title.
 * Run from the repo root: `bun run seed:prod`.
 */
import { createLocalContext, getDevUser, StubDomainReputation } from "../src/local/index.ts";
import { createScanner, createZipExtractor } from "../../scanner/src/index.ts";
import type { ReportKind, ReportMeta, ReportStatus } from "@hrb/shared";
import type { AuthUser } from "../src/ports.ts";

// ---- injected clock (backdates createdAt / updatedAt / flag times) ----

let clock = new Date("2026-05-20T00:00:00.000Z");
const setClock = (iso: string): void => {
  clock = new Date(iso);
};

const ctx = createLocalContext({
  dataDir: process.env.HRB_DATA_DIR ?? ".local-data",
  scanner: createScanner({ domainReputation: new StubDomainReputation() }),
  zipExtractor: createZipExtractor(),
  now: () => clock,
});

// ---- owners: 2 real dev users + 2 display-only colleagues ----
// carol / dave cannot be selected via x-dev-user; their reports are managed
// through the admin user. They exist to make the published list look like a
// team, not a two-person demo.

const alice = getDevUser("alice");
const bob = getDevUser("bob");
const admin = getDevUser("admin");
const carol: AuthUser = { sub: "dev-carol", name: "Carol", isAdmin: false };
const dave: AuthUser = { sub: "dev-dave", name: "Dave", isAdmin: false };

// ---- HTML template ----

const page = (title: string, description: string, body: string, accent = "#4361ee"): string => `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${description}">
<title>${title}</title>
<style>
  body { font-family: sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; color: #1a1a2e; }
  h1 { border-bottom: 3px solid ${accent}; padding-bottom: .5rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #cbd5e1; padding: .5rem .75rem; text-align: left; }
  th { background: #eef2ff; }
  .kpi { display: inline-block; background: #eef2ff; border-radius: 8px; padding: 1rem 1.5rem; margin: .5rem; }
  .note { background: #fffbeb; border-left: 4px solid #f59e0b; padding: .75rem 1rem; }
</style>
</head>
<body>
<h1>${title}</h1>
${body}
</body>
</html>`;

// ---- minimal stored-only zip builder (same as scripts/smoke.ts) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries: Array<{ path: string; data: Uint8Array | string }>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = enc.encode(entry.path);
    const data = typeof entry.data === "string" ? enc.encode(entry.data) : entry.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let pos = 0;
  for (const chunk of [...locals, ...centrals, eocd]) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

const PNG_1PX = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

// ---- samples ----

interface ProdSample {
  owner: AuthUser;
  title: string;
  description: string;
  /** Upload (create+complete) time, ISO. */
  at: string;
  kind?: ReportKind;
  bytes: () => Uint8Array;
  /** Sanity check: status right after complete (default "private"). */
  expectAfterUpload?: ReportStatus;
  publishAt?: string;
  /** Direct HTML edits after publish (full rescan, version+1 each). */
  edits?: Array<{ at: string; html: string }>;
  /** Abuse flags — only valid while published. */
  flags?: Array<{ at: string; reason: string; sourceIp: string }>;
  takedownAt?: string;
  /** Admin resolves (clears) the flags at this time. */
  clearFlagsAt?: string;
}

const enc = new TextEncoder();
const html = (s: string) => () => enc.encode(s);

const kpiDashboard = (week: number, mau: string, wau: string, churn: string, note: string): string =>
  page(
    "週次KPIダッシュボード（プロダクト部）",
    "主要プロダクト指標の週次スナップショット（自動生成）",
    `
<p>第${week}週時点の主要指標です。バッチにより毎週金曜に自動生成されます。</p>
<div class="kpi">MAU ${mau}</div>
<div class="kpi">WAU ${wau}</div>
<div class="kpi">解約率 ${churn}</div>
<h2>今週のハイライト</h2>
<p>${note}</p>
<h2>ファネル</h2>
<table>
<tr><th>ステップ</th><th>通過率</th><th>前週差</th></tr>
<tr><td>サインアップ → 初回アップロード</td><td>62%</td><td>+1.4pt</td></tr>
<tr><td>初回アップロード → 公開</td><td>48%</td><td>+0.6pt</td></tr>
<tr><td>公開 → 2週継続利用</td><td>71%</td><td>-0.3pt</td></tr>
</table>`,
    "#0e7490",
  );

const SAMPLES: ProdSample[] = [
  {
    owner: alice,
    title: "2026年5月度 月次売上レポート",
    description: "全社売上サマリーと事業部別の前月比・前年比分析（5月度）",
    at: "2026-05-21T01:30:00.000Z",
    publishAt: "2026-05-21T01:42:00.000Z",
    bytes: html(
      page(
        "2026年5月度 月次売上レポート",
        "全社売上サマリーと事業部別の前月比・前年比分析（5月度）",
        `
<p>2026年5月の全社売上は前年同月比 108% となりました。GW の営業日減の影響を受けつつも、クラウド事業部の継続課金が下支えしています。</p>
<div class="kpi">全社売上 3.9億円</div>
<div class="kpi">前月比 -2.1%</div>
<div class="kpi">前年比 +8.3%</div>
<h2>事業部別サマリー</h2>
<table>
<tr><th>事業部</th><th>売上</th><th>前月比</th><th>前年比</th></tr>
<tr><td>クラウド事業部</td><td>1.65億円</td><td>+1.2%</td><td>+18.9%</td></tr>
<tr><td>SI事業部</td><td>1.45億円</td><td>-6.4%</td><td>+1.2%</td></tr>
<tr><td>プロダクト事業部</td><td>0.85億円</td><td>-0.8%</td><td>+5.5%</td></tr>
</table>
<h2>所感</h2>
<p>SI 事業部は検収期ズレによる一時的な減少であり、6月に反動増を見込みます。</p>`,
      ),
    ),
  },
  {
    owner: carol,
    title: "機能利用状況分析: レポート共有リンク",
    description: "共有リンク機能リリース後4週間の利用状況とリテンションへの影響",
    at: "2026-05-27T05:10:00.000Z",
    publishAt: "2026-05-27T05:25:00.000Z",
    bytes: html(
      page(
        "機能利用状況分析: レポート共有リンク",
        "共有リンク機能リリース後4週間の利用状況とリテンションへの影響",
        `
<p>4月末にリリースした共有リンク機能について、リリース後4週間の利用データを分析しました。</p>
<div class="kpi">利用ユーザー率 34%</div>
<div class="kpi">リンク経由閲覧 12,400 PV</div>
<h2>主な発見</h2>
<ul>
<li>共有リンクを1回以上発行したユーザーの4週リテンションは未発行ユーザーの 1.8 倍</li>
<li>発行されたリンクの 22% は社外ドメインから閲覧されている</li>
<li>モバイルからの閲覧が 41% を占める（アプリ本体のモバイル比率は 18%）</li>
</ul>
<h2>推奨アクション</h2>
<p>オンボーディングのステップ3に共有リンク発行の導線を追加する A/B テストを提案します。閲覧ページのモバイル最適化も優先度を上げるべきです。</p>`,
        "#7c3aed",
      ),
    ),
  },
  {
    owner: bob,
    title: "A/Bテスト結果: オンボーディング導線改善",
    description: "サインアップ後チュートリアルの2案比較 — 完了率とD7リテンション",
    at: "2026-06-03T02:00:00.000Z",
    publishAt: "2026-06-03T02:15:00.000Z",
    bytes: html(
      page(
        "A/Bテスト結果: オンボーディング導線改善",
        "サインアップ後チュートリアルの2案比較 — 完了率とD7リテンション",
        `
<p>5/12〜6/1 の3週間、新規登録ユーザー 4,812 名を対象に実施しました。有意水準 5%。</p>
<h2>結果サマリー</h2>
<table>
<tr><th>指標</th><th>A: 現行（動画）</th><th>B: インタラクティブ</th><th>差分</th></tr>
<tr><td>チュートリアル完了率</td><td>41.2%</td><td>58.7%</td><td>+17.5pt ✓有意</td></tr>
<tr><td>初回レポート作成率</td><td>33.0%</td><td>39.4%</td><td>+6.4pt ✓有意</td></tr>
<tr><td>D7 リテンション</td><td>24.1%</td><td>26.0%</td><td>+1.9pt（非有意）</td></tr>
</table>
<h2>結論</h2>
<p>B案（インタラクティブチュートリアル）を全ユーザーに展開します。D7 への効果は継続観測とし、7月末に追跡レポートを出します。</p>`,
      ),
    ),
  },
  {
    owner: dave,
    title: "AWSコスト最適化レビュー 2026-05",
    description: "月次インフラコストの内訳と削減施策の進捗（Savings Plans / S3 ライフサイクル）",
    at: "2026-06-05T08:40:00.000Z",
    publishAt: "2026-06-05T09:00:00.000Z",
    bytes: html(
      page(
        "AWSコスト最適化レビュー 2026-05",
        "月次インフラコストの内訳と削減施策の進捗（Savings Plans / S3 ライフサイクル）",
        `
<p>5月の AWS 請求額は $18,420（前月比 -7.2%）でした。4月に適用した Compute Savings Plans が通月で効いています。</p>
<h2>サービス別内訳</h2>
<table>
<tr><th>サービス</th><th>金額</th><th>前月比</th><th>備考</th></tr>
<tr><td>Lambda + API Gateway</td><td>$4,100</td><td>-12%</td><td>Savings Plans 適用</td></tr>
<tr><td>DynamoDB</td><td>$3,850</td><td>+4%</td><td>検索インデックス書き込み増</td></tr>
<tr><td>S3 + CloudFront</td><td>$6,900</td><td>-9%</td><td>IA 移行ライフサイクル有効化</td></tr>
<tr><td>その他</td><td>$3,570</td><td>-3%</td><td></td></tr>
</table>
<h2>次月の施策</h2>
<ul>
<li>staging バケットの 30 日削除ルールの適用範囲拡大</li>
<li>DynamoDB オンデマンド → プロビジョンド移行の試算</li>
</ul>`,
        "#b45309",
      ),
    ),
  },
  {
    owner: alice,
    title: "週次KPIダッシュボード（プロダクト部）",
    description: "主要プロダクト指標の週次スナップショット（自動生成・毎週上書き）",
    at: "2026-06-10T09:00:00.000Z",
    publishAt: "2026-06-10T09:05:00.000Z",
    bytes: html(kpiDashboard(24, "8,120", "3,480", "1.1%", "共有リンク経由の新規流入が増加。オーガニック比率が 3pt 改善。")),
    edits: [
      { at: "2026-06-24T09:00:00.000Z", html: kpiDashboard(26, "8,590", "3,720", "1.0%", "B案チュートリアル全展開の効果で初回アップロード率が上昇。") },
      { at: "2026-07-08T09:00:00.000Z", html: kpiDashboard(28, "9,040", "3,910", "0.9%", "月初の全社共有会で紹介された影響で社内新規ユーザーが急増。") },
    ],
  },
  {
    owner: carol,
    title: "採用ファネル分析 2026上半期",
    description: "エンジニア採用の応募〜内定承諾ファネルとボトルネック分析",
    at: "2026-06-12T03:20:00.000Z",
    publishAt: "2026-06-12T03:30:00.000Z",
    bytes: html(
      page(
        "採用ファネル分析 2026上半期",
        "エンジニア採用の応募〜内定承諾ファネルとボトルネック分析",
        `
<p>1〜6月のエンジニア採用ファネルを集計しました。母数はエージェント経由+リファラル+直接応募の合計です。</p>
<table>
<tr><th>ステージ</th><th>人数</th><th>通過率</th></tr>
<tr><td>書類応募</td><td>412</td><td>—</td></tr>
<tr><td>書類通過</td><td>127</td><td>31%</td></tr>
<tr><td>一次面接通過</td><td>58</td><td>46%</td></tr>
<tr><td>最終面接通過</td><td>19</td><td>33%</td></tr>
<tr><td>内定承諾</td><td>11</td><td>58%</td></tr>
</table>
<h2>ボトルネック</h2>
<p>最終面接の通過率が前年（45%）から大きく低下しています。面接官ごとの評価分布を確認したところ、評価基準のばらつきが拡大しており、キャリブレーション会の再開を提案します。</p>
<p class="note">リファラル経由の内定承諾率は 83% と突出して高く、リファラルボーナス増額の費用対効果は十分に正当化できます。</p>`,
        "#7c3aed",
      ),
    ),
  },
  {
    owner: bob,
    title: "セキュリティ監査 内部ドラフト（レビュー中）",
    description: "外部ペネトレーションテスト結果の内部向けドラフト — 公開前レビュー用",
    at: "2026-06-18T06:00:00.000Z",
    // 非公開のまま: オーナーだけが private preview で見られるデモ
    bytes: html(
      page(
        "セキュリティ監査 内部ドラフト（レビュー中）",
        "外部ペネトレーションテスト結果の内部向けドラフト — 公開前レビュー用",
        `
<p class="note">本ドラフトは修正対応が完了するまで社内でも非公開とします。公開判断はセキュリティ委員会にて行います。</p>
<h2>指摘事項サマリー</h2>
<table>
<tr><th>深刻度</th><th>件数</th><th>対応状況</th></tr>
<tr><td>High</td><td>1</td><td>修正済み（デプロイ待ち）</td></tr>
<tr><td>Medium</td><td>3</td><td>2件対応中</td></tr>
<tr><td>Low</td><td>7</td><td>バックログ化</td></tr>
</table>
<p>High 指摘はアップロード完了 API の権限チェック不備。修正はレビュー済みで、次回リリースに含まれます。</p>`,
        "#be123c",
      ),
    ),
  },
  {
    owner: alice,
    title: "顧客アンケート集計（回収フォーム付き）",
    description: "NPS調査の中間集計と追加回答の回収フォーム — 外部フォームPOSTでwarn付き公開のデモ",
    at: "2026-06-20T04:30:00.000Z",
    publishAt: "2026-06-20T04:45:00.000Z",
    bytes: html(
      page(
        "顧客アンケート集計（回収フォーム付き）",
        "NPS調査の中間集計と追加回答の回収フォーム",
        `
<p>6月度 NPS 調査の中間集計です。回答数 214 件、現時点の NPS は <strong>+23</strong>（前回 +17）。</p>
<h2>スコア分布</h2>
<table>
<tr><th>区分</th><th>件数</th><th>割合</th></tr>
<tr><td>推奨者 (9-10)</td><td>96</td><td>45%</td></tr>
<tr><td>中立者 (7-8)</td><td>71</td><td>33%</td></tr>
<tr><td>批判者 (0-6)</td><td>47</td><td>22%</td></tr>
</table>
<h2>追加回答はこちら</h2>
<p>未回答の方は以下のフォームからお願いします（外部フォームサービスに送信されます）。</p>
<form action="https://forms.example.com/s/nps-2026-06" method="post">
  <label>スコア (0-10): <input type="number" name="score" min="0" max="10"></label>
  <label>コメント: <input type="text" name="comment"></label>
  <button type="submit">送信</button>
</form>`,
      ),
    ),
  },
  {
    owner: dave,
    title: "モバイルアプリ クラッシュ率改善レポート",
    description: "v3.2で多発したクラッシュの原因分析と改善結果（クラッシュフリー率99.6%達成）",
    at: "2026-06-26T07:15:00.000Z",
    publishAt: "2026-06-26T07:30:00.000Z",
    bytes: html(
      page(
        "モバイルアプリ クラッシュ率改善レポート",
        "v3.2で多発したクラッシュの原因分析と改善結果",
        `
<p>v3.2 リリース直後にクラッシュフリー率が 98.1% まで悪化した件の振り返りです。v3.2.2 で 99.6% まで回復しました。</p>
<h2>上位クラッシュと対応</h2>
<table>
<tr><th>シグネチャ</th><th>発生比率</th><th>原因</th><th>対応</th></tr>
<tr><td>NSInvalidArgumentException (iOS)</td><td>48%</td><td>nil な共有URLのアンラップ</td><td>v3.2.1 で修正</td></tr>
<tr><td>OutOfMemoryError (Android)</td><td>29%</td><td>プレビュー画像の非同期デコード多重化</td><td>v3.2.2 で修正</td></tr>
<tr><td>その他</td><td>23%</td><td>—</td><td>個別対応中</td></tr>
</table>
<h2>再発防止</h2>
<ul>
<li>リリース前のメモリプロファイリングを CI に追加</li>
<li>段階的ロールアウト（5% → 25% → 100%）の必須化</li>
</ul>`,
        "#b45309",
      ),
    ),
  },
  {
    owner: bob,
    title: "四半期経営会議資料 2026Q2",
    description: "Q2実績と Q3 計画のサマリー（グラフ画像付き zip 版）",
    at: "2026-07-01T01:00:00.000Z",
    publishAt: "2026-07-01T01:20:00.000Z",
    kind: "zip",
    bytes: () =>
      makeZip([
        {
          path: "index.html",
          data: `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Q2実績と Q3 計画のサマリー">
<title>四半期経営会議資料 2026Q2</title>
<link rel="stylesheet" href="assets/style.css">
</head>
<body>
<h1>四半期経営会議資料 2026Q2</h1>
<p><img src="assets/revenue-chart.png" alt="四半期売上推移グラフ" width="640" height="320"></p>
<h2>Q2 実績ハイライト</h2>
<ul>
<li>四半期売上 12.3億円（計画比 103%、YoY +11%）</li>
<li>新規エンタープライズ契約 9 社（うち 3 社は共有リンク機能が決め手）</li>
<li>解約率 0.9% で過去最低を更新</li>
</ul>
<h2>Q3 重点テーマ</h2>
<ol>
<li>セルフサーブプランの価格改定（9月）</li>
<li>監査ログ機能のエンタープライズ向け提供</li>
<li>APAC リージョン展開の技術検証</li>
</ol>
<p><img src="assets/pipeline-chart.png" alt="Q3パイプライングラフ" width="640" height="320"></p>
</body>
</html>`,
        },
        {
          path: "assets/style.css",
          data: "body{font-family:sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#1a1a2e}h1{border-bottom:3px solid #4361ee;padding-bottom:.5rem}img{max-width:100%;height:auto;background:#eef2ff}",
        },
        { path: "assets/revenue-chart.png", data: PNG_1PX },
        { path: "assets/pipeline-chart.png", data: PNG_1PX },
      ]),
  },
  {
    owner: carol,
    title: "競合価格チートシート（営業配布用）",
    description: "主要競合3社のプラン別価格と機能差分の早見表",
    at: "2026-07-03T02:45:00.000Z",
    publishAt: "2026-07-03T03:00:00.000Z",
    flags: [
      {
        at: "2026-07-09T11:20:00.000Z",
        reason: "競合B社の価格が2025年時点の古い情報のまま掲載されており、顧客への誤案内につながる",
        sourceIp: "203.0.113.24",
      },
      {
        at: "2026-07-10T08:05:00.000Z",
        reason: "機能比較表の一部が競合他社の非公開提案資料からの転載に見える。出典の確認をお願いしたい",
        sourceIp: "198.51.100.7",
      },
    ],
    bytes: html(
      page(
        "競合価格チートシート（営業配布用）",
        "主要競合3社のプラン別価格と機能差分の早見表",
        `
<p>商談時の切り返し用早見表です。<strong>社外への直接共有は禁止</strong>。最終更新: 2026-07-03。</p>
<h2>プラン別価格</h2>
<table>
<tr><th>プラン</th><th>当社</th><th>競合A</th><th>競合B</th><th>競合C</th></tr>
<tr><td>スターター（/人月）</td><td>¥800</td><td>¥950</td><td>¥700</td><td>$8</td></tr>
<tr><td>ビジネス（/人月）</td><td>¥1,600</td><td>¥1,800</td><td>¥1,500</td><td>$18</td></tr>
<tr><td>エンタープライズ</td><td>個別見積</td><td>個別見積</td><td>¥3,000〜</td><td>個別見積</td></tr>
</table>
<h2>機能差分（当社優位）</h2>
<ul>
<li>アップロード時セキュリティスキャン: 競合は事後スキャンのみ</li>
<li>監査ログ: 競合Bはエンタープライズ限定、当社はビジネス以上</li>
<li>日本語全文検索の精度（CJK対応）</li>
</ul>`,
        "#7c3aed",
      ),
    ),
  },
  {
    owner: bob,
    title: "社内イベント写真アルバム 2026夏",
    description: "サマーオフサイトの写真まとめ（部署別集合写真あり）",
    at: "2026-07-05T10:00:00.000Z",
    publishAt: "2026-07-05T10:10:00.000Z",
    flags: [
      {
        at: "2026-07-09T09:30:00.000Z",
        reason: "本人の掲載同意を取っていない写真が含まれています。削除をお願いします",
        sourceIp: "192.0.2.55",
      },
    ],
    takedownAt: "2026-07-10T02:00:00.000Z",
    clearFlagsAt: "2026-07-10T02:05:00.000Z",
    bytes: html(
      page(
        "社内イベント写真アルバム 2026夏",
        "サマーオフサイトの写真まとめ（部署別集合写真あり）",
        `
<p>7/4 のサマーオフサイトの写真です。ダウンロードは自由ですが SNS への転載は禁止です。</p>
<h2>集合写真</h2>
<p>（写真はイントラのアルバムから移行予定のプレースホルダーです）</p>
<table>
<tr><th>部署</th><th>枚数</th></tr>
<tr><td>プロダクト部</td><td>34</td></tr>
<tr><td>営業部</td><td>28</td></tr>
<tr><td>コーポレート</td><td>19</td></tr>
</table>`,
        "#0e7490",
      ),
    ),
  },
  {
    owner: alice,
    title: "新ログイン画面モックアップ（デザインレビュー用）",
    description: "SSO移行後のログイン画面デザイン案 — 動作するフォーム付きモック",
    at: "2026-07-11T05:50:00.000Z",
    // password input + 外部 action → phishing-form ルールで block → rejected
    expectAfterUpload: "rejected",
    bytes: html(
      page(
        "新ログイン画面モックアップ（デザインレビュー用）",
        "SSO移行後のログイン画面デザイン案 — 動作するフォーム付きモック",
        `
<p>SSO 移行後のログイン画面のモックです。実際に入力して挙動を確認できます。</p>
<form action="https://staging-auth.example.com/session" method="post">
  <label>メールアドレス: <input type="email" name="email" autocomplete="username"></label>
  <label>パスワード: <input type="password" name="password" autocomplete="current-password"></label>
  <button type="submit">ログイン</button>
</form>
<p class="note">フィードバックは #design-review チャンネルへお願いします。</p>`,
      ),
    ),
  },
  {
    owner: dave,
    title: "障害対応ランブック 改訂案 v2",
    description: "オンコール一次対応手順の改訂ドラフト — SRE定例レビュー前のため非公開",
    at: "2026-07-11T08:30:00.000Z",
    bytes: html(
      page(
        "障害対応ランブック 改訂案 v2",
        "オンコール一次対応手順の改訂ドラフト",
        `
<p class="note">7/15 の SRE 定例でレビュー予定のドラフトです。承認後に公開します。</p>
<h2>変更点サマリー</h2>
<ul>
<li>一次切り分けフローに「決済API コネクションプール使用率」の確認を追加（7/2 障害の教訓）</li>
<li>エスカレーション基準を「p99 &gt; 5s が10分継続」に厳格化</li>
<li>ステークホルダー向け初報テンプレートを刷新（影響範囲・復旧見込みを必須項目に）</li>
</ul>
<h2>一次対応フロー（改訂版）</h2>
<table>
<tr><th>ステップ</th><th>アクション</th><th>目安時間</th></tr>
<tr><td>1</td><td>アラート確認・影響範囲の特定</td><td>5分</td></tr>
<tr><td>2</td><td>ダッシュボードで既知パターンと照合</td><td>10分</td></tr>
<tr><td>3</td><td>初報送信（テンプレート使用）</td><td>15分以内</td></tr>
<tr><td>4</td><td>切り分け or エスカレーション判断</td><td>30分以内</td></tr>
</table>`,
        "#b45309",
      ),
    ),
  },
];

// ---- runner ----

async function seedOne(sample: ProdSample): Promise<ReportMeta> {
  const kind = sample.kind ?? "html";
  setClock(sample.at);
  const { report, upload } = await ctx.service.create(sample.owner, {
    title: sample.title,
    description: sample.description,
    kind,
  });
  await ctx.storage.putStagingObject(upload.key, sample.bytes());
  const done = await ctx.service.complete(sample.owner, report.id, upload.key);
  let meta = done.report;

  const expected = sample.expectAfterUpload ?? "private";
  if (meta.status !== expected) {
    throw new Error(
      `${sample.title}: expected ${expected} after upload, got ${meta.status} (findings: ${JSON.stringify(meta.findings)})`,
    );
  }
  if (meta.status === "rejected") return meta;

  if (sample.publishAt) {
    setClock(sample.publishAt);
    meta = (await ctx.service.publish(sample.owner, meta.id)).report;
  }
  for (const edit of sample.edits ?? []) {
    setClock(edit.at);
    meta = (await ctx.service.editContent(sample.owner, meta.id, edit.html)).report;
  }
  for (const flag of sample.flags ?? []) {
    setClock(flag.at);
    await ctx.service.flag(meta.id, flag.reason, { sourceIp: flag.sourceIp });
  }
  if (sample.takedownAt) {
    setClock(sample.takedownAt);
    meta = await ctx.service.adminTakedown(admin, meta.id);
  }
  if (sample.clearFlagsAt) {
    setClock(sample.clearFlagsAt);
    await ctx.service.adminClearFlags(admin, meta.id);
  }
  return meta;
}

async function main(): Promise<void> {
  const existing = await ctx.repo.listAll({ limit: 500 });
  const existingTitles = new Set(existing.items.map((r) => r.title));

  for (const sample of SAMPLES) {
    if (existingTitles.has(sample.title)) {
      console.log(`skip (exists): ${sample.title}`);
      continue;
    }
    const meta = await seedOne(sample);
    const flagNote = sample.flags && !sample.clearFlagsAt ? `, flags=${sample.flags.length} open` : "";
    console.log(
      `seeded: ${sample.title} → ${meta.status} (v${meta.version}, verdict=${meta.verdict ?? "-"}${flagNote}) by ${meta.ownerName}`,
    );
  }

  const all = await ctx.repo.listAll({ limit: 500 });
  const byStatus = new Map<string, number>();
  for (const r of all.items) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  console.log(
    `seed:prod complete — total ${all.items.length} reports (${[...byStatus].map(([s, n]) => `${s}: ${n}`).join(", ")})`,
  );
}

await main();
