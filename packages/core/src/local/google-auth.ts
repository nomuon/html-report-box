/**
 * Google auth for local mode — verifies GIS ID tokens (jose + Google JWKS),
 * provisions users on first login, and issues opaque session tokens persisted
 * under .local-data/. Also implements UserAdmin over the provisioned users.
 * Local-only module.
 *
 * Enabled by GOOGLE_CLIENT_ID; without it the dev server keeps DevAuthVerifier.
 * The AWS deployment will use Cognito with Google federation instead, so this
 * direct-to-Google flow never ships to Lambda.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AdminUser, AuthConfig, SessionUser } from "@hrb/shared";
import { DomainError } from "../errors.ts";
import type { AuthUser, AuthVerifier, Page, PageOptions, SessionAuth, UserAdmin } from "../ports.ts";
import { DEV_USERS, DEV_USER_HEADER } from "./auth.ts";
import { JsonStore } from "./json-store.ts";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Claims we consume from a verified Google ID token. */
export interface GoogleIdTokenPayload {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

/** Verifies a raw GIS credential and returns its claims. Injectable for tests. */
export type GoogleIdTokenVerifier = (credential: string) => Promise<GoogleIdTokenPayload>;

/** Default verifier: signature via Google's JWKS, issuer + audience pinned. */
export function createGoogleIdTokenVerifier(clientId: string): GoogleIdTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return async (credential) => {
    const { payload } = await jwtVerify(credential, jwks, {
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
      clockTolerance: "30s",
    });
    return payload as unknown as GoogleIdTokenPayload;
  };
}

interface StoredSession {
  sub: string;
  expiresAt: string; // ISO
}

interface GoogleAuthState {
  /** Provisioned users by Google sub. */
  users: Record<string, SessionUser>;
  /** Active sessions by opaque token. */
  sessions: Record<string, StoredSession>;
}

export interface GoogleAuthOptions {
  clientId: string;
  /** Directory for JSON state (same as the other local adapters). */
  dataDir: string;
  /** Emails granted admin on login (case-insensitive), e.g. from HRB_ADMIN_EMAILS. */
  adminEmails?: string[];
  /** Replace the Google verification (tests). Defaults to jose + Google JWKS. */
  verifyIdToken?: GoogleIdTokenVerifier;
  /**
   * x-dev-user ヘッダーによるフォールバックを許すか（default: true）。
   * dev の curl/smoke 利便のための機能なので、vps（本番）では必ず false。
   */
  allowDevHeader?: boolean;
  now?: () => Date;
}

export class GoogleAuthVerifier implements AuthVerifier, SessionAuth {
  private readonly clientId: string;
  private readonly adminEmails: Set<string>;
  private readonly verifyIdToken: GoogleIdTokenVerifier;
  private readonly allowDevHeader: boolean;
  private readonly now: () => Date;
  private readonly store: JsonStore<GoogleAuthState>;

  constructor(options: GoogleAuthOptions) {
    this.clientId = options.clientId;
    this.adminEmails = new Set((options.adminEmails ?? []).map((e) => e.toLowerCase()));
    this.verifyIdToken = options.verifyIdToken ?? createGoogleIdTokenVerifier(options.clientId);
    this.allowDevHeader = options.allowDevHeader ?? true;
    this.now = options.now ?? (() => new Date());
    this.store = new JsonStore(join(options.dataDir, "google-auth.json"), () => ({
      users: {},
      sessions: {},
    }));
  }

  async loginWithGoogle(credential: string): Promise<{ token: string; user: SessionUser }> {
    let claims: GoogleIdTokenPayload;
    try {
      claims = await this.verifyIdToken(credential);
    } catch {
      throw new DomainError("unauthorized", "Google ID token verification failed");
    }
    const email = claims.email?.toLowerCase();
    if (!claims.sub || !email || claims.email_verified === false) {
      throw new DomainError("unauthorized", "Google account must have a verified email");
    }

    const nowMs = this.now().getTime();
    const token = randomBytes(32).toString("base64url");
    const user = this.store.mutate((state) => {
      const existing = state.users[claims.sub];
      const next: SessionUser = {
        sub: claims.sub,
        name: claims.name ?? existing?.name ?? email.split("@")[0] ?? email,
        email,
        ...(claims.picture ? { picture: claims.picture } : {}),
        // Allowlist always grants admin; a setAdmin() grant survives re-login.
        isAdmin: this.adminEmails.has(email) || existing?.isAdmin === true,
      };
      state.users[claims.sub] = next;
      for (const [t, s] of Object.entries(state.sessions)) {
        if (Date.parse(s.expiresAt) <= nowMs) delete state.sessions[t];
      }
      state.sessions[token] = {
        sub: claims.sub,
        expiresAt: new Date(nowMs + SESSION_TTL_MS).toISOString(),
      };
      return next;
    });
    return { token, user };
  }

  async logout(token: string): Promise<void> {
    this.store.mutate((state) => {
      delete state.sessions[token];
    });
  }

  async verify(headers: Record<string, string | undefined>): Promise<AuthUser | null> {
    const bearer = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) {
      const state = this.store.get();
      const session = state.sessions[bearer];
      if (session && Date.parse(session.expiresAt) > this.now().getTime()) {
        const user = state.users[session.sub];
        if (user) return { sub: user.sub, name: user.name, isAdmin: user.isAdmin };
      }
      return null;
    }
    // Local convenience: the dev header keeps smoke/curl flows working even in
    // google mode. vps (production) disables this via allowDevHeader=false.
    if (this.allowDevHeader) {
      const devName = headers[DEV_USER_HEADER];
      if (devName) {
        const user = DEV_USERS[devName.toLowerCase()];
        if (user) return { ...user };
      }
    }
    return null;
  }

  authConfig(): AuthConfig {
    return { mode: "google", clientId: this.clientId };
  }

  /** UserAdmin over the same store (username = email). */
  userAdmin(): UserAdmin {
    return new GoogleUserAdmin(this.store);
  }
}

class GoogleUserAdmin implements UserAdmin {
  constructor(private readonly store: JsonStore<GoogleAuthState>) {}

  private byEmail(email: string): SessionUser | undefined {
    const needle = email.toLowerCase();
    return Object.values(this.store.get().users).find((u) => u.email === needle);
  }

  async listUsers(_opts?: PageOptions): Promise<Page<AdminUser>> {
    const items = Object.values(this.store.get().users)
      .map((u) => ({ username: u.email, name: u.name, email: u.email, isAdmin: u.isAdmin }))
      .sort((a, b) => a.email.localeCompare(b.email));
    return { items };
  }

  async setAdmin(username: string, isAdmin: boolean): Promise<void> {
    const user = this.byEmail(username);
    if (!user) throw new DomainError("not_found", `user ${username} does not exist`);
    this.store.mutate((state) => {
      const stored = state.users[user.sub];
      if (stored) stored.isAdmin = isAdmin;
    });
  }

  async getUserSub(username: string): Promise<string | null> {
    return this.byEmail(username)?.sub ?? null;
  }

  async deleteUser(username: string): Promise<void> {
    const user = this.byEmail(username);
    if (!user) throw new DomainError("not_found", `user ${username} does not exist`);
    this.store.mutate((state) => {
      delete state.users[user.sub];
      for (const [t, s] of Object.entries(state.sessions)) {
        if (s.sub === user.sub) delete state.sessions[t];
      }
    });
  }
}
