/**
 * @hrb/web — application shell: providers + routes (DESIGN.md §2.1).
 */
import { BrowserRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppProvider } from "./app-context.tsx";
import { Header } from "./components/Header.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { Icon } from "./components/Icon.tsx";
import { AdminPage } from "./pages/AdminPage.tsx";
import { ListPage } from "./pages/ListPage.tsx";
import { MinePage } from "./pages/MinePage.tsx";
import { ReportDetailPage } from "./pages/ReportDetailPage.tsx";
import { UploadPage } from "./pages/UploadPage.tsx";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

function Shell() {
  return (
    <>
      <Header />
      <main className="hrb-main">
        <Routes>
          <Route path="/" element={<ListPage />} />
          <Route path="/search" element={<ListPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/reports/:id" element={<ReportDetailPage />} />
          <Route path="/mine" element={<MinePage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route
            path="*"
            element={<EmptyState icon={<Icon name="ban" size={30} />} title="ページが見つかりません" />}
          />
        </Routes>
      </main>
    </>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AppProvider>
          <BrowserRouter>
            <Shell />
          </BrowserRouter>
        </AppProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
