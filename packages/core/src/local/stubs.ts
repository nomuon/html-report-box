/**
 * Local stubs: no-op CDN invalidator, dev-user UserAdmin, allowlist-only
 * DomainReputation, and a pass-through SecurityScanner (replaced by
 * @hrb/scanner in S2.5). Local-only module.
 */
import type { AdminUser } from "@hrb/shared";
import type {
  CdnInvalidator,
  DomainReputation,
  Page,
  PageOptions,
  ScanInput,
  ScanResult,
  SecurityScanner,
  UserAdmin,
} from "../ports.ts";
import { DEV_USERS } from "./auth.ts";

export class NoopCdnInvalidator implements CdnInvalidator {
  /** Recorded for tests/debugging. */
  readonly invalidated: string[][] = [];

  async invalidate(paths: readonly string[]): Promise<void> {
    this.invalidated.push([...paths]);
  }
}

export class LocalUserAdmin implements UserAdmin {
  private readonly adminFlags = new Map<string, boolean>(
    Object.entries(DEV_USERS).map(([name, user]) => [name, user.isAdmin]),
  );

  async listUsers(_opts?: PageOptions): Promise<Page<AdminUser>> {
    const users: AdminUser[] = [...this.adminFlags.entries()].map(([username, isAdmin]) => ({
      username,
      name: DEV_USERS[username]?.name ?? username,
      email: `${username}@example.local`,
      isAdmin,
    }));
    return { items: users };
  }

  async setAdmin(username: string, isAdmin: boolean): Promise<void> {
    if (!this.adminFlags.has(username)) {
      throw new Error(`unknown user: ${username}`);
    }
    this.adminFlags.set(username, isAdmin);
  }
}

export class StubDomainReputation implements DomainReputation {
  private readonly malicious: Set<string>;

  constructor(maliciousHosts: readonly string[] = []) {
    this.malicious = new Set(maliciousHosts.map((h) => h.toLowerCase()));
  }

  async isMalicious(host: string): Promise<boolean> {
    return this.malicious.has(host.toLowerCase());
  }
}

/** Pass-through scanner used until @hrb/scanner (S2.5) is wired in. */
export class PassthroughScanner implements SecurityScanner {
  async scan(_input: ScanInput): Promise<ScanResult> {
    return { verdict: "pass", findings: [] };
  }
}
