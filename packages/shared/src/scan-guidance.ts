/**
 * スキャンルールの日本語ガイダンス（UI 表示用）。
 * ruleId ごとに「タイトル / なぜ危険か / どう直すか」を持ち、web が findings の
 * 表示に使う。網羅性は @hrb/scanner 側のテストで登録ルール一覧と突き合わせる
 * （scanner→shared / web→shared の既存依存方向のためここに置く）。
 * Portable (Node 22 compatible, no Bun-only APIs).
 */

export interface ScanRuleGuidance {
  /** 日本語の短いタイトル（tooltip 要約にも使う）。 */
  title: string;
  /** なぜ危険/警告なのか（1〜2文）。 */
  why: string;
  /** どう直すか（1〜2文）。 */
  fix: string;
}

export const SCAN_RULE_GUIDANCE: Readonly<Record<string, ScanRuleGuidance>> = {
  // ---- block ----
  "phishing-form": {
    title: "フィッシングフォームの疑い",
    why: "パスワード入力欄が外部への送信先やログインサービス風の文言と組み合わされており、認証情報を盗み取る典型的なフィッシングの構造です。",
    fix: "パスワード入力欄を削除してください。ログイン画面の見た目を再現する必要がある場合も、実際に入力を受け付けるフォームにはしないでください。",
  },
  "meta-refresh-external": {
    title: "外部サイトへの自動リダイレクト",
    why: "meta refresh により閲覧者を開いた直後に外部サイトへ転送します。共有 URL を踏み台に不正サイトへ誘導する手口に使われます。",
    fix: "meta refresh タグを削除し、外部サイトへの誘導が必要なら通常のリンクに置き換えてください。",
  },
  "executable-link": {
    title: "実行ファイルへのリンク",
    why: "実行ファイル（.exe / .ps1 / .bat など）のダウンロードリンクはマルウェア配布の常套手段です。",
    fix: "実行ファイルへのリンクを削除してください。ファイル配布が目的の場合はこのサービスの用途外です。",
  },
  "large-data-uri": {
    title: "巨大な data: URI の埋め込み",
    why: "画像・音声以外の大きな data: URI はバイナリや文書をページ内に密輸する手口で、ネットワーク検査をすり抜けます。",
    fix: "埋め込みデータを削除してください。グラフ画像などは image/png 等のメディア型 data: URI であれば許容されます。",
  },
  "decode-exec-chain": {
    title: "デコードした文字列の実行",
    why: "atob 等でデコードしたデータを eval / Function などでそのまま実行しており、難読化したペイロードを展開する典型的なドロッパーの挙動です。",
    fix: "デコード結果を実行するコードを削除し、スクリプトは平文のまま記述してください。",
  },
  "malicious-domain": {
    title: "既知の悪性ドメインへの参照",
    why: "フィッシング/マルウェア配布サイトとして報告済みのドメインへの URL が含まれています。",
    fix: "該当ドメインへのリンク・参照をすべて削除してください。",
  },
  "hidden-iframe": {
    title: "不可視の iframe",
    why: "見えない iframe で外部コンテンツを読み込んでおり、ドライブバイダウンロードや不正な通信の隠れ蓑に使われる構造です。",
    fix: "非表示の iframe を削除してください。埋め込みが必要なら閲覧者に見える形にしてください。",
  },
  "miner-signature": {
    title: "ブラウザマイナーの痕跡",
    why: "CoinHive 等の暗号通貨マイニングライブラリや接続先のシグネチャが含まれており、閲覧者の計算資源を無断利用します。",
    fix: "マイニング関連のスクリプト・URL をすべて削除してください。",
  },
  "svg-script": {
    title: "SVG 内のスクリプト",
    why: "SVG 内の script / イベントハンドラは「画像」として見過ごされやすい一方、通常の DOM アクセス権限で実行されます。",
    fix: "SVG から script 要素・on* 属性・javascript: URL を取り除いてください。",
  },
  "mime-mismatch": {
    title: "宣言された形式と中身の不一致",
    why: "HTML として申告されたファイルが実際はバイナリであったり、画像拡張子のファイルに HTML/スクリプトが入っているなど、形式偽装（ポリグロット）の疑いがあります。",
    fix: "拡張子と中身を一致させてください。UTF-16/UTF-32 で保存されたファイルは UTF-8 で保存し直してください。",
  },
  "zip-slip": {
    title: "ZIP の不正なパス（zip-slip）",
    why: "展開先の外側へ書き出すパス（../ やシンボリックリンク）を含む ZIP は、展開環境のファイルを上書きする攻撃に使われます。",
    fix: "アーカイブ内のパスをすべて相対の通常ファイルにし、シンボリックリンクを含めずに ZIP を作り直してください。",
  },
  "zip-encrypted": {
    title: "暗号化された ZIP エントリ",
    why: "暗号化されたエントリは中身を検査できないため受け入れられません。",
    fix: "パスワードなしで ZIP を作成し直してください。",
  },
  "zip-bomb": {
    title: "ZIP 爆弾の疑い",
    why: "展開後サイズ・エントリ数・圧縮率が異常に大きく、展開処理を枯渇させる ZIP 爆弾のパターンに一致します。",
    fix: "不要なファイルを取り除き、展開後サイズを常識的な範囲に収めた ZIP を作成し直してください。",
  },
  "zip-nested": {
    title: "ZIP 内の ZIP",
    why: "入れ子のアーカイブは中身を検査できず、検査回避に使われるため受け入れられません。",
    fix: "内側のアーカイブを展開し、単一の ZIP にまとめ直してください。",
  },
  "zip-disallowed-extension": {
    title: "ZIP 内の許可されない拡張子",
    why: "レポート表示に不要な種類のファイル（実行ファイル等）が含まれており、配布の踏み台になり得ます。",
    fix: "HTML・CSS・JS・画像など許可された種類のファイルだけで ZIP を作成し直してください。",
  },
  // ---- warn ----
  "external-form-action": {
    title: "外部オリジンへ送信するフォーム",
    why: "フォームの送信先が外部サイトになっており、入力内容がこのサービスの外へ送られます（実行時は CSP により遮断されます）。",
    fix: "action 属性を削除するか、送信を伴わない表示専用のフォームにしてください。",
  },
  "password-input": {
    title: "パスワード入力欄",
    why: "レポートが認証情報を収集する理由は通常なく、フィッシングと誤認されるおそれがあります。",
    fix: "input type=\"password\" を削除するか、通常のテキスト入力・表示専用の要素に置き換えてください。",
  },
  "js-redirect-external": {
    title: "スクリプトによる外部リダイレクト",
    why: "location への代入等で閲覧者を外部サイトへ遷移させるコードが含まれています。CSP でも遷移自体は止められません。",
    fix: "自動遷移のコードを削除し、必要なら閲覧者が自分でクリックするリンクにしてください。",
  },
  "blob-download-chain": {
    title: "スクリプト生成ファイルのダウンロード",
    why: "createObjectURL とダウンロード操作の組み合わせで、ネットワーク検査に映らないファイルダウンロードを合成できます。",
    fix: "ページ内でファイルを生成してダウンロードさせる処理が不要であれば削除してください（エクスポート機能等の正当な用途なら公開前に内容を確認してください）。",
  },
  obfuscation: {
    title: "難読化されたスクリプト",
    why: "エントロピーやエスケープ密度が高く、意図を隠した難読化コードの特徴に一致します。悪意の有無を目視で確認できません。",
    fix: "minify 前の読めるソースに置き換えるか、該当スクリプトを削除してください。",
  },
  "external-script-src": {
    title: "許可リスト外の外部スクリプト",
    why: "許可された CDN 以外から script を読み込もうとしています（実行時は CSP により遮断され、動作しません）。",
    fix: "スクリプトを HTML 内にインライン化するか、許可済み CDN（cdn.jsdelivr.net 等）の URL に変更してください。",
  },
};

/** ruleId に対応するガイダンス。未知の ruleId は undefined（呼び出し側で元 message にフォールバック）。 */
export function scanRuleGuidance(ruleId: string): ScanRuleGuidance | undefined {
  return SCAN_RULE_GUIDANCE[ruleId];
}

/** tooltip 等の 1 行要約: ガイダンスがあれば日本語タイトル、なければ元の message。 */
export function scanFindingSummary(finding: { ruleId: string; message: string }): string {
  return SCAN_RULE_GUIDANCE[finding.ruleId]?.title ?? finding.message;
}
