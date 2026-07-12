/**
 * 自前ホスト（dev / vps）のサーバー設定リゾルバ。
 *
 * ホスト先の選択は環境変数 HRB_TARGET ひとつで行う:
 *   - 省略 or "dev" … 手元開発。1 リスナー・同一オリジン・x-dev-user 有効
 *   - "vps"         … VPS 単体本番。2 リスナー（app / content）でオリジン分離、
 *                      Google 認証必須、x-dev-user 無効、MCP API キー必須
 *   - "aws"         … このサーバーでは起動しない（CDK デプロイに誘導するエラー）
 *
 * バリデーション違反は 1 件ずつではなく全件まとめて throw する。
 * Local-only module（ただし Bun API は不使用）。
 */
import { isAbsolute } from "node:path";

export type ServerTarget = "dev" | "vps";

export interface GoogleAuthEnvConfig {
  clientId: string;
  adminEmails: string[];
}

export interface ServerConfig {
  target: ServerTarget;
  /** app リスナー（SPA / API / MCP / local-upload）のポート。 */
  port: number;
  /** vps のみ: content リスナー（/r/*）のポート。dev では null（同一リスナー）。 */
  contentPort: number | null;
  dataDir: string;
  /** SPA / API のオリジン。共有 URL・presign の生成に使う。 */
  appOrigin: string;
  /** アップロードされた HTML（/r/*）のオリジン。dev では appOrigin と同一。 */
  contentOrigin: string;
  /** null なら dev ヘッダー認証（DevAuthVerifier）。 */
  googleAuth: GoogleAuthEnvConfig | null;
  /** /mcp の Bearer API キー。null なら認証なし（dev のみ許容）。 */
  mcpApiKey: string | null;
  /** x-dev-user ヘッダーによるユーザー切替を許すか（vps では常に false）。 */
  allowDevUserHeader: boolean;
  /** 別ポートの web dev サーバー向け CORS を有効にするか（dev のみ）。 */
  corsEnabled: boolean;
  /** 起動時に警告表示すべき注意事項（起動は妨げない）。 */
  warnings: string[];
}

const MCP_API_KEY_MIN_LENGTH = 32;

function parseAdminEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

function parsePort(raw: string | undefined, label: string, fallback: number, errors: string[]): number {
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`${label} はポート番号（1-65535）を指定してください: "${raw}"`);
    return fallback;
  }
  return port;
}

/** https オリジン（パスなし）を検証し、末尾スラッシュを除いた正規形を返す。 */
function parseHttpsOrigin(raw: string | undefined, label: string, errors: string[]): URL | null {
  if (!raw) {
    errors.push(`${label} は必須です（例: https://reports.example.com）`);
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    errors.push(`${label} が URL として不正です: "${raw}"`);
    return null;
  }
  if (url.protocol !== "https:") {
    errors.push(`${label} は https のオリジンを指定してください（TLS はリバースプロキシで終端）: "${raw}"`);
    return null;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "") {
    errors.push(`${label} はパス・クエリを含まないオリジンのみ指定できます: "${raw}"`);
    return null;
  }
  return url;
}

