/**
 * Auth abstraction. Local mode uses DevAuthProvider (x-dev-user header,
 * alice / bob / admin). Production uses Cognito code+PKCE — interface is cut
 * here, implementation is TODO (deploy comes later).
 *
 * DOM-free: storage is injectable so this can be unit tested under bun test.
 */
import type { AuthConfig } from "@hrb/shared";

/** Header consumed by the dev AuthVerifier in @hrb/core/local. */
export const DEV_USER_HEADER = "x-dev-user";
export const DEV_USER_STORAGE_KEY = "hrb-dev-user";

export interface AuthSession {
  /** Display name / dev user id. */
  name: string;
  isAdmin: boolean;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AuthProvider {
  readonly mode: "dev" | "cognito";
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
  abstract readonly mode: "dev" | "cognito";
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
  return new CognitoAuthProvider(config);
}
