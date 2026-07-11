/**
 * Auth abstraction.
 *  - dev    : DevAuthProvider — x-dev-user header, alice / bob / admin
 *  - google : GoogleAuthProvider — GIS "Sign in with Google" credential →
 *             POST /api/auth/google → opaque Bearer session token
 *  - cognito: Hosted UI code+PKCE — interface is cut here, TODO (deploy later)
 *
 * DOM-free core: storage/fetch are injectable so this can be unit tested under
 * bun test; only the GIS script glue touches the DOM (guarded).
 */
import type { AuthConfig, GoogleLoginResponse, SessionUser } from "@hrb/shared";

/** Header consumed by the dev AuthVerifier in @hrb/core/local. */
export const DEV_USER_HEADER = "x-dev-user";
export const DEV_USER_STORAGE_KEY = "hrb-dev-user";
export const GOOGLE_SESSION_STORAGE_KEY = "hrb-google-session";

export interface AuthSession {
  /** Display name / dev user id. */
  name: string;
  isAdmin: boolean;
  /** Google mode only. */
  email?: string;
  picture?: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AuthProvider {
  readonly mode: "dev" | "google" | "cognito";
  /**
   * Must return a referentially stable value until the session changes —
   * consumed as a useSyncExternalStore snapshot (a fresh object per call
   * would re-render infinitely).
   */
  getSession(): AuthSession | null;
  /** Headers to attach to every /api request. */
  getHeaders(): Record<string, string>;
  login(): void | Promise<void>;
  logout(): void;
  /** Notifies on session change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

abstract class BaseAuthProvider implements AuthProvider {
  abstract readonly mode: "dev" | "google" | "cognito";
  abstract getSession(): AuthSession | null;
  abstract getHeaders(): Record<string, string>;
  abstract login(): void | Promise<void>;
  abstract logout(): void;

  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected notify(): void {
    for (const l of this.listeners) l();
  }
}

const memoryStorage = (): StorageLike => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
};

/** Dev users: selection persisted, sent via x-dev-user. `admin` is the admin. */
export class DevAuthProvider extends BaseAuthProvider {
  readonly mode = "dev" as const;
  readonly users: string[];
  private readonly storage: StorageLike;
  private current: string | null;
  private session: AuthSession | null;

  constructor(users: string[], storage?: StorageLike) {
    super();
    this.users = users;
    this.storage = storage ?? (typeof localStorage !== "undefined" ? localStorage : memoryStorage());
    const stored = this.storage.getItem(DEV_USER_STORAGE_KEY);
    // Default: first dev user logged in (frictionless local dev).
    this.current = stored && users.includes(stored) ? stored : (users[0] ?? null);
    this.session = this.buildSession();
  }

  private buildSession(): AuthSession | null {
    if (!this.current) return null;
    return { name: this.current, isAdmin: this.current === "admin" };
  }

  getSession(): AuthSession | null {
    return this.session;
  }

  getHeaders(): Record<string, string> {
    return this.current ? { [DEV_USER_HEADER]: this.current } : {};
  }

  setUser(name: string | null): void {
    if (name !== null && !this.users.includes(name)) return;
    this.current = name;
    this.session = this.buildSession();
    if (name === null) this.storage.removeItem(DEV_USER_STORAGE_KEY);
    else this.storage.setItem(DEV_USER_STORAGE_KEY, name);
    this.notify();
  }

  login(): void {
    // Dev mode: "login" selects the first user.
    if (!this.current) this.setUser(this.users[0] ?? null);
  }

  logout(): void {
    this.setUser(null);
  }
}

// ---- Google Identity Services (GIS) glue ----

/** Subset of google.accounts.id we consume. */
export interface GisIdApi {
  initialize(config: {
    client_id: string;
    callback: (response: { credential: string }) => void;
  }): void;
  renderButton(el: HTMLElement, options: Record<string, unknown>): void;
  prompt(): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GisIdApi } };
  }
}

const GIS_SRC = "https://accounts.google.com/gsi/client";
let gisLoading: Promise<GisIdApi> | null = null;

