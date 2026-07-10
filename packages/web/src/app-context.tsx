/**
 * App-wide context: config (GET /api/config), auth provider, API client.
 */
import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GetConfigResponse } from "@hrb/shared";
import { ApiClient } from "./lib/api.ts";
import { createAuthProvider } from "./lib/auth.ts";
import type { AuthProvider, AuthSession } from "./lib/auth.ts";

export interface AppContextValue {
  api: ApiClient;
  auth: AuthProvider;
  config: GetConfigResponse;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}

export function useSession(): AuthSession | null {
  const { auth } = useApp();
  return useSyncExternalStore(
    (cb) => auth.subscribe(cb),
    () => auth.getSession(),
    () => auth.getSession(),
  );
}

const bootstrapClient = new ApiClient();

export function AppProvider({ children }: { children: ReactNode }) {
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => bootstrapClient.getConfig(),
    staleTime: Infinity,
    retry: 1,
  });

  const value = useMemo<AppContextValue | null>(() => {
    if (!configQuery.data) return null;
    const auth = createAuthProvider(configQuery.data.auth);
    const api = new ApiClient({ getHeaders: () => auth.getHeaders() });
    return { api, auth, config: configQuery.data };
  }, [configQuery.data]);

  if (configQuery.isError) {
    return (
      <div className="hrb-boot-error">
        <p>サーバーに接続できませんでした。</p>
        <button className="hrb-btn hrb-btn--secondary" onClick={() => configQuery.refetch()}>
          再試行
        </button>
      </div>
    );
  }
  if (!value) return <div className="hrb-boot-loading">読み込み中…</div>;
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
