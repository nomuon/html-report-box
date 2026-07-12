# Google 認証（ローカル実認証、2026-07-11 追加）

`GOOGLE_CLIENT_ID` 環境変数を設定すると dev サーバーが dev ヘッダー認証から実 Google 認証（GIS）に切り替わる。未設定なら従来の `x-dev-user` dev モードのまま（テスト・smoke 互換）。本番 AWS は Cognito(Google IdP) 連携の設計のため、この直接続フローは local アダプタに閉じている。

## フロー

1. web: `GoogleAuthProvider`（`packages/web/src/lib/auth.ts`）が GIS スクリプトを遅延ロードし、公式ボタン（`GoogleSignInButton.tsx`）を LoginModal に描画。ログイン=新規登録（初回自動プロビジョニング）
2. credential(ID トークン) → `POST /api/auth/google` → core local の `GoogleAuthVerifier`（`packages/core/src/local/google-auth.ts`）が jose（`createRemoteJWKSet` + `jwtVerify`、issuer 2形式・audience=clientId・clockTolerance 30s）で検証
3. opaque セッショントークン（randomBytes 32・TTL 30日）を発行し `.local-data/google-auth.json` に JsonStore 永続化。web は localStorage `hrb-google-session` に保持し `authorization: Bearer` で送信
4. `POST /api/auth/logout` で失効。web は `disableAutoSelect()` も呼ぶ

## 設計ポイント

- ports: `SessionAuth` interface（loginWithGoogle/logout）を `core/src/ports.ts` に追加。`AppContext.sessionAuth?` が存在するときだけ api が `/auth/*` をマウント（dev/cognito モードでは 404）
- `AuthConfig` に `{ mode: "google", clientId }` variant（shared/src/api.ts）。契約: `GoogleLoginRequest/Response`, `SessionUser`（sub/name/email/picture?/isAdmin）
- admin 判定: `HRB_ADMIN_EMAILS`（カンマ区切り allowlist、大文字小文字無視）。`setAdmin` による付与は再ログイン後も持続
- `GoogleAuthVerifier.userAdmin()` が UserAdmin 実装を返す（username=email、deleteUser はセッションもカスケード削除）
- google モードでも `x-dev-user` フォールバックは dev では有効（curl/smoke 用ローカル利便）。`GoogleAuthOptions.allowDevHeader`（default true）で制御され、`HRB_TARGET=vps` では無効化される（mem:deployment）
- GIS: FedCM は 2025-08 必須化済み。`use_fedcm_for_prompt` は非推奨（指定しない）。renderButton は type/theme/size/text/shape/width(max400)。ログアウト時 `disableAutoSelect()`
- Google Cloud Console 設定: OAuth クライアント（Web）の Authorized JavaScript origins に `http://localhost:3000`。ID トークンフローなので redirect URI 不要（README に手順記載）
- ヘッダー UI: `session.picture` があれば `.hrb-avatar` に img（`referrerPolicy="no-referrer"` 必須 — googleusercontent はリファラ付きだと 403 になりうる）、ドロップダウンに name+email 表示

## テスト

- `packages/core/src/local/google-auth.test.ts` — verifyIdToken 注入でネットワークレス（bun の `rejects.toSatisfy` は未対応なので catch 方式）
- `packages/api/src/auth-routes.test.ts` — login/logout/401/dev モード 404
- web `auth.test.ts` — GoogleAuthProvider（fake fetch/storage）
