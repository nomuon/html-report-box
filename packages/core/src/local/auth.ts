/**
 * Dev AuthVerifier — `x-dev-user: alice|bob|admin` header selects the user.
 * Local-only module.
 */
import type { AuthConfig } from "@hrb/shared";
import type { AuthUser, AuthVerifier } from "../ports.ts";

export const DEV_USERS: Record<string, AuthUser> = {
  alice: { sub: "dev-alice", name: "Alice", isAdmin: false },
  bob: { sub: "dev-bob", name: "Bob", isAdmin: false },
  admin: { sub: "dev-admin", name: "Admin", isAdmin: true },
};

export const DEV_USER_HEADER = "x-dev-user";

export function getDevUser(name: string): AuthUser {
  const user = DEV_USERS[name];
  if (!user) throw new Error(`unknown dev user: ${name}`);
  return { ...user };
}

export class DevAuthVerifier implements AuthVerifier {
  async verify(headers: Record<string, string | undefined>): Promise<AuthUser | null> {
    const name = headers[DEV_USER_HEADER];
    if (!name) return null;
    const user = DEV_USERS[name.toLowerCase()];
    return user ? { ...user } : null;
  }

  authConfig(): AuthConfig {
    return { mode: "dev", users: Object.keys(DEV_USERS) };
  }
}
