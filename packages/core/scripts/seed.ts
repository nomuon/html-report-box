/**
 * Seed 3 Japanese sample HTML reports into the local adapters (.local-data/).
 * Run from the repo root: `bun run seed`. Idempotent by title.
 */
import { createLocalContext, getDevUser } from "../src/local/index.ts";

interface Sample {
  title: string;
  description: string;
  owner: string;
  html: string;
}

const page = (title: string, description: string, body: string): string => `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${description}">
<title>${title}</title>
<style>
  body { font-family: sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; color: #1a1a2e; }
  h1 { border-bottom: 3px solid #4361ee; padding-bottom: .5rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #cbd5e1; padding: .5rem .75rem; text-align: left; }
  th { background: #eef2ff; }
  .kpi { display: inline-block; background: #eef2ff; border-radius: 8px; padding: 1rem 1.5rem; margin: .5rem; }
</style>
</head>
<body>
<h1>${title}</h1>
${body}
</body>
</html>`;

const SAMPLES: Sample[] = [
  {
    title: "2026年6月度 月次売上レポート",
    description: "全社売上サマリーと事業部別の前月比・前年比分析",
    owner: "alice",
    html: page(
      "2026年6月度 月次売上レポート",
      "全社売上サマリーと事業部別の前月比・前年比分析",
      `
<p>2026年6月の全社売上は前年同月比 112% と好調に推移しました。特にクラウド事業部がエンタープライズ契約の更新により大きく伸長しています。</p>
<div class="kpi">全社売上 4.2億円</div>
<div class="kpi">前月比 +6.5%</div>
<div class="kpi">前年比 +12.0%</div>
<h2>事業部別サマリー</h2>
<table>
<tr><th>事業部</th><th>売上</th><th>前月比</th><th>前年比</th></tr>
<tr><td>クラウド事業部</td><td>1.8億円</td><td>+9.2%</td><td>+21.4%</td></tr>
<tr><td>SI事業部</td><td>1.5億円</td><td>+3.1%</td><td>+4.8%</td></tr>
<tr><td>プロダクト事業部</td><td>0.9億円</td><td>+5.0%</td><td>+7.7%</td></tr>
</table>
<h2>所感と来月の見通し</h2>
<p>パイプラインは潤沢であり、7月は大型案件のクロージングが2件予定されています。解約率は 0.8% と低水準を維持しています。</p>`,
    ),
  },
  {
    title: "決済基盤 障害振り返り（2026-07-02）",
    description: "7月2日に発生した決済APIタイムアウト障害のポストモーテム",
    owner: "alice",
    html: page(
      "決済基盤 障害振り返り（2026-07-02）",
      "7月2日に発生した決済APIタイムアウト障害のポストモーテム",
      `
<p>7月2日 14:03 から 14:41 にかけて、決済APIのレイテンシが悪化しタイムアウトが多発しました。影響範囲は全決済リクエストの約 18% です。</p>
<h2>タイムライン</h2>
<table>
<tr><th>時刻</th><th>イベント</th></tr>
<tr><td>14:03</td><td>p99 レイテンシが 8 秒を超過、アラート発報</td></tr>
<tr><td>14:12</td><td>コネクションプール枯渇を特定</td></tr>
<tr><td>14:35</td><td>プールサイズ拡張とリトライ抑制をデプロイ</td></tr>
<tr><td>14:41</td><td>全メトリクス正常化を確認、収束宣言</td></tr>
</table>
<h2>根本原因</h2>
<p>バッチ処理の突発的なクエリ増加により DB コネクションプールが枯渇し、リトライストームが発生したことが根本原因です。</p>
<h2>再発防止策</h2>
<ul>
<li>バッチとオンラインのコネクションプール分離</li>
<li>指数バックオフ + ジッターの導入</li>
<li>プール使用率の SLO ダッシュボード追加</li>
</ul>`,
    ),
  },
  {
    title: "競合調査: 社内ドキュメント共有ツール比較",
    description: "Notion / Confluence / esa / Kibela の機能・料金比較と推奨案",
    owner: "bob",
    html: page(
      "競合調査: 社内ドキュメント共有ツール比較",
      "Notion / Confluence / esa / Kibela の機能・料金比較と推奨案",
      `
<p>ナレッジ共有ツールのリプレイス検討にあたり、主要4製品を機能・料金・検索性の観点で比較しました。</p>
<h2>比較表</h2>
<table>
<tr><th>製品</th><th>月額/人</th><th>全文検索</th><th>API</th><th>所感</th></tr>
<tr><td>Notion</td><td>$10</td><td>◎</td><td>◎</td><td>データベース機能が強力</td></tr>
<tr><td>Confluence</td><td>$6.05</td><td>○</td><td>○</td><td>Jira 連携が必須なら有力</td></tr>
<tr><td>esa</td><td>¥500</td><td>○</td><td>○</td><td>Markdown 中心で軽量</td></tr>
<tr><td>Kibela</td><td>¥550</td><td>○</td><td>△</td><td>グループ管理が柔軟</td></tr>
</table>
<h2>推奨</h2>
<p>API 連携の拡張性と検索性を重視し、第一候補は Notion、第二候補は esa とします。移行コストの詳細見積もりは次フェーズで実施します。</p>`,
    ),
  },
];

async function main(): Promise<void> {
  const ctx = createLocalContext({ dataDir: process.env.HRB_DATA_DIR ?? ".local-data" });
  const encoder = new TextEncoder();

  const existing = await ctx.repo.listAll({ limit: 100 });
  const existingTitles = new Set(existing.items.map((r) => r.title));

  for (const sample of SAMPLES) {
    if (existingTitles.has(sample.title)) {
      console.log(`skip (exists): ${sample.title}`);
      continue;
    }
    const user = getDevUser(sample.owner);
    const { report, upload } = await ctx.service.create(user, {
      title: sample.title,
      description: sample.description,
      kind: "html",
    });
    await ctx.storage.putStagingObject(upload.key, encoder.encode(sample.html));
    const done = await ctx.service.complete(user, report.id, upload.key);
    console.log(`seeded: ${sample.title} → ${done.url ?? done.report.status}`);
  }
  console.log("seed complete.");
}

await main();
