import { describe, expect, test } from "bun:test";
import { DEV_USER_HEADER, DEV_USER_STORAGE_KEY, DevAuthProvider, createAuthProvider } from "./auth.ts";
import type { StorageLike } from "./auth.ts";

function memStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const USERS = ["alice", "bob", "admin"];

describe("DevAuthProvider", () => {
  test("defaults to the first dev user and sends x-dev-user", () => {
    const auth = new DevAuthProvider(USERS, memStorage());
    expect(auth.getSession()).toEqual({ name: "alice", isAdmin: false });
    expect(auth.getHeaders()).toEqual({ [DEV_USER_HEADER]: "alice" });
  });

  test("restores a persisted selection; ignores unknown stored users", () => {
    const auth = new DevAuthProvider(USERS, memStorage({ [DEV_USER_STORAGE_KEY]: "bob" }));
    expect(auth.getSession()?.name).toBe("bob");
    const auth2 = new DevAuthProvider(USERS, memStorage({ [DEV_USER_STORAGE_KEY]: "mallory" }));
    expect(auth2.getSession()?.name).toBe("alice");
  });

  test("admin user gets isAdmin=true", () => {
    const auth = new DevAuthProvider(USERS, memStorage());
    auth.setUser("admin");
    expect(auth.getSession()).toEqual({ name: "admin", isAdmin: true });
  });

  test("setUser persists, rejects unknown users, notifies subscribers", () => {
    const storage = memStorage();
    const auth = new DevAuthProvider(USERS, storage);
    let notified = 0;
    const unsub = auth.subscribe(() => notified++);
    auth.setUser("bob");
    expect(storage.getItem(DEV_USER_STORAGE_KEY)).toBe("bob");
    expect(notified).toBe(1);
    auth.setUser("mallory");
    expect(auth.getSession()?.name).toBe("bob");
    expect(notified).toBe(1);
    unsub();
    auth.setUser("alice");
    expect(notified).toBe(1);
  });

  test("logout clears the session and headers; login restores the default", () => {
    const auth = new DevAuthProvider(USERS, memStorage());
    auth.logout();
    expect(auth.getSession()).toBeNull();
    expect(auth.getHeaders()).toEqual({});
    auth.login();
    expect(auth.getSession()?.name).toBe("alice");
  });
});

describe("createAuthProvider", () => {
  test("dev config yields a DevAuthProvider", () => {
    const auth = createAuthProvider({ mode: "dev", users: USERS }, memStorage());
    expect(auth.mode).toBe("dev");
    expect(auth).toBeInstanceOf(DevAuthProvider);
  });

  test("cognito login is an explicit TODO (throws)", () => {
    const auth = createAuthProvider({
      mode: "cognito",
      region: "ap-northeast-1",
      userPoolId: "pool",
      clientId: "client",
      domain: "https://x.auth.example.com",
    });
    expect(auth.mode).toBe("cognito");
    expect(auth.getSession()).toBeNull();
    expect(() => auth.login()).toThrow();
  });
});
