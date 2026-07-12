import { describe, expect, test } from "bun:test";
import { resolveServerConfig } from "./server-config.ts";

const VPS_ENV = {
  HRB_TARGET: "vps",
  HRB_DATA_DIR: "/var/lib/hrb",
  HRB_APP_ORIGIN: "https://reports.example.com",
  HRB_CONTENT_ORIGIN: "https://reports-content.example.com",
  GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  HRB_ADMIN_EMAILS: "admin@example.com",
  MCP_API_KEY: "k".repeat(32),
};

describe("resolveServerConfig: dev", () => {
  test("空 env でデフォルト構成（同一オリジン・dev ヘッダー有効・CORS 有効）", () => {
    const config = resolveServerConfig({});
    expect(config.target).toBe("dev");
    expect(config.port).toBe(3000);
    expect(config.contentPort).toBeNull();
    expect(config.dataDir).toBe(".local-data");
    expect(config.appOrigin).toBe("http://localhost:3000");
    expect(config.contentOrigin).toBe(config.appOrigin);
    expect(config.googleAuth).toBeNull();
    expect(config.mcpApiKey).toBeNull();
    expect(config.allowDevUserHeader).toBe(true);
    expect(config.corsEnabled).toBe(true);
    expect(config.warnings).toEqual([]);
  });

  test("HRB_TARGET=dev 明示 + PORT / HRB_DATA_DIR / GOOGLE_CLIENT_ID を反映", () => {
    const config = resolveServerConfig({
      HRB_TARGET: "dev",
      PORT: "4100",
      HRB_DATA_DIR: "tmp-data",
      GOOGLE_CLIENT_ID: "cid",
      HRB_ADMIN_EMAILS: "a@example.com, b@example.com",
    });
    expect(config.port).toBe(4100);
    expect(config.appOrigin).toBe("http://localhost:4100");
    expect(config.dataDir).toBe("tmp-data");
    expect(config.googleAuth).toEqual({ clientId: "cid", adminEmails: ["a@example.com", "b@example.com"] });
  });

  test("dev でも MCP_API_KEY 設定時はキーが有効になる", () => {
    const config = resolveServerConfig({ MCP_API_KEY: "dev-key" });
    expect(config.mcpApiKey).toBe("dev-key");
  });
});

describe("resolveServerConfig: target 判定", () => {
  test("HRB_TARGET=aws は CDK デプロイへ誘導するエラー", () => {
    expect(() => resolveServerConfig({ HRB_TARGET: "aws" })).toThrow(/CDK/);
  });

  test("未知の HRB_TARGET はエラー", () => {
    expect(() => resolveServerConfig({ HRB_TARGET: "cloudflare" })).toThrow(/dev \| vps/);
  });
});

describe("resolveServerConfig: vps", () => {
  test("必須 env が揃っていれば本番構成（分離オリジン・dev ヘッダー無効・CORS 無効）", () => {
    const config = resolveServerConfig(VPS_ENV);
    expect(config.target).toBe("vps");
    expect(config.port).toBe(3000);
    expect(config.contentPort).toBe(3001);
    expect(config.dataDir).toBe("/var/lib/hrb");
    expect(config.appOrigin).toBe("https://reports.example.com");
    expect(config.contentOrigin).toBe("https://reports-content.example.com");
    expect(config.googleAuth).toEqual({
      clientId: VPS_ENV.GOOGLE_CLIENT_ID,
      adminEmails: ["admin@example.com"],
    });
    expect(config.mcpApiKey).toBe(VPS_ENV.MCP_API_KEY);
    expect(config.allowDevUserHeader).toBe(false);
    expect(config.corsEnabled).toBe(false);
    expect(config.warnings).toEqual([]);
  });

  test("PORT / HRB_CONTENT_PORT の明示指定", () => {
    const config = resolveServerConfig({ ...VPS_ENV, PORT: "8080", HRB_CONTENT_PORT: "8090" });
    expect(config.port).toBe(8080);
    expect(config.contentPort).toBe(8090);
  });

  test("違反は 1 件ずつでなく全件列挙して throw", () => {
    let message = "";
    try {
      resolveServerConfig({ HRB_TARGET: "vps" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("HRB_DATA_DIR");
    expect(message).toContain("HRB_APP_ORIGIN");
    expect(message).toContain("HRB_CONTENT_ORIGIN");
    expect(message).toContain("GOOGLE_CLIENT_ID");
    expect(message).toContain("MCP_API_KEY");
    expect(message).toContain("docs/DEPLOYMENT.md");
  });

  test("HRB_DATA_DIR は絶対パス必須", () => {
    expect(() => resolveServerConfig({ ...VPS_ENV, HRB_DATA_DIR: "relative/dir" })).toThrow(/絶対パス/);
  });

  test("オリジンは https 必須・パス付きは拒否", () => {
    expect(() =>
      resolveServerConfig({ ...VPS_ENV, HRB_APP_ORIGIN: "http://reports.example.com" }),
    ).toThrow(/https/);
    expect(() =>
      resolveServerConfig({ ...VPS_ENV, HRB_CONTENT_ORIGIN: "https://cdn.example.com/r" }),
    ).toThrow(/オリジンのみ/);
  });

  test("app と content が同一ホストなら拒否（オリジン分離の担保）", () => {
    expect(() =>
      resolveServerConfig({ ...VPS_ENV, HRB_CONTENT_ORIGIN: VPS_ENV.HRB_APP_ORIGIN }),
    ).toThrow(/別のホスト名/);
  });

  test("PORT と HRB_CONTENT_PORT の重複は拒否", () => {
    expect(() =>
      resolveServerConfig({ ...VPS_ENV, PORT: "3000", HRB_CONTENT_PORT: "3000" }),
    ).toThrow(/別のポート/);
  });

  test("MCP_API_KEY は 32 文字以上", () => {
    expect(() => resolveServerConfig({ ...VPS_ENV, MCP_API_KEY: "short" })).toThrow(/32 文字以上/);
  });

  test("HRB_ADMIN_EMAILS 未設定は起動可能だが警告", () => {
    const config = resolveServerConfig({ ...VPS_ENV, HRB_ADMIN_EMAILS: undefined });
    expect(config.warnings.some((w) => w.includes("HRB_ADMIN_EMAILS"))).toBe(true);
  });

  test("オリジンは末尾スラッシュを正規化して origin 形にする", () => {
    const config = resolveServerConfig({ ...VPS_ENV, HRB_APP_ORIGIN: "https://reports.example.com/" });
    expect(config.appOrigin).toBe("https://reports.example.com");
  });
});