export function resolveServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const rawTarget = env.HRB_TARGET ?? "dev";
  if (rawTarget === "aws") {
    throw new Error(
      "HRB_TARGET=aws はこのサーバーでは起動しません。AWS へのデプロイは packages/infra の CDK で行います" +
        "（bun run --filter @hrb/infra synth / cdk deploy）。docs/DEPLOYMENT.md を参照してください。",
    );
  }
  if (rawTarget !== "dev" && rawTarget !== "vps") {
    throw new Error(`HRB_TARGET が不正です: "${rawTarget}"（dev | vps のいずれか。省略時は dev）`);
  }
  const target: ServerTarget = rawTarget;

  const errors: string[] = [];
  const warnings: string[] = [];
  const port = parsePort(env.PORT, "PORT", 3000, errors);
  const adminEmails = parseAdminEmails(env.HRB_ADMIN_EMAILS);

  if (target === "dev") {
    if (errors.length > 0) throw new Error(configErrorMessage(target, errors));
    const origin = `http://localhost:${port}`;
    return {
      target,
      port,
      contentPort: null,
      dataDir: env.HRB_DATA_DIR ?? ".local-data",
      appOrigin: origin,
      contentOrigin: origin,
      googleAuth: env.GOOGLE_CLIENT_ID
        ? { clientId: env.GOOGLE_CLIENT_ID, adminEmails }
        : null,
      // dev でも MCP_API_KEY を設定した場合だけ認証を有効化できる。
      mcpApiKey: env.MCP_API_KEY || null,
      allowDevUserHeader: true,
      corsEnabled: true,
      warnings,
    };
  }

  // ---- vps: 本番前提の必須チェック（違反は全件列挙） ----

  const contentPort = parsePort(env.HRB_CONTENT_PORT, "HRB_CONTENT_PORT", port + 1, errors);
  if (contentPort === port) {
    errors.push(`HRB_CONTENT_PORT は PORT と別のポートを指定してください（両方 ${port}）`);
  }

  const dataDir = env.HRB_DATA_DIR;
  if (!dataDir) {
    errors.push("HRB_DATA_DIR は必須です（永続データの置き場所。バックアップ対象）");
  } else if (!isAbsolute(dataDir)) {
    errors.push(`HRB_DATA_DIR は絶対パスを指定してください: "${dataDir}"`);
  }

  const appOrigin = parseHttpsOrigin(env.HRB_APP_ORIGIN, "HRB_APP_ORIGIN", errors);
  const contentOrigin = parseHttpsOrigin(env.HRB_CONTENT_ORIGIN, "HRB_CONTENT_ORIGIN", errors);
  // hostname（ポート除外）で比較する。ポート違いは別オリジンではあるが、
  // 将来 cookie を導入した場合 cookie はポート非依存のため防御が破れる。
  if (appOrigin && contentOrigin && appOrigin.hostname === contentOrigin.hostname) {
    errors.push(
      "HRB_CONTENT_ORIGIN は HRB_APP_ORIGIN と別のホスト名にしてください" +
        "（同一オリジン配信はアップロード HTML からのセッショントークン窃取を許します）",
    );
  }

  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    errors.push("GOOGLE_CLIENT_ID は必須です（vps では Google 認証のみ。x-dev-user は無効）");
  }
  if (adminEmails.length === 0) {
    warnings.push("HRB_ADMIN_EMAILS が未設定のため admin が存在しません（モデレーション操作が不可能になります）");
  }

  const mcpApiKey = env.MCP_API_KEY;
  if (!mcpApiKey) {
    errors.push("MCP_API_KEY は必須です（/mcp の Bearer 認証。`openssl rand -base64 32` などで生成）");
  } else if (mcpApiKey.length < MCP_API_KEY_MIN_LENGTH) {
    errors.push(`MCP_API_KEY は ${MCP_API_KEY_MIN_LENGTH} 文字以上にしてください（現在 ${mcpApiKey.length} 文字）`);
  }

  if (errors.length > 0) throw new Error(configErrorMessage(target, errors));

  return {
    target,
    port,
    contentPort,
    dataDir: dataDir as string,
    appOrigin: originString(appOrigin as URL),
    contentOrigin: originString(contentOrigin as URL),
    googleAuth: { clientId: clientId as string, adminEmails },
    mcpApiKey: mcpApiKey as string,
    allowDevUserHeader: false,
    corsEnabled: false,
    warnings,
  };
}

function originString(url: URL): string {
  return url.origin;
}

function configErrorMessage(target: ServerTarget, errors: string[]): string {
  return [
    `HRB_TARGET=${target} の設定が不正です（docs/DEPLOYMENT.md 参照）:`,
    ...errors.map((e) => `  - ${e}`),
  ].join("\n");
}
