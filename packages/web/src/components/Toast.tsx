import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";

export type ToastKind = "success" | "danger" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  push(kind: ToastKind, message: string): void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const AUTO_DISMISS_MS = 5000;
const MAX_TOASTS = 3;
const ICONS: Record<ToastKind, string> = { success: "✓", danger: "✕", info: "ℹ" };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const startTimer = useCallback(
    (id: number) => {
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS),
      );
    },
    [dismiss],
  );

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, kind, message }]);
      startTimer(id);
    },
    [startTimer],
  );

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="hrb-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`hrb-toast hrb-toast--${t.kind}`}
            onMouseEnter={() => {
              const timer = timers.current.get(t.id);
              if (timer) clearTimeout(timer);
              timers.current.delete(t.id);
            }}
            onMouseLeave={() => {
              if (!timers.current.has(t.id)) startTimer(t.id);
            }}
          >
            <span className="hrb-toast__icon" aria-hidden="true">
              {ICONS[t.kind]}
            </span>
            <span className="hrb-toast__message">{t.message}</span>
            <button type="button" className="hrb-toast__close" aria-label="閉じる" onClick={() => dismiss(t.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