function loadGis(): Promise<GisIdApi> {
  if (typeof document === "undefined") {
    return Promise.reject(new Error("GIS requires a DOM"));
  }
  gisLoading ??= new Promise<GisIdApi>((resolve, reject) => {
    const existing = window.google?.accounts?.id;
    if (existing) {
      resolve(existing);
      return;
    }
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => {
      const api = window.google?.accounts?.id;
      if (api) resolve(api);
      else reject(new Error("GIS script loaded but google.accounts.id is missing"));
    };
    script.onerror = () => {
      gisLoading = null;
      reject(new Error("Google Identity Services スクリプトを読み込めませんでした"));
    };
    document.head.appendChild(script);
  });
  return gisLoading;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GoogleAuthProviderOptions {
  storage?: StorageLike;
  fetchFn?: FetchLike;
  /** API base (default "/api", same-origin). */
  baseUrl?: string;
}

interface StoredGoogleSession {
  token: string;
  user: SessionUser;
}

/**
 * Real Google login: the GIS button yields an ID token (credential), the API
 * exchanges it for an opaque session token which is sent as a Bearer header.
 * First login provisions the account server-side (signup == login).
 */
export class GoogleAuthProvider extends BaseAuthProvider {
  readonly mode = "google" as const;
  readonly clientId: string;
  private readonly storage: StorageLike;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  private stored: StoredGoogleSession | null;
  private session: AuthSession | null;
  private gisInit: Promise<GisIdApi> | null = null;
  private errorListeners = new Set<(message: string) => void>();

  constructor(clientId: string, options: GoogleAuthProviderOptions = {}) {
    super();
    this.clientId = clientId;
    this.storage =
      options.storage ?? (typeof localStorage !== "undefined" ? localStorage : memoryStorage());
    const f = options.fetchFn ?? (typeof fetch !== "undefined" ? fetch : undefined);
    if (!f) throw new Error("GoogleAuthProvider requires a fetch implementation");
    this.fetchFn = (input, init) => f(input, init);
    this.baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    this.stored = this.restore();
    this.session = this.buildSession();
  }

  private restore(): StoredGoogleSession | null {
    const raw = this.storage.getItem(GOOGLE_SESSION_STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredGoogleSession;
      if (typeof parsed?.token === "string" && typeof parsed?.user?.sub === "string") return parsed;
    } catch {
      // fall through: corrupt storage is treated as logged out
    }
    this.storage.removeItem(GOOGLE_SESSION_STORAGE_KEY);
    return null;
  }

  private buildSession(): AuthSession | null {
    if (!this.stored) return null;
    const { user } = this.stored;
    return {
      name: user.name,
      isAdmin: user.isAdmin,
      email: user.email,
      ...(user.picture ? { picture: user.picture } : {}),
    };
  }

  private setStored(next: StoredGoogleSession | null): void {
    this.stored = next;
    this.session = this.buildSession();
    if (next) this.storage.setItem(GOOGLE_SESSION_STORAGE_KEY, JSON.stringify(next));
    else this.storage.removeItem(GOOGLE_SESSION_STORAGE_KEY);
    this.notify();
  }

  getSession(): AuthSession | null {
    return this.session;
  }

  getHeaders(): Record<string, string> {
    return this.stored ? { authorization: `Bearer ${this.stored.token}` } : {};
  }

  /** Login failures (e.g. rejected credential) surface here for the login UI. */
  onLoginError(listener: (message: string) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** Exchanges a GIS credential for a session. Exposed for tests. */
  async signInWithCredential(credential: string): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    if (!res.ok) {
      let message = `ログインに失敗しました (HTTP ${res.status})`;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body?.error?.message) message = body.error.message;
      } catch {
        // keep fallback message
      }
      throw new Error(message);
    }
    const data = (await res.json()) as GoogleLoginResponse;
    this.setStored({ token: data.token, user: data.user });
  }

  private async handleCredential(credential: string): Promise<void> {
    try {
      await this.signInWithCredential(credential);
    } catch (err) {
      const message = err instanceof Error ? err.message : "ログインに失敗しました";
      for (const l of this.errorListeners) l(message);
    }
  }

  private ensureInitialized(): Promise<GisIdApi> {
    this.gisInit ??= loadGis().then((gis) => {
      // FedCM is mandatory since 2025-08; no opt-in flags needed.
      gis.initialize({
        client_id: this.clientId,
        callback: (res) => void this.handleCredential(res.credential),
      });
      return gis;
    });
    return this.gisInit;
  }

  /** Renders the official GIS button into `el` (login and signup alike). */
  async renderButton(el: HTMLElement, options?: { text?: "signin_with" | "signup_with" }): Promise<void> {
    const gis = await this.ensureInitialized();
    gis.renderButton(el, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: options?.text ?? "signin_with",
      shape: "pill",
      logo_alignment: "left",
      width: 300,
    });
  }

  login(): void {
    // One Tap prompt; the rendered button is the primary path.
    void this.ensureInitialized()
      .then((gis) => gis.prompt())
      .catch(() => {});
  }

  logout(): void {
    const token = this.stored?.token;
    if (token) {
      void this.fetchFn(`${this.baseUrl}/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    if (typeof window !== "undefined") window.google?.accounts?.id?.disableAutoSelect();
    this.setStored(null);
  }
}

/**
 * Cognito Hosted UI + code/PKCE flow. TODO(S-prod): implement
 *   - login(): generate code_verifier/challenge, redirect to /oauth2/authorize
 *   - callback: exchange code at /oauth2/token, keep tokens in memory
 *   - getHeaders(): { authorization: `Bearer <idToken>` } with refresh
 */
export class CognitoAuthProvider extends BaseAuthProvider {
  readonly mode = "cognito" as const;

  constructor(_config: Extract<AuthConfig, { mode: "cognito" }>) {
    super();
  }

  getSession(): AuthSession | null {
    return null; // TODO: decode idToken
  }

  getHeaders(): Record<string, string> {
    return {}; // TODO: bearer token
  }

  login(): void {
    throw new Error("Cognito PKCE login is not implemented yet (local mode only)");
  }

  logout(): void {
    // TODO: revoke + clear tokens
  }
}

export function createAuthProvider(config: AuthConfig, storage?: StorageLike): AuthProvider {
  if (config.mode === "dev") return new DevAuthProvider(config.users, storage);
  if (config.mode === "google") {
    return new GoogleAuthProvider(config.clientId, storage ? { storage } : {});
  }
  return new CognitoAuthProvider(config);
}
