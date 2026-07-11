import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icon.tsx";

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** destructive 確認中はオーバーレイクリックで閉じない */
  closeOnOverlay?: boolean;
  /** エディタなど広い作業領域が必要なモーダル */
  wide?: boolean;
}

export function Modal({ open, title, onClose, children, footer, closeOnOverlay = true, wide = false }: ModalProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // 呼び出し側は毎レンダー新しいクロージャを渡してくる。依存配列に入れると
  // 入力のたびにエフェクトが再実行されフォーカスが奪われるため ref で保持する。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    // 簡易フォーカストラップ: 開時に最初のフォーカス可能要素へ
    const el = bodyRef.current?.querySelector<HTMLElement>(
      "input, textarea, select, button, [tabindex]",
    );
    el?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="hrb-modal-overlay"
      onMouseDown={(e) => {
        if (closeOnOverlay && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`hrb-modal ${wide ? "hrb-modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={bodyRef}
      >
        <div className="hrb-modal__header">
          <h2 className="hrb-modal__title">{title}</h2>
          <button type="button" className="hrb-icon-btn hrb-modal__close" aria-label="閉じる" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="hrb-modal__body">{children}</div>
        {footer && <div className="hrb-modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
