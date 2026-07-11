import { describe, expect, test } from "bun:test";
import {
  DEV_USER_HEADER,
  DEV_USER_STORAGE_KEY,
  DevAuthProvider,
  GOOGLE_SESSION_STORAGE_KEY,
  GoogleAuthProvider,
  createAuthProvider,
} from "./auth.ts";
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

  test("getSession is referentially stable until the user changes (useSyncExternalStore snapshot)", () => {
    const auth = new DevAuthProvider(USERS, memStorage());
    const first = auth.getSession();
    expect(auth.getSession()).toBe(first);
    auth.setUser("bob");
    const second = auth.getSession();
    expect(second).not.toBe(first);
    expect(auth.getSession()).toBe(second);
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

const CAROL = {
  sub: "google-carol",
  name: "Carol",
  email: "carol@example.com",
  picture: "https://lh3.example/carol.png",
  isAdmin: false,
};

function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return handler(url, init);
  };
  return { fetchFn, calls };
}

describe("GoogleAuthProvider", () => {
  test("signInWithCredential exchanges the credential and stores the session", async () => {
    const storage = memStorage();
    const { fetchFn, calls } = fakeFetch(() =>
      Response.json({ token: "sess-token", user: CAROL }),
    );
    const auth = new GoogleAuthProvider("client-id", { storage, fetchFn });
    expect(auth.getSession()).toBeNull();

    let notified = 0;
    auth.subscribe(() => notified++);
    await auth.signInWithCredential("gis-credential");

    expect(calls[0]?.url).toBe("/api/auth/google");
    expect(auth.getSession()).toEqual({
      name: "Carol",
      isAdmin: false,
      email: "carol@example.com",
      picture: "https://lh3.example/carol.png",
    });
    expect(auth.getHeaders()).toEqual({ authorization: "Bearer sess-token" });
    expect(notified).toBe(1);
    expect(storage.getItem(GOOGLE_SESSION_STORAGE_KEY)).toContain("sess-token");
  });

  test("surfaces the API error message on a rejected credential", async () => {
    const { fetchFn } = fakeFetch(() =>
      Response.json(
        { error: { code: "unauthorized", message: "Google ID token verification failed" } },
        { status: 401 },
      ),
    );
    const auth = new GoogleAuthProvider("client-id", { storage: memStorage(), fetchFn });
    await expect(auth.signInWithCredential("forged")).rejects.toThrow(
      "Google ID token verification failed",
    );
    expect(auth.getSession()).toBeNull();
  });

  test("restores a persisted session; corrupt storage is treated as logged out", () => {
    const stored = JSON.stringify({ token: "sess-token", user: CAROL });
    const auth = new GoogleAuthProvider("client-id", {
      storage: memStorage({ [GOOGLE_SESSION_STORAGE_KEY]: stored }),
      fetchFn: fakeFetch(() => Response.json({})).fetchFn,
    });
    expect(auth.getSession()?.email).toBe("carol@example.com");

    const corruptStorage = memStorage({ [GOOGLE_SESSION_STORAGE_KEY]: "{not json" });
    const auth2 = new GoogleAuthProvider("client-id", {
      storage: corruptStorage,
      fetchFn: fakeFetch(() => Response.json({})).fetchFn,
    });
    expect(auth2.getSession()).toBeNull();
    expect(corruptStorage.getItem(GOOGLE_SESSION_STORAGE_KEY)).toBeNull();
  });

  test("logout clears the session and revokes it server-side", async () => {
    const storage = memStorage({
      [GOOGLE_SESSION_STORAGE_KEY]: JSON.stringify({ token: "sess-token", user: CAROL }),
    });
    const { fetchFn, calls } = fakeFetch(() => Response.json({ ok: true }));
    const auth = new GoogleAuthProvider("client-id", { storage, fetchFn });
    auth.logout();
    expect(auth.getSession()).toBeNull();
    expect(auth.getHeaders()).toEqual({});
    expect(storage.getItem(GOOGLE_SESSION_STORAGE_KEY)).toBeNull();
    // fire-and-forget logout call
    await Promise.resolve();
    expect(calls[0]?.url).toBe("/api/auth/logout");
  });
});

describe("createAuthProvider", () => {
  test("dev config yields a DevAuthProvider", () => {
    const auth = createAuthProvider({ mode: "dev", users: USERS }, memStorage());
    expect(auth.mode).toBe("dev");
    expect(auth).toBeInstanceOf(DevAuthProvider);
  });

  test("google config yields a GoogleAuthProvider", () => {
    const auth = createAuthProvider({ mode: "google", clientId: "client-id" }, memStorage());
    expect(auth.mode).toBe("google");
    expect(auth).toBeInstanceOf(GoogleAuthProvider);
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
